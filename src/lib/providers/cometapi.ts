/**
 * مزود CometAPI (المزود الثاني) — الأشكال وفق apidoc.cometapi.com (نوفمبر 2026):
 * - صور متزامنة: POST /v1/images/generations (متوافق OpenAI) → data[i].url أو b64_json فورًا.
 * - فيديو غير متزامن: POST /v1/videos → task_id، ثم GET /v1/videos/{task_id}
 *   بحالة pending|success|failure (نفس نمط نقطة صور المهام غير المتزامنة لديهم).
 * ملاحظة: لا يوجد مفتاح CometAPI مضبوط حاليًا — المحوّل مكتوب دفاعيًا ليتبع الشكل الحقيقي،
 * وعند إضافة أول مفتاح يجب اختباره فعليًا بنداء صغير (قاعدة ذهبية رقم 10).
 */
import { ProviderError } from "@/lib/errors";
import { fetchWithTimeout, toProviderError, type ProviderAdapter, type TaskInput, type CheckResult } from "./types";

const COMET_BASE = process.env.COMETAPI_BASE || "https://api.cometapi.com";

/** نداء موحد: CometAPI يعيد أخطاء HTTP قياسية مع جسم {error:{message}} أو {message} */
async function cometFetch(key: string, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers || {}),
      },
    });
  } catch (e) {
    throw toProviderError(e);
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }

  if (!res.ok) {
    const errObj = body?.error as { message?: string } | undefined;
    const msg = errObj?.message || (body?.message as string) || `HTTP ${res.status}`;
    throw { status: res.status, message: msg } as ProviderError;
  }
  return (body || {}) as Record<string, unknown>;
}

/** استخراج أول رابط صالح من بنية متداخلة دفاعيًا */
function extractUrls(obj: unknown, depth = 0): string[] {
  const urls: string[] = [];
  if (depth > 4 || obj == null) return urls;
  if (typeof obj === "string") {
    if (/^https?:\/\/\S+/i.test(obj)) urls.push(obj);
    return urls;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) urls.push(...extractUrls(item, depth + 1));
    return urls;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (["url", "video_url", "videoUrl", "result_url", "download_url"].includes(k)) {
        urls.push(...extractUrls(v, depth + 1));
      } else if (typeof v === "object" || Array.isArray(v)) {
        urls.push(...extractUrls(v, depth + 1));
      }
    }
  }
  return urls;
}

/** تحويل b64_json إلى data URL عند غياب الرابط */
function itemsToUrls(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const urls: string[] = [];
  for (const item of items as Array<Record<string, unknown>>) {
    if (typeof item?.url === "string" && item.url) urls.push(item.url);
    else if (typeof item?.video_url === "string" && item.video_url) urls.push(item.video_url);
    else if (typeof item?.b64_json === "string" && item.b64_json) {
      // روابط البيانات ضخمة لكنها تُخزَّن مرة واحدة وتعمل في أي عارض Markdown
      urls.push(`data:image/png;base64,${item.b64_json}`);
    }
  }
  return urls;
}

interface CometTaskPayload {
  task_id?: string;
  taskId?: string;
  id?: string;
  data?: { task_id?: string; status?: string; data?: unknown; fail_reason?: string };
  [k: string]: unknown;
}

export const cometapiAdapter: ProviderAdapter = {
  /** صور متزامنة — النتيجة تعيد فورًا */
  async createImageSync(key: string, model: string, input: TaskInput) {
    const body: Record<string, unknown> = { model, prompt: input.prompt };
    if (input.aspect_ratio && input.aspect_ratio !== "auto") {
      // تحويل النسبة إلى مقاس تقريبي متوافق مع OpenAI (للموديلات المتوافقة فقط)
      const ratioMap: Record<string, string> = {
        "1:1": "1024x1024",
        "3:2": "1536x1024",
        "2:3": "1024x1536",
        "16:9": "1536x1024",
        "9:16": "1024x1536",
      };
      if (ratioMap[input.aspect_ratio]) body.size = ratioMap[input.aspect_ratio];
    }
    const res = await cometFetch(key, `${COMET_BASE}/v1/images/generations`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    // إن كان الموديل غير متزامن لديهم: سيأتي task_id بدلًا من data — نرمي خطأ مزود ليتولى المسار غير المتزامن
    const payload = res as CometTaskPayload;
    const directUrls = itemsToUrls(payload.data as unknown);
    if (directUrls.length > 0) return { urls: directUrls };
    throw {
      status: 400,
      message: "CometAPI returned no immediate image data (async model?)",
    } as ProviderError;
  },

  async createTask(key: string, model: string, input: TaskInput) {
    const body: Record<string, unknown> = { model, prompt: input.prompt };
    if (input.image_url) body.image_url = input.image_url;
    if (input.aspect_ratio && input.aspect_ratio !== "auto") body.aspect_ratio = input.aspect_ratio;
    if (input.resolution) body.resolution = input.resolution;
    if (input.duration) body.duration = Number(input.duration);
    const res = (await cometFetch(key, `${COMET_BASE}/v1/videos`, {
      method: "POST",
      body: JSON.stringify(body),
    })) as CometTaskPayload;
    const taskId = payloadTaskId(res);
    if (!taskId) {
      throw { status: 500, message: "CometAPI create task response missing task_id" } as ProviderError;
    }
    return { providerTaskId: taskId };
  },

  async checkTask(key: string, providerTaskId: string): Promise<CheckResult> {
    const res = (await cometFetch(
      key,
      `${COMET_BASE}/v1/videos/${encodeURIComponent(providerTaskId)}`
    )) as CometTaskPayload;
    const status = String(res.data?.status || res.status || "pending").toLowerCase();
    if (status === "success" || status === "succeeded" || status === "completed") {
      const urls = itemsToUrls(res.data?.data as unknown).concat(
        extractUrls({ d: res.data }, 0).slice(0, 5)
      );
      const unique = [...new Set(urls.filter((u) => !u.startsWith("data:")))];
      if (unique.length > 0) return { status: "completed", urls: unique, progress: 100 };
      return { status: "failed", error: "نجاح بلا روابط نتائج" };
    }
    if (status === "failure" || status === "failed") {
      const reason = String(res.data?.fail_reason || "فشل التوليد لدى CometAPI");
      return { status: "failed", error: reason };
    }
    return { status: "processing", progress: 45 };
  },
};

function payloadTaskId(res: CometTaskPayload): string | null {
  if (typeof res.task_id === "string") return res.task_id;
  if (typeof res.taskId === "string") return res.taskId;
  if (typeof res.id === "string") return res.id;
  if (typeof res.data?.task_id === "string") return res.data.task_id;
  return null;
}
