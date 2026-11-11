/**
 * واجهة المزودين (قسم 5.2) — كل خطأ يُرمى كـ ProviderError ليُصنَّف في errors.ts.
 */
import type { ProviderError } from "@/lib/errors";

// إعادة تصدير النوع ليستخدمه بقية الطبقات من مكان واحد
export type { ProviderError };

export interface TaskInput {
  prompt: string;
  image_url?: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  duration?: number;
  [k: string]: unknown;
}

export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  /** مهمة غير متزامنة (فيديو وصور KIE) — تعيد providerTaskId */
  createTask(key: string, model: string, input: TaskInput): Promise<{ providerTaskId: string }>;
  /** صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا) */
  createImageSync?(key: string, model: string, input: TaskInput): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(key: string, providerTaskId: string): Promise<CheckResult>;
}

/** تحويل أي رمي إلى ProviderError موحّد */
export function toProviderError(e: unknown): ProviderError {
  if (e && typeof e === "object" && "status" in e && "message" in e) {
    return e as ProviderError;
  }
  // خطأ شبكة/انقطاع = مؤقت (status 0)
  return { status: 0, message: e instanceof Error ? e.message : String(e) };
}

/** fetch بمهلة زمنية لتفادي تعليق serverless */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 30000
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}
