/**
 * تصنيف أخطاء المزودين (قسم 4.2 من المواصفة) وإخفاء المفاتيح.
 * القاعدة الذهبية: نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح/الرصيد أبدًا.
 */

export interface ProviderError {
  status: number;
  message: string;
}

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

// أنماط نفاد الرصيد تُفحص قبل 400 لأن بعض المزودين يرسلونه بحالة 400
const EXHAUSTED_RE =
  /insufficient|quota|balance|credit|out of credits|exhausted|充值|no enough|not enough/i;
const DISABLED_RE =
  /invalid api key|unauthorized|forbidden|authentication|api key|token.*invalid|invalid.*token/i;
const PROVIDER_MODEL_RE = /model not found|unsupported model|unknown model|model.*not (supported|exist)/i;

/** تصنيف خطأ المزود حسب جدول 4.2 — يحدد سلوك التبديل التالي */
export function classifyProviderError(err: ProviderError): ErrorClass {
  const s = err.status;
  const m = err.message || "";

  // 1) مفتاح مرفوض: 401/403 أو رسالة مصادقة → تعطيل المفتاح والانتقال للتالي
  if (s === 401 || s === 403 || DISABLED_RE.test(m)) return "disabled";

  // 2) نفاد رصيد: 402 أو الأنماط المعروفة (قبل فحص 400 عمدًا)
  if (s === 402 || EXHAUSTED_RE.test(m)) return "exhausted";

  // 3) الموديل غير مدعوم لدى هذا المزود → انتقل للمفتاح/المزود التالي
  if (PROVIDER_MODEL_RE.test(m) && [400, 404, 422].includes(s)) return "provider";

  // 4) معطيات الطلب تالفة → توقف فورًا (تبديل المفاتيح لن يحل شيئًا)
  if (s === 400 || s === 422) return "params";

  // 5) 429 / 5xx / أي شيء آخر غير متوقع = مؤقت → انتقل للتالي الآن
  return "temporary";
}

/** هل رسالة فشل المهمة المنشورة من المزود تشير إلى مشكلة مفتاح/رصيد؟ (قسم 4.3.2) */
export function isKeyOrBalanceFailure(msg: string): boolean {
  return /insufficient|balance|credit|quota|402|401|unauthorized|forbidden|exhausted|充值|invalid api key|authentication/i.test(
    msg || ""
  );
}

/** هل نفاد رصيد تحديدًا (لتمييز الحالة exhausted في منتصف المهمة)؟ */
export function isExhaustedMessage(msg: string): boolean {
  return EXHAUSTED_RE.test(msg || "");
}

/** إخفاء المفتاح إلزاميًا في كل الاستجابات والسجلات */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length >= 12) return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
  return `${key.slice(0, 3)}••••`;
}

/** اختصار رسالة الخطأ لتفادي تضخيم السجلات */
export function truncate(text: string, max = 300): string {
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
