/**
 * سجل الموديلات (قسم 5.1) — الأسماء القانونية + الصيغ البديلة + أسماء المزودين الحقيقية.
 * أسماء الموديلات لدى المزودين مقاسة فعليًا بنداءات حقيقية (قاعدة ذهبية 10):
 * - الصور لدى KIE: "gpt-image-2-6/flare-text-to-image" (تأكدت بنجاح createTask)
 * - الفيديو لدى KIE: "grok-imagine-video-1-5-preview" بالشرطة (الشكل بالنقطة من صفحات
 *   التوثيق رفضه المزود بـ 422 — الشكل المقاس هو المعتمد)
 * ويمكن تجاوزها بمتغيرات البيئة KIE_IMAGE_MODEL / KIE_VIDEO_MODEL / COMETAPI_*.
 */

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: MediaType;
  providers: ProviderId[];
  providerModel: Record<ProviderId, string>;
}

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image",
      cometapi: process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image",
    },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview",
      cometapi: process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview",
    },
  },
];

/** توحيد اسم الموديل: مطابقة قانونية أو صيغ بديلة (شرطات/نقاط) */
export function resolveModel(input?: string, type?: MediaType): ModelDef | null {
  if (!input) {
    return type ? (MODELS.find((m) => m.type === type) ?? null) : null;
  }
  const name = String(input).trim();
  for (const m of MODELS) {
    if (m.canonical === name || m.aliases.includes(name)) return m;
  }
  // قبول الصيغ البديلة بالنقاط/الشرطات: نوحّد النقاط إلى شرطات ثم نقارن
  const normalized = name.replace(/\./g, "-");
  for (const m of MODELS) {
    if (m.canonical === normalized || m.aliases.includes(normalized)) return m;
    // ومقارنة عكسية: النقاط في canonical مقابل شرطات في المدخل
    if (m.canonical.replace(/-/g, ".") === name || m.aliases.includes(name.replace(/-/g, "."))) return m;
  }
  return null;
}

export function listModelSummaries(): Array<{
  canonical: string;
  type: MediaType;
  providers: ProviderId[];
}> {
  return MODELS.map((m) => ({
    canonical: m.canonical,
    type: m.type,
    providers: [...m.providers],
  }));
}
