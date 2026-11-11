/**
 * إدارة المفاتيح للواجهة (قسم 4.4):
 * GET  /api/keys  — القائمة كاملة مع إخفاء المفاتيح دائمًا (maskKey).
 * POST /api/keys  — إضافة {provider, api_key, label?} مع رفض التكرار لنفس المزود.
 */
import { NextResponse } from "next/server";
import { insertKey, listAllKeys, findDuplicateKey } from "@/lib/turso";
import { maskKey } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const keys = await listAllKeys();
  // لا يُعاد المفتاح الكامل في أي استجابة — إخفاء إلزامي
  return NextResponse.json({
    keys: keys.map((k) => ({
      id: k.id,
      provider: k.provider,
      label: k.label,
      masked: maskKey(k.api_key),
      status: k.status,
      usage_count: k.usage_count,
      success_count: k.success_count,
      fail_count: k.fail_count,
      last_used_at: k.last_used_at,
      last_checked_at: k.last_checked_at,
      last_error: k.last_error,
      created_at: k.created_at,
    })),
  });
}

export async function POST(req: Request) {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "جسم الطلب يجب أن يكون JSON صالحًا" }, { status: 400 });
  }

  const provider = String(body.provider || "").toLowerCase();
  const apiKey = String(body.api_key || "").trim();
  const label = String(body.label || "").trim();

  if (provider !== "kie" && provider !== "cometapi") {
    return NextResponse.json({ error: "المزود غير مدعوم — القيم المسموحة: kie أو cometapi" }, { status: 400 });
  }
  if (!apiKey) {
    return NextResponse.json({ error: "المفتاح مطلوب" }, { status: 400 });
  }

  if (await findDuplicateKey(provider, apiKey)) {
    return NextResponse.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود — رفض التكرار" }, { status: 409 });
  }

  const id = crypto.randomUUID();
  await insertKey({ id, provider, label, api_key: apiKey });
  return NextResponse.json(
    { ok: true, key: { id, provider, label, masked: maskKey(apiKey), status: "active" } },
    { status: 201 }
  );
}
