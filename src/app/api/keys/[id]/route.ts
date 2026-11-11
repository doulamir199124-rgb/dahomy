/**
 * PATCH /api/keys/{id} — تعطيل/تنشيط يدوي (action: enable | disable).
 * DELETE /api/keys/{id} — حذف نهائي.
 */
import { NextResponse } from "next/server";
import { getKeyById, updateKey, deleteKey } from "@/lib/turso";
import { maskKey } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const key = await getKeyById(id);
  if (!key) {
    return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  }
  let body: { action?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "جسم الطلب يجب أن يكون JSON صالحًا" }, { status: 400 });
  }

  const action = String(body.action || "").toLowerCase();
  if (action === "disable") {
    await updateKey(id, { status: "disabled" });
  } else if (action === "enable") {
    // التنشيط اليدوي يعيد المفتاح إلى active (حتى لو كان exhausted سابقًا)
    await updateKey(id, { status: "active", last_error: null });
  } else {
    return NextResponse.json({ error: "action غير صالح — القيم المسموحة: enable أو disable" }, { status: 400 });
  }

  const updated = await getKeyById(id);
  return NextResponse.json({
    ok: true,
    key: updated && { ...updated, api_key: undefined, masked: maskKey(updated.api_key) },
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const key = await getKeyById(id);
  if (!key) {
    return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  }
  await deleteKey(id);
  return NextResponse.json({ ok: true });
}
