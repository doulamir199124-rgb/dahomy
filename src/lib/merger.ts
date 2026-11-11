/**
 * عميل خدمة دمج الفيديو — Video Merger API v2 (قسم 7).
 * بلا مفاتيح ولا توثيق؛ القيود: ≤10 مقاطع، ≤200MB لكل مصدر، ≤150MB للناتج، ≤600s مجموع المدد.
 * كل الملفات تُحذف من الخدمة بعد 24 ساعة (expiresAt).
 * القاعدة الحتمية: أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري؛
 * أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة → نستمر بالاستعلام حتى انتهاء النافذة.
 */
import {
  insertTask,
  updateTask,
  getTask,
  listRecentTasks,
  safeParse,
  type TaskRow,
} from "@/lib/turso";
import { truncate } from "@/lib/errors";
import { fetchWithTimeout } from "@/lib/providers/types";
import type { ToolOutcome, ProgressEvent } from "@/lib/generator";
import { formatCompleted, formatProcessing, formatFailed } from "@/lib/generator";

export const MERGER_BASE = (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");

export function mergerConfigured(): boolean {
  return /^https?:\/\/.+/i.test(MERGER_BASE);
}

const POLL_INTERVAL_MS = 3000;
const RESUME_WAIT_MS = 15000;

/** قفل في الذاكرة يمنع تنفيذ process مرتين للمهمة نفسها (تزامن get_task) */
const g = globalThis as unknown as { __mergeProcessInFlight?: Set<string> };
const processInFlight: Set<string> = (g.__mergeProcessInFlight ??= new Set());

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ————————————————————————— التحقق من المدخلات —————————————————————————

function isPublicHttpUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) return false;
    const h = url.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1|\[::1\])/.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}

export interface MergeInput {
  urls?: string[];
  taskIds?: string[];
  waitSeconds: number;
  onProgress?: (event: ProgressEvent) => Promise<void> | void;
}

export interface MergePlan {
  videos: string[];
  rejected?: ToolOutcome;
}

/** جمع روابط task_ids أولًا ثم urls المباشرة بنفس ترتيبها (مع رسائل عربية دقيقة) */
export async function planMerge(input: MergeInput): Promise<MergePlan> {
  const videos: string[] = [];
  const failedIds: Array<{ id: string; reason: string }> = [];

  // 1) روابط مهام الفيديو المكتملة من قاعدة البيانات — بالترتيب أُولًا
  for (const id of input.taskIds ?? []) {
    const t = await getTask(String(id).trim());
    const urls = t ? safeParse<string[]>(t.result_urls_json, []) : [];
    if (!t || t.type !== "video" || t.status !== "completed" || urls.length === 0) {
      failedIds.push({
        id: String(id),
        reason: !t
          ? "معرّف غير موجود"
          : t.type !== "video"
            ? "ليست مهمة فيديو"
            : t.status !== "completed"
              ? `حالتها ${t.status === "failed" ? "فاشلة" : "غير مكتملة بعد"}`
              : "بلا روابط نتائج",
      });
      continue;
    }
    videos.push(urls[0]);
  }

  // 2) الروابط المباشرة بنفس ترتيبها
  for (const u of input.urls ?? []) {
    videos.push(String(u).trim());
  }

  if (videos.length === 0 && failedIds.length > 0) {
    return {
      videos: [],
      rejected: {
        kind: "failed",
        isError: true,
        text:
          `❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.\n\n` +
          failedIds.map((f) => `- ${f.id}: ${f.reason}`).join("\n"),
      },
    };
  }
  if (videos.length < 2) {
    const detail = failedIds.length
      ? "\n\nمعرّفات فشل حلّها:\n" + failedIds.map((f) => `- ${f.id}: ${f.reason}`).join("\n")
      : "";
    return {
      videos: [],
      rejected: {
        kind: "failed",
        isError: true,
        text: `❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.${detail}`,
      },
    };
  }
  if (videos.length > 10) {
    return {
      videos: [],
      rejected: {
        kind: "failed",
        isError: true,
        text: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).",
      },
    };
  }
  const bad = videos.filter((u) => !isPublicHttpUrl(u));
  if (bad.length > 0) {
    return {
      videos: [],
      rejected: {
        kind: "failed",
        isError: true,
        text:
          "❌ كل الروابط يجب أن تكون روابط فيديو مباشرة عامة (http/https) — روابط غير صالحة:\n" +
          bad.map((u) => `- ${truncate(u, 120)}`).join("\n"),
      },
    };
  }
  return { videos };
}

// ————————————————————————— تحليل حالة الخدمة (دفاعي) —————————————————————————

const DONE_STATES = /done|completed|complete|success|succeeded|finished/i;
const FAILED_STATES = /error|failed|failure|cancelled|canceled/i;

function normalizeProgress(p: unknown): number | undefined {
  const n = Number(p);
  if (!isFinite(n)) return undefined;
  // progress يأتي أحيانًا كسرًا 0..1 → نضربه في 100
  return n <= 1 ? Math.round(n * 100) : Math.min(100, Math.round(n));
}

function resultUrlFrom(body: Record<string, unknown>, jobId: string): string {
  // فضّل videoUrl ثم downloadUrl، وإن غابا فاضبط رابط البث المباشر
  if (typeof body.videoUrl === "string" && body.videoUrl) return body.videoUrl;
  if (typeof body.downloadUrl === "string" && body.downloadUrl) return body.downloadUrl;
  return `${MERGER_BASE}/api/jobs/${jobId}/video`;
}

async function mergerFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = 30000
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${MERGER_BASE}${path}`, {
      ...init,
      headers: { Accept: "application/json", ...(init?.headers || {}) },
    }, timeoutMs);
  } catch {
    // خطأ شبكتنا = مؤقت — يُميَّز بحالة fetchFailed
    return { ok: false, status: 0, body: null };
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

// ————————————————————————— تنفيذ process (مرة واحدة فقط) —————————————————————————

async function fireProcessOnce(jobId: string): Promise<void> {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  // نطلقها دون انتظار اكتمالها — الاستطلاع يجري بالتوازي (10-15 ثانية blocking لدى الخدمة)
  void (async () => {
    try {
      await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" }, 120000);
    } catch {
      // يُلتقط أثناء الاستطلاع
    } finally {
      processInFlight.delete(jobId);
    }
  })();
}

// ————————————————————————— التحليل الموحد لحالة مهمة الدمج —————————————————————————

async function pollMergeJob(
  task: TaskRow,
  onProgress?: (event: ProgressEvent) => Promise<void> | void
): Promise<{ outcome: "completed" | "processing" | "failed-final" | "fetch-failed"; url?: string; error?: string }> {
  const jobId = task.provider_task_id!;
  const { ok, status, body } = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`);

  // 404 = المهمة غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة) → فشل نهائي
  if (status === 404) {
    const msg = "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)";
    await updateTask(task.id, { status: "failed", error_message: msg });
    return { outcome: "failed-final", error: msg };
  }

  // أي خطأ HTTP معلن (4xx/5xx بجسم error) = فشل نهائي فوري — لا إعادة محاولة
  if (status === 0) return { outcome: "fetch-failed" }; // خطأ شبكتنا = مؤقت
  if (!ok) {
    const msg = (body?.error as string) || `HTTP ${status} من خدمة الدمج`;
    await updateTask(task.id, { status: "failed", error_message: truncate(msg, 500) });
    return { outcome: "failed-final", error: msg };
  }

  const b = body || {};
  // قد يرد الجسم فيه error بدون حقل status → عاملها failed فورًا
  const rawStatus = typeof b.status === "string" ? b.status : b.error ? "failed" : "processing";
  const progress = normalizeProgress(b.progress);

  if (DONE_STATES.test(rawStatus)) {
    const url = resultUrlFrom(b, jobId);
    await updateTask(task.id, {
      status: "completed",
      progress: 100,
      result_urls: [url],
      error_message: null,
    });
    return { outcome: "completed", url };
  }
  if (FAILED_STATES.test(rawStatus)) {
    const msg = (b.error as string) || `فشل الدمج لدى الخدمة (${rawStatus})`;
    await updateTask(task.id, { status: "failed", error_message: truncate(msg, 500) });
    return { outcome: "failed-final", error: msg };
  }

  // قيد المعالجة → حدّث التقدم فورًا في Turso
  const pct = progress !== undefined ? Math.min(90, progress) : Math.min(80, (task.progress || 0) + 8);
  await updateTask(task.id, { progress: pct });
  if (onProgress) {
    try {
      await onProgress({ progress: pct, total: 100, message: `قيد الدمج… ${pct}%` });
    } catch {
      /* تجاهل */
    }
  }
  return { outcome: "processing" };
}

// ————————————————————————— تدفق runMerge —————————————————————————

/** التدفق الكامل لأداة merge_videos (قسم 7.3) */
export async function runMerge(input: MergeInput): Promise<ToolOutcome> {
  // 1) تحقق صارم من المدخلات برسائل عربية
  const plan = await planMerge(input);
  if (plan.rejected) return plan.rejected;

  // خدمة الدمج غير مهيأة → رسالة عربية واضحة
  if (!mergerConfigured()) {
    return {
      kind: "failed",
      isError: true,
      text:
        "❌ خدمة الدمج غير مهيأة على هذا السيرفر — أضف عنوانها في متغير البيئة MERGER_API_BASE ثم أعد المحاولة.",
    };
  }

  // 2) سجّل مهمة الدمج في Turso أولًا
  const taskId = crypto.randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${plan.videos.length} مقاطع`,
    paramsJson: JSON.stringify({ videos: plan.videos, waitSeconds: input.waitSeconds }),
  });

  // 3) أنشئ job لدى الخدمة ثم أطلق process خلفيًا وبمرة واحدة فقط
  const create = await mergerFetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: plan.videos }),
  });

  if (create.status === 0) {
    // خطأ شبكتنا = مؤقت → المهمة تبقى processing وتُعاد مع get_task (refetch يعيد الإنشاء)
    return formatProcessing((await getTask(taskId))!);
  }
  if (!create.ok || !create.body?.jobId) {
    // خطأ معلن من الخدمة عند الإنشاء = فشل نهائي
    const msg = (create.body?.error as string) || `HTTP ${create.status} عند إنشاء مهمة الدمج`;
    await updateTask(taskId, { status: "failed", error_message: truncate(msg, 500) });
    return formatFailed(msg, await getTask(taskId) ?? undefined);
  }

  const jobId = String(create.body.jobId);
  await updateTask(taskId, {
    provider_task_id: jobId,
    status: "processing",
    progress: 5,
    params_json_set: JSON.stringify({ videos: plan.videos, waitSeconds: input.waitSeconds, processFired: true }),
  });
  await fireProcessOnce(jobId);

  // 4) نافذة الانتظار الافتراضية 60 ثانية: استعلام كل 3 ثوانٍ مع بث تقدم
  const waitMs = Math.max(0, Math.min(240, input.waitSeconds ?? 60)) * 1000;
  if (waitMs === 0) return formatProcessing((await getTask(taskId))!);
  const deadline = Date.now() + waitMs;
  let task = (await getTask(taskId))!;

  while (Date.now() < deadline) {
    task = (await getTask(taskId))!;
    const r = await pollMergeJob(task, input.onProgress);
    if (r.outcome === "completed" && r.url) {
      return formatCompleted("merge", [r.url], (await getTask(taskId))!);
    }
    if (r.outcome === "failed-final") {
      return formatFailed(r.error || "فشل الدمج", (await getTask(taskId)) ?? undefined);
    }
    await wait(POLL_INTERVAL_MS);
  }

  // 5) انتهت النافذة → processing والعميل يتابع بـ get_task
  return formatProcessing((await getTask(taskId))!);
}

/** refreshMergeTask (قسم 7.3.6) — تحديث حي من الخدمة عند get_task */
export async function refreshMergeTask(t: TaskRow): Promise<ToolOutcome> {
  if (!mergerConfigured()) {
    return formatFailed("خدمة الدمج غير مهيأة على هذا السيرفر (MERGER_API_BASE مفقود).", t);
  }

  // مكتملة → صياغة مباشرة مع تحذير 24 ساعة
  if (t.status === "completed") {
    const urls = safeParse<string[]>(t.result_urls_json, []);
    if (urls.length > 0) return formatCompleted("merge", urls, t);
  }
  if (t.status === "failed") {
    return formatFailed(t.error_message || "فشل الدمج", t);
  }

  // جارية بلا jobId (خطأ شبكة عند الإنشاء سابقًا) → أعِد الإنشاء الآن
  if (!t.provider_task_id) {
    const params = safeParse<{ videos?: string[] }>(t.params_json, {});
    if (!params.videos || params.videos.length < 2) {
      await updateTask(t.id, { status: "failed", error_message: "معطيات الدمج مفقودة من قاعدة البيانات" });
      return formatFailed("معطيات الدمج مفقودة", t);
    }
    const create = await mergerFetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: params.videos }),
    });
    if (create.status === 0) return formatProcessing(t);
    if (!create.ok || !create.body?.jobId) {
      const msg = (create.body?.error as string) || `HTTP ${create.status} عند إنشاء مهمة الدمج`;
      await updateTask(t.id, { status: "failed", error_message: truncate(msg, 500) });
      return formatFailed(msg, t);
    }
    const jobId = String(create.body.jobId);
    await updateTask(t.id, { provider_task_id: jobId, progress: 5 });
    await fireProcessOnce(jobId);
    t = (await getTask(t.id)) ?? t;
  }

  // نفّذ process الآن إن لم يُنفَّذ بعد (مثلاً بعد انقطاع الطلب الأول) — علم دائم في params_json
  const fired = safeParse<{ processFired?: boolean }>(t.params_json, {});
  if (!fired.processFired) {
    await fireProcessOnce(t.provider_task_id!);
    await updateTask(t.id, {
      params_json_set: JSON.stringify({ ...fired, processFired: true }),
    });
  }

  // استطلاع قصير (15 ثانية) حتى لا تتعطل get_task
  const deadline = Date.now() + RESUME_WAIT_MS;
  while (Date.now() < deadline) {
    const fresh = (await getTask(t.id)) ?? t;
    const r = await pollMergeJob(fresh);
    if (r.outcome === "completed" && r.url) {
      return formatCompleted("merge", [r.url], (await getTask(t.id))!);
    }
    if (r.outcome === "failed-final") {
      return formatFailed(r.error || "فشل الدمج", (await getTask(t.id)) ?? undefined);
    }
    await wait(POLL_INTERVAL_MS);
  }
  return formatProcessing((await getTask(t.id)) ?? t);
}

/** أحدث مهام الوسائط المخزنة (أداة list_media) */
export async function listMedia(
  filters?: { type?: "image" | "video" | "merge"; status?: "completed" | "failed" | "processing" },
  limit = 10
): Promise<ToolOutcome> {
  const tasks = await listRecentTasks(limit, filters);
  if (tasks.length === 0) {
    return { kind: "message", isError: false, text: "لا توجد وسائط مخزنة بعد — ابدأ بـ generate_image أو generate_video." };
  }
  const typeLabel: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
  const statusLabel: Record<string, string> = {
    completed: "مكتملة",
    processing: "جارية",
    failed: "فاشلة",
    pending: "بالانتظار",
  };
  const lines = tasks.map((t, i) => {
    const urls = safeParse<string[]>(t.result_urls_json, []);
    const when = t.created_at.replace("T", " ").slice(0, 16);
    let line = `${i + 1}) ${typeLabel[t.type]} | ${statusLabel[t.status]} | ${t.model} | ${when}`;
    if (urls.length > 0) line += `\n   الرابط: ${urls[0]}` + (urls.length > 1 ? ` (+${urls.length - 1})` : "");
    else line += `\n   task_id: ${t.id}`;
    return line;
  });
  return {
    kind: "message",
    isError: false,
    text: `أحدث الوسائط المخزنة (${tasks.length}):\n\n${lines.join("\n\n")}`,
  };
}
