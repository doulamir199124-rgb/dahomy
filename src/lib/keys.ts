/**
 * طبقة المفاتيح: ترتيب تسلسلي صارم + تسجيل المحاولات + تحديث عدادات المفاتيح.
 * كل محاولة (نجاح أو فشل + فئتها) تُسجَّل في attempts_json للمهمة،
 * وعدّادات المفتاح تُحدَّث دائمًا حسب قسم 4.3 من المواصفة.
 */
import {
  getKeyPool,
  getKeyById,
  updateKey,
  type AttemptRecord,
  type KeyRow,
} from "@/lib/turso";
import {
  classifyProviderError,
  isExhaustedMessage,
  isKeyOrBalanceFailure,
  truncate,
} from "@/lib/errors";
import { toProviderError, type ProviderError } from "@/lib/providers/types";
import type { ProviderId } from "@/lib/models";

export { toProviderError };
export type { ProviderError };

/** المسبح التسلسلي: أول مفتاح أُضيف يُجرَّب أولًا — exhausted يبقى، disabled فقط يُستبعد */
export async function sequentialKeyPool(providers: ProviderId[]): Promise<KeyRow[]> {
  return getKeyPool(providers);
}

export interface ErrorClassified {
  cls: "disabled" | "exhausted" | "provider" | "params" | "temporary";
  raw: ProviderError;
}

/** بناء سجل المحاولة وتحديث عدادات المفتاح وحالته (يُستدعى مع كل محاولة إنشاء) */
export async function recordAttempt(
  key: KeyRow | null,
  ok: boolean,
  error?: ProviderError
): Promise<ErrorClassified | null> {
  let classified: ErrorClassified | null = null;
  if (!ok && error) {
    classified = { cls: classifyProviderError(error), raw: error };
  }

  if (key) {
    if (ok) {
      await updateKey(key.id, {
        usage_delta: 1,
        success_delta: 1,
        last_used_at: true,
        last_checked_at: true,
        last_error: null,
      });
    } else {
      const patch: Parameters<typeof updateKey>[1] = {
        usage_delta: 1,
        fail_delta: 1,
        last_used_at: true,
        last_checked_at: true,
        last_error: truncate(error?.message || "خطأ غير معروف", 300),
      };
      // المفتاح المرفوض يُعطَّل تلقائيًا، والمستنزف يُعلَّم exhausted (يبقى في القاعدة)
      if (classified?.cls === "disabled") patch.status = "disabled";
      if (classified?.cls === "exhausted") patch.status = "exhausted";
      await updateKey(key.id, patch);
    }
  }

  return classified;
}

/** بناء AttemptRecord للكتابة داخل attempts_json عبر updateTask */
export function buildAttemptRecord(
  key: KeyRow | null,
  ok: boolean,
  classified: ErrorClassified | null,
  error?: ProviderError
): AttemptRecord {
  return {
    provider: key?.provider,
    keyId: key?.id,
    keyLabel: key?.label || undefined,
    ok,
    errorClass: classified?.cls,
    error: ok ? undefined : truncate(error?.message || classified?.raw.message || "خطأ غير معروف", 200),
    at: new Date().toISOString(),
  };
}

/** تصنيف رسالة فشل منتصف المهمة المنشورة من المزود (قسم 4.3.2) */
export function classifyMidTaskFailure(msg: string): { isKeyIssue: boolean; exhausted: boolean } {
  return { isKeyIssue: isKeyOrBalanceFailure(msg), exhausted: isExhaustedMessage(msg) };
}

/** جلب المفتاح المخزن برقمه (لاستطلاع المهام الجارية) */
export async function keyForPolling(keyId: string | null): Promise<KeyRow | null> {
  if (!keyId) return null;
  return getKeyById(keyId);
}
