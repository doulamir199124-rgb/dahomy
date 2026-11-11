/**
 * GET /api/health — الجهوزية العامة (قسم 9):
 * database: turso-connected | turso-disconnected، merger.healthy = فحص {MERGER}/api/config بمهلة 4 ثوانٍ.
 */
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { listModelSummaries } from "@/lib/models";
import { MERGER_BASE, mergerConfigured } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const database = await dbHealthy();

  // فحص خدمة الدمج بمهلة 4 ثوانٍ
  let mergerHealthy = false;
  if (mergerConfigured()) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${MERGER_BASE}/api/config`, { signal: controller.signal });
      clearTimeout(t);
      mergerHealthy = res.ok;
    } catch {
      mergerHealthy = false;
    }
  }

  return NextResponse.json(
    {
      ok: database,
      database: database ? "turso-connected" : "turso-disconnected",
      mcpEndpoint: "/mcp",
      models: listModelSummaries(),
      merger: { base: mergerConfigured() ? MERGER_BASE : null, healthy: mergerHealthy },
      authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
    },
    { status: 200 }
  );
}
