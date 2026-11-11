/**
 * GET /api/tasks — بيانات لوحة المهام: الإحصائيات + أحدث المهام (ترتيب من الأحدث).
 * ملاحظة: last_error للمفاتيح لا يظهر هنا للمفاتيح فقط في /api/keys — رسائل مهام الفشل
 * معقمة مسبقًا من أي ذكر لمفاتيح/رصيد (القاعدة الذهبية).
 */
import { NextResponse } from "next/server";
import { listRecentTasks, taskStats, safeParse, type TaskRow } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function serializeTask(t: TaskRow) {
  const urls = safeParse<string[]>(t.result_urls_json, []);
  const attempts = safeParse<Array<{ ok: boolean; errorClass?: string }>>(t.attempts_json, []);
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    progress: t.progress,
    model: t.model,
    provider: t.provider,
    prompt: t.prompt.slice(0, 160),
    result_urls: urls,
    error_message: t.status === "failed" ? t.error_message : null,
    attempts_count: attempts.length,
    created_at: t.created_at,
    updated_at: t.updated_at,
    completed_at: t.completed_at,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20)));
  const type = url.searchParams.get("type") as TaskRow["type"] | null;
  const status = url.searchParams.get("status") as TaskRow["status"] | null;

  const [stats, tasks] = await Promise.all([
    taskStats(),
    listRecentTasks(limit, {
      type: type && ["image", "video", "merge"].includes(type) ? type : undefined,
      status: status && ["completed", "failed", "processing", "pending"].includes(status) ? status : undefined,
    }),
  ]);

  return NextResponse.json({ stats, tasks: tasks.map(serializeTask) });
}
