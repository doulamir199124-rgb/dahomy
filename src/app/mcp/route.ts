/**
 * مسار MCP — /mcp (قسم 8):
 * - runtime nodejs + force-dynamic.
 * - النقل الرسمي Streamable HTTP عبر mcp-handler (يغلّف StreamableHTTPServerTransport الرسمي)
 *   في وضع stateless — الأنسب لبيئة Vercel serverless بلا جلسات ثابتة.
 * - إن ضُبط MCP_ACCESS_TOKEN يُطلب Authorization: Bearer <token>.
 */
import { createMcpHandler } from "mcp-handler";
import { registerMediaTools, SERVER_INFO, SERVER_INSTRUCTIONS } from "@/lib/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// مهلة أطول لتتسع نافذة انتظار التوليد (حتى 240 ثانية من wait_seconds)
export const maxDuration = 300;

const mcpHandler = createMcpHandler(
  (server) => {
    // تسجيل الأدوات الخمس على كل خادم جديد (stateless: خادم لكل طلب)
    registerMediaTools(server);
  },
  { serverInfo: SERVER_INFO, instructions: SERVER_INSTRUCTIONS },
  {
    streamableHttpEndpoint: "/mcp",
    sseEndpoint: "/sse",
    sseMessageEndpoint: "/message",
    disableSse: true, // Streamable HTTP فقط — لا نستخدم النقل القديم SSE
    verboseLogs: false,
  }
);

async function handler(req: Request): Promise<Response> {
  // حماية اختيارية بمفتاح Bearer
  const token = process.env.MCP_ACCESS_TOKEN;
  if (token) {
    const auth = req.headers.get("authorization") || "";
    if (auth !== `Bearer ${token}`) {
      return new Response(
        JSON.stringify({ error: "unauthorized: مطلوب ترويسة Authorization: Bearer <MCP_ACCESS_TOKEN>" }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": 'Bearer realm="mcp"',
          },
        }
      );
    }
  }
  return mcpHandler(req);
}

export { handler as POST, handler as GET, handler as DELETE };
