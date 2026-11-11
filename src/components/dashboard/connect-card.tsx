"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/hooks/use-toast";

interface ToolChip {
  name: string;
  desc: string;
}

const TOOLS: ToolChip[] = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي (flare-text-to-image) مع تبديل تلقائي للمفاتيح." },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي (حوار/مؤثرات/موسيقى) مع خيار صورة أول إطار." },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب المطلوب — روابط مباشرة أو task_ids." },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها — صور/فيديو/دمج — كل ~10 ثوانٍ حتى الاكتمال." },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها من قاعدة البيانات." },
];

/** البطاقة (ج) — ربط السيرفر: الرابط + JSON جاهز لكل عميل + رقائق الأدوات + الملاحظة الكهرمانية */
export function ConnectCard() {
  const [origin, setOrigin] = useState("");
  const [authRequired, setAuthRequired] = useState(false);

  useEffect(() => {
    // القراءة خارج المسار المتزامن لتفادي cascading renders
    const t0 = setTimeout(() => {
      setOrigin(window.location.origin);
      fetch("/api/health", { cache: "no-store" })
        .then((r) => r.json())
        .then((d: { authRequired?: boolean }) => setAuthRequired(Boolean(d.authRequired)))
        .catch(() => {});
    }, 0);
    return () => clearTimeout(t0);
  }, []);

  const mcpUrl = origin ? `${origin}/mcp` : "";

  const snippets = useMemo(() => {
    const headers = authRequired ? { Authorization: "Bearer <MCP_ACCESS_TOKEN>" } : undefined;
    const base = {
      "media-generator": headers ? { url: mcpUrl, headers } : { url: mcpUrl },
    };
    return {
      chatgpt: {
        mcpServers: base,
        _note: "في ChatGPT: Settings → Connectors → Create → Custom MCP server — وضع الرابط في «Server URL»",
      },
      claude: { mcpServers: { "media-generator": { type: "http", url: mcpUrl } } },
      cursor: { mcpServers: base },
    };
  }, [mcpUrl, authRequired]);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: `نُسخ ${what}` });
    } catch {
      toast({ title: "تعذر النسخ — انسخ يدويًا", variant: "destructive" });
    }
  };

  const pretty = (obj: unknown) => JSON.stringify(obj, null, 2);

  return (
    <Card className="border-zinc-800 bg-zinc-900/60">
      <CardHeader>
        <CardTitle className="text-lg font-bold">ربط السيرفر</CardTitle>
        <CardDescription className="text-sm text-zinc-400">
          انسخ الرابط وإعدادات الربط إلى أي عميل MCP — ChatGPT و Claude Desktop و Cursor و
          Windsurf و Cline.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* حقل الرابط المطلق + نسخ */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            readOnly
            value={mcpUrl}
            className="ltr-code flex-1 bg-zinc-950"
            aria-label="رابط خادم MCP المطلق"
          />
          <Button
            variant="outline"
            onClick={() => copy(mcpUrl, "الرابط")}
            className="min-h-[44px] px-6 font-bold"
          >
            نسخ الرابط
          </Button>
        </div>

        {/* تبويبات JSON للعملاء */}
        <Tabs defaultValue="chatgpt" dir="rtl">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="chatgpt">ChatGPT / GPT Agents</TabsTrigger>
            <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
            <TabsTrigger value="cursor">Cursor / Windsurf / Cline</TabsTrigger>
          </TabsList>

          <TabsContent value="chatgpt" className="space-y-2">
            <p className="text-xs leading-relaxed text-zinc-400">
              في ChatGPT: Settings → Connectors → Create → Custom MCP server — وضع الرابط في
              «Server URL».
            </p>
            <pre className="ltr-code max-h-48 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-200">
              {pretty(snippets.chatgpt)}
            </pre>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => copy(pretty(snippets.chatgpt), "JSON")}
              className="min-h-[36px] px-4 text-xs"
            >
              نسخ JSON
            </Button>
          </TabsContent>

          <TabsContent value="claude" className="space-y-2">
            <p className="text-xs leading-relaxed text-zinc-400">
              ضعه في ملف <span className="ltr-code">claude_desktop_config.json</span>.
            </p>
            <pre className="ltr-code max-h-48 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-200">
              {pretty(snippets.claude)}
            </pre>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => copy(pretty(snippets.claude), "JSON")}
              className="min-h-[36px] px-4 text-xs"
            >
              نسخ JSON
            </Button>
          </TabsContent>

          <TabsContent value="cursor" className="space-y-2">
            <p className="text-xs leading-relaxed text-zinc-400">
              ضعه في <span className="ltr-code">mcp.json</span> لديك.
            </p>
            <pre className="ltr-code max-h-48 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-200">
              {pretty(snippets.cursor)}
            </pre>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => copy(pretty(snippets.cursor), "JSON")}
              className="min-h-[36px] px-4 text-xs"
            >
              نسخ JSON
            </Button>
          </TabsContent>
        </Tabs>

        {/* رقائق الأدوات الخمس */}
        <div>
          <h3 className="mb-2 text-sm font-bold text-zinc-300">الأدوات الخمس المتاحة</h3>
          <ul className="grid gap-2 sm:grid-cols-2">
            {TOOLS.map((t) => (
              <li
                key={t.name}
                className="rounded-lg border border-zinc-800 bg-zinc-900 p-2.5 text-xs"
              >
                <span className="ltr-code rounded bg-zinc-800 px-1.5 py-0.5 font-bold text-violet-300">
                  {t.name}
                </span>
                <p className="mt-1.5 leading-relaxed text-zinc-400">{t.desc}</p>
              </li>
            ))}
          </ul>
        </div>

        {/* الملاحظة الكهرمانية */}
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">
          الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10
          ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي
          (Progress notifications) حتى لا تنقطع العملية.
        </p>
      </CardContent>
    </Card>
  );
}
