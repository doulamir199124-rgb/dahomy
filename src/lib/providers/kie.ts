/**
 * مزود kie.ai — Jobs API الموحد (الأشكال مأخوذة حرفيًا من docs.kie.ai المقاسة):
 * POST /api/v1/jobs/createTask  → {"code":200,"msg":"success","data":{"taskId":"..."}}
 * GET  /api/v1/jobs/recordInfo?taskId=... → {"code":200,"data":{"state":"waiting|queuing|
 *        generating|success|fail","resultJson":"{\"resultUrls\":[\"...\"]}","failMsg":"..."}}
 * انتبه: resultJson نص JSON داخل JSON يحتاج JSON.parse ثانيًا.
 * KIE قد يعيد HTTP 200 مع code != 200 في الجسم (401/402/422...) — نعتمد code الجسم.
 */
import { ProviderError } from "@/lib/errors";
import { fetchWithTimeout, toProviderError, type ProviderAdapter, type TaskInput, type CheckResult } from "./types";

const KIE_BASE = "https://api.kie.ai/api/v1/jobs";

interface KieEnvelope<T = unknown> {
  code: number;
  msg?: string;
  data?: T;
}

/** نداء موحد لـ KIE: يرمي ProviderError اعتمادًا على code الجسم أو حالة HTTP */
async function kieFetch<T>(key: string, url: string, init?: RequestInit): Promise<T> {
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
    // انقطاع شبكة/مهلة = مؤقت
    throw toProviderError(e);
  }

  let body: KieEnvelope<T> | null = null;
  try {
    body = (await res.json()) as KieEnvelope<T>;
  } catch {
    body = null;
  }

  if (!res.ok) {
    const msg = body?.msg || `HTTP ${res.status}`;
    throw { status: res.status, message: msg } as ProviderError;
  }
  if (!body || body.code !== 200) {
    // نفاد الرصيد يصل غالبًا هنا بـ code=402 أو 400 مع رسالة — التصنيف يتولاه errors.ts
    throw {
      status: body?.code ?? res.status,
      message: body?.msg || `HTTP ${res.status}`,
    } as ProviderError;
  }
  return body.data as T;
}

export interface KieRecordInfo {
  taskId: string;
  state?: string;
  resultJson?: string;
  failMsg?: string;
  errorMsg?: string;
  completeTime?: number | string;
  [k: string]: unknown;
}

/** تحليل resultJson النصي (أو أي شكل بديل دفاعي) إلى مصفوفة روابط */
export function parseKieResultUrls(data: KieRecordInfo): string[] {
  if (typeof data.resultJson === "string" && data.resultJson.trim()) {
    try {
      const inner = JSON.parse(data.resultJson) as { resultUrls?: unknown } | unknown[];
      if (Array.isArray(inner)) return inner.filter((u) => typeof u === "string") as string[];
      if (Array.isArray(inner?.resultUrls)) {
        return (inner.resultUrls as unknown[]).filter((u) => typeof u === "string") as string[];
      }
    } catch {
      // شكل غير متوقع — نكمل فحص الحقول الأخرى
    }
  }
  if (Array.isArray((data as Record<string, unknown>).resultUrls)) {
    return ((data as Record<string, unknown>).resultUrls as unknown[]).filter(
      (u) => typeof u === "string"
    ) as string[];
  }
  return [];
}

/** تجهيز input الصور وفق توثيق flare-text-to-image (background فقط عند 1K) */
function buildImageInput(input: TaskInput): Record<string, unknown> {
  const payload: Record<string, unknown> = { prompt: input.prompt };
  if (input.aspect_ratio) payload.aspect_ratio = input.aspect_ratio;
  if (input.resolution) payload.resolution = input.resolution;
  if (input.output_format) payload.output_format = input.output_format;
  const is1K = (input.resolution || "1K") === "1K";
  if (is1K && input.background) payload.background = input.background;
  return payload;
}

/** تجهيز input الفيديو وفق توثيق grok-imagine-video-1.5-preview:
 *  image_urls مصفوفة (حتى 7 صور)، المدة رقمية 1-15، الصوت مدمج دائمًا (لا enable_audio). */
function buildVideoInput(input: TaskInput): Record<string, unknown> {
  const payload: Record<string, unknown> = { prompt: input.prompt };
  if (input.image_url) payload.image_urls = [input.image_url];
  if (input.aspect_ratio) payload.aspect_ratio = input.aspect_ratio;
  if (input.resolution) payload.resolution = input.resolution;
  if (input.duration) payload.duration = Number(input.duration);
  return payload;
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key: string, model: string, input: TaskInput) {
    const isVideo = Boolean(input.duration) || String(model).toLowerCase().includes("video");
    const data = await kieFetch<{ taskId: string }>(key, `${KIE_BASE}/createTask`, {
      method: "POST",
      body: JSON.stringify({
        model,
        input: isVideo ? buildVideoInput(input) : buildImageInput(input),
      }),
    });
    if (!data?.taskId) {
      throw { status: 500, message: "createTask response missing taskId" } as ProviderError;
    }
    return { providerTaskId: data.taskId };
  },

  async checkTask(key: string, providerTaskId: string): Promise<CheckResult> {
    const data = await kieFetch<KieRecordInfo>(
      key,
      `${KIE_BASE}/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`
    );
    const state = String(data.state || "waiting").toLowerCase();
    if (state === "success") {
      const urls = parseKieResultUrls(data);
      if (urls.length > 0) return { status: "completed", urls, progress: 100 };
      // نجاح بلا روابط = فشل فعلي دفاعي
      return { status: "failed", error: "المزود أعلن النجاح دون روابط نتائج" };
    }
    if (state === "fail" || state === "failed") {
      const msg = data.failMsg || data.errorMsg || "فشل التوليد لدى المزود";
      return { status: "failed", error: msg };
    }
    // تقدير تقدم تقريبي: waiting → queuing → generating
    const progress = state === "waiting" ? 8 : state === "queuing" ? 18 : 45;
    return { status: "processing", progress };
  },
};
