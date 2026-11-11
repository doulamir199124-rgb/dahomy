/**
 * خادم MCP للوسائط (قسم 8) — الأدوات الخمس بمخططات JSON مطابقة حرفيًا للمواصفة،
 * ونتائج الاستدعاء بالعربية. يُبنى عبر SDK الرسمي: McpServer + Streamable HTTP
 * (النقل الرسمي عبر mcp-handler الذي يغلّف StreamableHTTPServerTransport).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runGeneration, refreshTask, type ToolOutcome, type ProgressEvent } from "@/lib/generator";
import { runMerge, listMedia } from "@/lib/merger";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

/** إرسال progress notifications للعميل إن زوّد الطلب بـ progressToken */
async function notifyProgress(
  extra: RequestHandlerExtra<never, never>,
  event: ProgressEvent
): Promise<void> {
  const meta = (extra as unknown as { _meta?: { progressToken?: string | number } })._meta;
  const token = meta?.progressToken;
  if (token === undefined || token === null) return;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken: token,
        progress: event.progress,
        total: event.total,
        message: event.message,
      },
    } as never);
  } catch {
    // فشل الإشعار لا يوقف المهمة أبدًا
  }
}

function toToolResult(outcome: ToolOutcome): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: "text", text: outcome.text }],
    ...(outcome.isError ? { isError: true } : {}),
  };
}

/** أوصاف الأدوات الإنجليزية الدقيقة (العميل يقرأها) — كما هي في المواصفة */
const DESC = {
  generate_image:
    "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active keys). Returns a ready image URL if it completes within the wait window; otherwise returns a task_id — call get_task every ~10 seconds until completed, then show the URL and stop.",
  generate_video:
    "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio — dialogue in the prompt is spoken; optional image-to-video). Videos take minutes: short wait with live progress, then a task_id — track it with get_task every ~10 seconds.",
  merge_videos:
    "Merge several clips into ONE final video in the given order. Pass 'urls' (public direct video links — like generate_video results) or 'task_ids' (completed video generation tasks, resolved from the database in this order — ideal after generating several clips). Merging is usually fast: short wait with live progress, then a merge task_id — track it with get_task. NOTE: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
  get_task:
    "Track any task by its id — image/video generation AND merging (reads Turso and refreshes live from the provider/merging service when still processing). Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
  list_media:
    "Latest stored images/videos/merges with their URLs from the database (no regeneration) — to recall previous results.",
};

/** تسجيل الأدوات الخمس على خادم McpServer */
export function registerMediaTools(server: McpServer): void {
  // 1) generate_image
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description: DESC.generate_image,
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const { prompt, model, aspect_ratio, resolution, background, output_format, wait_seconds } =
        args as {
          prompt: string;
          model: string;
          aspect_ratio: string;
          resolution: string;
          background: string;
          output_format: string;
          wait_seconds: number;
        };
      const outcome = await runGeneration({
        type: "image",
        modelInput: model,
        prompt,
        input: { prompt, aspect_ratio, resolution, background, output_format },
        waitSeconds: wait_seconds,
        defaultWait: 90,
        onProgress: (e) => notifyProgress(extra as never, e),
      });
      return toToolResult(outcome);
    }
  );

  // 2) generate_video — ملاحظة: الصوت مدمج دائمًا في هذا الموديل حسب التوثيق الرسمي،
  //    لذا enable_audio مقبول في المخطط ولا يُمرَّر للمزود.
  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description: DESC.generate_video,
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true).describe("Audio is always embedded by this model."),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const { prompt, image_url, model, aspect_ratio, resolution, duration, wait_seconds } = args as {
        prompt: string;
        image_url?: string;
        model: string;
        aspect_ratio: string;
        resolution: string;
        duration: number;
        wait_seconds: number;
      };
      const outcome = await runGeneration({
        type: "video",
        modelInput: model,
        prompt,
        input: {
          prompt,
          ...(image_url ? { image_url } : {}),
          aspect_ratio,
          resolution,
          duration,
        },
        waitSeconds: wait_seconds,
        defaultWait: 25,
        onProgress: (e) => notifyProgress(extra as never, e),
      });
      return toToolResult(outcome);
    }
  );

  // 3) merge_videos — الحدود (2..10) تُدقق داخل المعالج برسائل عربية صحيحة
  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description: DESC.merge_videos,
      inputSchema: {
        urls: z.array(z.string()).optional().describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z.array(z.string()).optional().describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      const { urls, task_ids, wait_seconds } = args as {
        urls?: string[];
        task_ids?: string[];
        wait_seconds: number;
      };
      if ((!urls || urls.length === 0) && (!task_ids || task_ids.length === 0)) {
        return toToolResult({
          kind: "failed",
          isError: true,
          text: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.",
        });
      }
      const outcome = await runMerge({
        urls,
        taskIds: task_ids,
        waitSeconds: wait_seconds,
        onProgress: (e) => notifyProgress(extra as never, e),
      });
      return toToolResult(outcome);
    }
  );

  // 4) get_task
  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description: DESC.get_task,
      inputSchema: {
        task_id: z.string().min(1),
      },
    },
    async (args) => {
      const { task_id } = args as { task_id: string };
      const outcome = await refreshTask(task_id.trim());
      return toToolResult(outcome);
    }
  );

  // 5) list_media
  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description: DESC.list_media,
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const { type, status, limit } = args as {
        type?: "image" | "video" | "merge";
        status?: "completed" | "failed" | "processing";
        limit?: number;
      };
      const outcome = await listMedia(type ? { type } : undefined, limit ?? 10);
      return toToolResult(outcome);
    }
  );

  // مخططات tools/list الحرفية من المواصفة (حد 10 للدمج، بلا resolution/fps، القيم الافتراضية…).
  // الدقق الفعلي داخل المعالجات (zod) مقصودًا متساهل في الحدود حتى تُرد الرسائل العربية الصحيحة.
  overrideToolsList(server);
}

const SPEC_TOOLS: Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> = [
  {
    name: "generate_image",
    description: DESC.generate_image,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, description: "What to draw. Detailed prompts give better results." },
        model: { type: "string", enum: ["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"], default: "gpt-image-2-6/flare-text-to-image" },
        aspect_ratio: { type: "string", enum: ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"], default: "auto" },
        resolution: { type: "string", enum: ["1K", "2K", "4K"], default: "1K" },
        background: { type: "string", enum: ["auto", "transparent", "opaque"], default: "auto", description: "Only applied at 1K." },
        output_format: { type: "string", enum: ["png", "jpeg", "webp", "gif"], default: "png" },
        wait_seconds: { type: "integer", minimum: 0, maximum: 240, default: 90 },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_video",
    description: DESC.generate_video,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", maxLength: 4096, description: "Scene description. Dialogue in the prompt is spoken in the video." },
        image_url: { type: "string", description: "Optional public image URL as the first frame (image-to-video)." },
        model: { type: "string", enum: ["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"], default: "grok-imagine-video-1-5-preview" },
        aspect_ratio: { type: "string", enum: ["auto", "1:1", "16:9", "9:16", "3:2", "2:3"], default: "auto" },
        resolution: { type: "string", enum: ["480p", "720p", "1080p"], default: "480p" },
        enable_audio: { type: "boolean", default: true },
        duration: { type: "integer", minimum: 1, maximum: 15, default: 8, description: "Duration in seconds." },
        wait_seconds: { type: "integer", minimum: 0, maximum: 240, default: 25 },
      },
      required: ["prompt"],
    },
  },
  {
    name: "merge_videos",
    description: DESC.merge_videos,
    inputSchema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 10, description: "Public direct video URLs (http/https) in merge order — the first clip starts the final video." },
        task_ids: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 10, description: "Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order." },
        wait_seconds: { type: "integer", minimum: 0, maximum: 240, default: 60 },
      },
    },
  },
  {
    name: "get_task",
    description: DESC.get_task,
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
  {
    name: "list_media",
    description: DESC.list_media,
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["image", "video", "merge"] },
        status: { type: "string", enum: ["completed", "failed", "processing"] },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
    },
  },
];

/** تجاوز معالج tools/list لإخراج مخططات المواصفة حرفيًا (tools/call يبقى على دقق zod الداخلي) */
function overrideToolsList(server: McpServer): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (server as unknown as { server: any }).server;
  raw.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: SPEC_TOOLS,
  }));
}

/** بناء خادم جاهز للربط بالنقل */
export function buildMediaServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
  });
  registerMediaTools(server);
  return server;
}
