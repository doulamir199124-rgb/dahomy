/**
 * منسق التوليد runGeneration (قسم 6) — قلب منطق التبديل التسلسلي «لا توقف أبدًا»:
 * 1) توحيد اسم الموديل 2) المسبح التسلسلي 3) تسجيل المهمة قبل أي نداء خارجي
 * 4) تجربة المرشحين بالترتيب 5) بث تقدم خلال نافذة الانتظار
 * 6) فشل مفتاح/رصيد منتصف المهمة → إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي
 * 7) فشل على كل المفاتيح → تبقى processing وتُعاد مع كل get_task (تهدئة 45 ثانية)
 */
import {
  insertTask,
  getTask,
  updateTask,
  safeParse,
  tursoDateToMs,
  type TaskRow,
} from "@/lib/turso";
import { resolveModel, type ModelDef } from "@/lib/models";
import { PROVIDERS, toProviderError, type ProviderError, type TaskInput, type CheckResult } from "@/lib/providers";
import { sequentialKeyPool, recordAttempt, buildAttemptRecord, keyForPolling, classifyMidTaskFailure } from "@/lib/keys";
import { truncate } from "@/lib/errors";

export interface ToolOutcome {
  kind: "completed" | "processing" | "failed" | "message";
  text: string;
  isError: boolean;
  task?: TaskRow;
}

export interface ProgressEvent {
  progress: number;
  total: number;
  message: string;
}

export interface GenerationOptions {
  type: "image" | "video";
  modelInput?: string;
  prompt: string;
  input: TaskInput;
  waitSeconds: number;
  defaultWait: number;
  /** بث تقدم أثناء نافذة الانتظار (إن زوّد العميل progressToken) */
  onProgress?: (event: ProgressEvent) => Promise<void> | void;
}

const POLL_INTERVAL_MS = 3000; // استعلام كل 3 ثوانٍ أثناء نافذة الانتظار
const RESUME_COOLDOWN_MS = 45000; // تهدئة إعادة المحاولة على get_task
const RESUME_WAIT_MS = 15000; // نافذة انتظار قصيرة عند الاستئناف من get_task

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ————————————————————————— الصياغة العربية للردود —————————————————————————

function fmtCompleted(type: "image" | "video" | "merge", urls: string[], task: TaskRow): ToolOutcome {
  const urlLines = urls.map((u) => `- ${u}`).join("\n");
  if (type === "image") {
    const head = `✅ تم توليد الصورة بنجاح\n\n![image](${urls[0]})\n\nالرابط المباشر: ${urls[0]}`;
    return { kind: "completed", isError: false, text: urls.length > 1 ? `${head}\n\nروابط إضافية:\n${urlLines}` : head, task };
  }
  const head =
    type === "merge"
      ? `✅ تم دمج المقاطع بنجاح\n\nالرابط المباشر: ${urls[0]}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`
      : `✅ تم توليد الفيديو بنجاح\n\nالرابط المباشر: ${urls[0]}`;
  return { kind: "completed", isError: false, text: urls.length > 1 ? `${head}\n\nروابط إضافية:\n${urlLines}` : head, task };
}

function fmtProcessing(task: TaskRow): ToolOutcome {
  return {
    kind: "processing",
    isError: false,
    text: `⏳ المهمة قيد المعالجة — task_id: ${task.id}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
    task,
  };
}

function fmtFailed(reason: string, task?: TaskRow): ToolOutcome {
  return {
    kind: "failed",
    isError: true,
    text: `❌ فشلت المهمة: ${reason}`,
    task,
  };
}

// ————————————————————————— حساب التقدم —————————————————————————

function estimatedProgress(state: "processing", elapsedMs: number, type: "image" | "video"): number {
  const perSec = type === "image" ? 2.2 : 0.9; // الصور أسرع من الفيديو
  return Math.min(95, 30 + Math.round((elapsedMs / 1000) * perSec));
}

// ————————————————————————— الاستئناف المشترك —————————————————————————

interface CandidateAttemptResult {
  provider?: string;
  providerTaskId?: string;
  keyId?: string;
  urls?: string[]; // للصور المتزامنة
  allFailedWaitingKeys?: boolean; // نفدت كل المرشحين
  failed?: { reason: string }; // فشل معطيات حتمي
}

/**
 * تجربة كل المرشحين بالترتيب لإنشاء المهمة على مزود ما.
 * تُسجَّل كل محاولة في attempts_json وتُحدَّث عدادات المفاتيح.
 */
async function tryCreateOnCandidates(
  task: TaskRow,
  def: ModelDef,
  input: TaskInput
): Promise<CandidateAttemptResult> {
  // المسبح يُجلب جديدًا في كل استدعاء: المفاتيح المعلّمة disabled تختفي تلقائيًا
  const pool = await sequentialKeyPool(def.providers);
  if (pool.length === 0) return { allFailedWaitingKeys: true };

  for (let i = 0; i < pool.length; i++) {
    const key = pool[i];
    const adapter = PROVIDERS[key.provider];
    if (!adapter) continue;
    const providerModel = def.providerModel[key.provider];

    try {
      // الصور المتزامنة لدى CometAPI تعيد الروابط فورًا
      if (def.type === "image" && adapter.createImageSync) {
        const { urls } = await adapter.createImageSync(key.api_key, providerModel, input);
        await recordAttempt(key, true);
        await updateTask(task.id, {
          attempt: buildAttemptRecord(key, true, null),
          provider: key.provider,
          key_id: key.id,
          status: "completed",
          progress: 100,
          result_urls: urls,
        });
        return { urls, provider: key.provider, keyId: key.id };
      }

      const { providerTaskId } = await adapter.createTask(key.api_key, providerModel, input);
      await recordAttempt(key, true);
      await updateTask(task.id, {
        attempt: buildAttemptRecord(key, true, null),
        provider: key.provider,
        provider_task_id: providerTaskId,
        key_id: key.id,
        status: "processing",
        error_message: null,
      });
      return { provider: key.provider, providerTaskId, keyId: key.id };
    } catch (e) {
      const err = toProviderError(e);
      const classified = await recordAttempt(key, false, err);
      await updateTask(task.id, {
        attempt: buildAttemptRecord(key, false, classified, err),
      });

      // خطأ معطيات = توقف فورًا: تبديل المفاتيح لن يحل خطأ معطيات
      if (classified?.cls === "params") {
        return {
          failed: { reason: "المزود رفض معطيات الطلب (تحقق من الوصف والخيارات) — " + truncate(err.message, 180) },
        };
      }

      // disabled / exhausted / provider / temporary → انتقل للمفتاح التالي بصمت
      continue;
    }
  }

  // فشل الإنشاء على كل المفاتيح → المهمة تبقى processing (قسم 4.3.3)
  await updateTask(task.id, {
    status: "processing",
    error_message: "بانتظار توفر مفتاح صالح… (سيعاد المحاولة تلقائيًا)",
  });
  return { allFailedWaitingKeys: true };
}

// ————————————————————————— نافذة الانتظار —————————————————————————

interface WaitResult {
  outcome: "completed" | "processing" | "resume-next";
  urls?: string[];
  failedReason?: string;
}

/** استطلاع المزود حتى نهاية نافذة الانتظار مع بث التقدم */
async function waitForCompletion(
  task: TaskRow,
  def: ModelDef,
  waitMs: number,
  onProgress?: (event: ProgressEvent) => Promise<void> | void,
  startedAtMs?: number
): Promise<WaitResult> {
  const deadline = Date.now() + waitMs;
  const createdAt = startedAtMs ?? Date.now();
  let lastSentProgress = -1;

  while (Date.now() < deadline) {
    const t = (await getTask(task.id)) ?? task;
    if (!t.provider_task_id || !t.provider || !t.key_id) {
      // فقدنا رابط المزود (لا ينبغي أن يحدث) → استئناف عبر المرشحين
      return { outcome: "resume-next" };
    }
    const key = await keyForPolling(t.key_id);
    if (!key) return { outcome: "resume-next" };

    const adapter = PROVIDERS[key.provider];
    if (!adapter) return { outcome: "resume-next" };

    let check: CheckResult;
    try {
      check = await adapter.checkTask(key.api_key, t.provider_task_id);
    } catch {
      // أخطاء الشبكة/المهلة أثناء الاستطلاع = مؤقتة → نستمر بالاستعلام حتى انتهاء النافذة
      await wait(POLL_INTERVAL_MS);
      continue;
    }

    if (check.status === "completed" && check.urls?.length) {
      await updateTask(task.id, {
        status: "completed",
        progress: 100,
        result_urls: check.urls,
        error_message: null,
      });
      return { outcome: "completed", urls: check.urls };
    }

    if (check.status === "failed") {
      const reason = check.error || "فشل التوليد لدى المزود";
      const { isKeyIssue, exhausted } = classifyMidTaskFailure(reason);
      if (isKeyIssue) {
        // علّم المفتاح ثم أعد إنشاء نفس المهمة بنفس task_id على المفتاح التالي (قسم 4.3.2)
        const poolKey = await keyForPolling(t.key_id);
        if (poolKey) {
          await recordAttempt(
            poolKey,
            false,
            { status: exhausted ? 402 : 401, message: reason }
          );
          await updateTask(task.id, {
            attempt: buildAttemptRecord(
              poolKey,
              false,
              { cls: exhausted ? "exhausted" : "disabled", raw: { status: exhausted ? 402 : 401, message: reason } },
              { status: exhausted ? 402 : 401, message: reason }
            ),
            provider: null,
            provider_task_id: null,
            key_id: null,
          });
        }
        return { outcome: "resume-next" };
      }
      // فشل حقيقي (انتهاك سياسة/معطيات/نموذج) → failed نهائي
      await updateTask(task.id, { status: "failed", error_message: truncate(reason, 500) });
      return { outcome: "processing", failedReason: reason };
    }

    // قيد المعالجة → بث تقدم كل دورة استطلاع (~3 ثوانٍ)
    const elapsed = Date.now() - createdAt;
    const pct =
      check.progress !== undefined && check.progress > 0
        ? Math.min(95, check.progress)
        : estimatedProgress("processing", elapsed, def.type as "image" | "video");
    if (pct !== lastSentProgress && onProgress) {
      lastSentProgress = pct;
      try {
        await onProgress({
          progress: pct,
          total: 100,
          message: `قيد التوليد… ${pct}%`,
        });
      } catch {
        // فشل إرسال الإشعار لا يوقف المهمة
      }
    }
    await updateTask(task.id, { progress: pct });
    await wait(POLL_INTERVAL_MS);
  }

  // انتهت النافذة والنتيجة لم تظهر → processing والعميل يتابع بـ get_task
  return { outcome: "processing" };
}

// ————————————————————————— الدوال العامة —————————————————————————

/** التدفق الكامل لأداة generate_image / generate_video */
export async function runGeneration(opts: GenerationOptions): Promise<ToolOutcome> {
  const { type, modelInput, prompt, input } = opts;
  const waitSeconds = Math.max(0, Math.min(240, opts.waitSeconds ?? opts.defaultWait));
  const waitMs = waitSeconds * 1000;

  // 1) توحيد اسم الموديل — غير معروف → خطأ معطيات فوري (دون مهمة)
  const def = resolveModel(modelInput, type);
  if (!def) {
    return fmtFailed(
      `موديل غير معروف: ${modelInput || "(فارغ)"}. المتاح: ${"gpt-image-2-6/flare-text-to-image"} للصور، ${"grok-imagine-video-1-5-preview"} للفيديو.`
    );
  }

  // 2) المسبح التسلسلي — فارغ → رد no_keys بالعربية
  const pool = await sequentialKeyPool(def.providers);
  if (pool.length === 0) {
    return {
      kind: "message",
      isError: false,
      text: `❌ لا توجد مفاتيح نشطة لخدمة ${def.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
    };
  }

  // 3) تسجيل المهمة في Turso قبل أي نداء خارجي (قابلة للتتبع حتى لو انقطع الاتصال)
  const taskId = crypto.randomUUID();
  await insertTask({
    id: taskId,
    model: def.canonical,
    type,
    prompt,
    paramsJson: JSON.stringify({
      type,
      modelInput: modelInput || def.canonical,
      input,
      waitSeconds,
    }),
  });

  const startedAt = Date.now();
  const totalDeadline = startedAt + waitMs + pool.length * 1500; // سقف إجمالي وقائي

  // 4) حلقة التبديل: إنشاء ← انتظار ← (فشل مفتاح/رصيد؟ → المفتاح التالي بنفس task_id)
  for (;;) {
    const creation = await tryCreateOnCandidates({ id: taskId } as TaskRow, def, input);

    if (creation.failed) {
      await updateTask(taskId, { status: "failed", error_message: truncate(creation.failed.reason, 500) });
      const t = await getTask(taskId);
      return fmtFailed(creation.failed.reason, t ?? undefined);
    }

    if (creation.allFailedWaitingKeys) {
      const t = await getTask(taskId);
      return t ? fmtProcessing(t) : fmtProcessing({ id: taskId } as TaskRow);
    }

    // الصور المتزامنة اكتملت فورًا
    if (creation.urls?.length) {
      const t = await getTask(taskId);
      return t ? fmtCompleted(type, creation.urls, t) : fmtCompleted(type, creation.urls, { id: taskId } as TaskRow);
    }

    // 5) نافذة الانتظار مع بث التقدم (wait_seconds=0 → نعيد task_id فورًا)
    if (waitMs === 0) {
      const t = await getTask(taskId);
      return t ? fmtProcessing(t) : fmtProcessing({ id: taskId } as TaskRow);
    }
    const remaining = Math.max(0, totalDeadline - Date.now());
    const waitResult = await waitForCompletion(
      { id: taskId } as TaskRow,
      def,
      Math.min(waitMs, remaining),
      opts.onProgress,
      startedAt
    );

    if (waitResult.outcome === "completed" && waitResult.urls) {
      const t = await getTask(taskId);
      return t ? fmtCompleted(type, waitResult.urls, t) : fmtCompleted(type, waitResult.urls, { id: taskId } as TaskRow);
    }

    if (waitResult.outcome === "processing" && waitResult.failedReason) {
      const t = await getTask(taskId);
      return fmtFailed(waitResult.failedReason, t ?? undefined);
    }

    if (waitResult.outcome === "resume-next") {
      // استأنف على المفتاح التالي بنفس task_id (العميل يرى «قيد المعالجة» فقط).
      // المسبح يُجلب جديدًا: المفتاح المعلّم disabled استُبعد، وexhausted يُعاد حسب المواصفة.
      const poolNow = await sequentialKeyPool(def.providers);
      if (poolNow.length === 0) {
        const t = await getTask(taskId);
        return t ? fmtProcessing(t) : fmtProcessing({ id: taskId } as TaskRow);
      }
      continue;
    }

    // انتهت النافذة → processing مع task_id
    const t = await getTask(taskId);
    return t ? fmtProcessing(t) : fmtProcessing({ id: taskId } as TaskRow);
  }
}

/** صياغة رد مكتمل حسب النوع */
export function formatCompleted(type: "image" | "video" | "merge", urls: string[], task: TaskRow): ToolOutcome {
  return fmtCompleted(type, urls, task);
}

export function formatProcessing(task: TaskRow): ToolOutcome {
  return fmtProcessing(task);
}

export function formatFailed(reason: string, task?: TaskRow): ToolOutcome {
  return fmtFailed(reason, task);
}

/**
 * refreshTask (قسم 6) — لاستدعاء get_task: يحدّث المهمة الجارية حيًا من المزود/خدمة الدمج،
 * مع نفس منطق إعادة المحاولة/التبديل، ثم يعيد صياغة عربية جاهزة للعرض.
 */
export async function refreshTask(taskId: string): Promise<ToolOutcome> {
  const t = await getTask(taskId);
  if (!t) {
    return { kind: "failed", isError: true, text: `❌ لا توجد مهمة بهذا المعرّف: ${taskId}` };
  }

  // مكتملة/فاشلة → صياغة مباشرة
  if (t.status === "completed") {
    const urls = safeParse<string[]>(t.result_urls_json, []);
    if (urls.length > 0) return fmtCompleted(t.type, urls, t);
  }
  if (t.status === "failed") {
    const reason = t.error_message || "سبب غير معروف";
    // حماية القاعدة الذهبية: لا تُظهر أبدًا رسالة تذكر المفاتيح/الرصيد للعميل
    return fmtFailed(sanitizeReason(reason), t);
  }

  // مهام الدمج لها مسارها الخاص (merger.ts)
  if (t.type === "merge") {
    const { refreshMergeTask } = await import("@/lib/merger");
    return refreshMergeTask(t);
  }

  // جارية بلا مهمة مزود → فشل إنشاء على كل المفاتيح → إعادة محاولة بعد تهدئة 45 ثانية
  if (!t.provider_task_id) {
    const sinceUpdate = Date.now() - tursoDateToMs(t.updated_at);
    if (sinceUpdate >= RESUME_COOLDOWN_MS) {
      const params = safeParse<{ modelInput?: string; input?: TaskInput }>(t.params_json, {});
      const def = resolveModel(params.modelInput, t.type as "image" | "video");
      if (!def) return fmtProcessing(t);
      const creation = await tryCreateOnCandidates(t, def, params.input || ({ prompt: t.prompt } as TaskInput));
      if (creation.failed) {
        await updateTask(t.id, { status: "failed", error_message: truncate(creation.failed.reason, 500) });
        return fmtFailed(creation.failed.reason, t);
      }
      if (creation.allFailedWaitingKeys) return fmtProcessing(t);
      if (creation.urls?.length) {
        return fmtCompleted(t.type, creation.urls, t);
      }
      // نجح الإنشاء الآن — نافذة انتظار قصيرة حتى لا تتعطل get_task
      const waitResult = await waitForCompletion(t, def, RESUME_WAIT_MS, undefined, Date.now());
      const fresh = await getTask(t.id);
      if (waitResult.outcome === "completed" && waitResult.urls) {
        return fmtCompleted(t.type, waitResult.urls, fresh ?? t);
      }
      return fmtProcessing(fresh ?? t);
    }
    return fmtProcessing(t);
  }

  // جارية لدى مزود → استطلاع حي
  const def = resolveModel(t.model);
  if (!def) return fmtProcessing(t);
  const waitResult = await waitForCompletion(t, def, RESUME_WAIT_MS, undefined, tursoDateToMs(t.created_at) || Date.now());
  const fresh = await getTask(t.id);

  if (waitResult.outcome === "completed" && waitResult.urls) {
    return fmtCompleted(t.type, waitResult.urls, fresh ?? t);
  }
  if (waitResult.failedReason) {
    return fmtFailed(sanitizeReason(waitResult.failedReason), fresh ?? t);
  }
  return fmtProcessing(fresh ?? t);
}

/** إخفاء أي ذكر لمفاتيح/رصيد من رسائل الفشل الظاهرة للعميل (القاعدة الذهبية 4) */
export function sanitizeReason(reason: string): string {
  return reason
    .replace(/(api[_\s-]?key|مفتاح|رصيد|balance|credit|quota|unauthorized|forbidden)\S*/gi, "مشكلة مؤقتة لدى المزود")
    .replace(/\s+/g, " ")
    .trim();
}
