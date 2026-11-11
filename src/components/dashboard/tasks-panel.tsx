"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/hooks/use-toast";

interface TaskItem {
  id: string;
  type: "image" | "video" | "merge";
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  model: string;
  provider: string | null;
  prompt: string;
  result_urls: string[];
  error_message: string | null;
  attempts_count: number;
  created_at: string;
}

interface Stats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

const TYPE_LABEL: Record<TaskItem["type"], string> = {
  image: "صورة",
  video: "فيديو",
  merge: "دمج",
};

const STATUS_BADGE: Record<TaskItem["status"], { label: string; cls: string }> = {
  completed: { label: "مكتملة", cls: "bg-emerald-500/15 text-emerald-400" },
  processing: { label: "جارية", cls: "bg-violet-500/15 text-violet-300" },
  failed: { label: "فاشلة", cls: "bg-rose-500/15 text-rose-400" },
  pending: { label: "بالانتظار", cls: "bg-amber-500/15 text-amber-400" },
};

/** البطاقة (ب) — لوحة المهام: إحصائيات + قائمة تُحدَّث تلقائيًا كل ~5 ثوانٍ */
export function TasksPanel() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      const data = (await res.json()) as { stats: Stats; tasks: TaskItem[] };
      setStats(data.stats);
      setTasks(data.tasks || []);
    } catch {
      /* التحديث التالي يعيد المحاولة */
    }
  }, []);

  useEffect(() => {
    // التحميل الأول خارج المسار المتزامن + تحديث تلقائي كل 5 ثوانٍ
    const t0 = setTimeout(load, 0);
    const id = setInterval(load, 5000);
    return () => {
      clearTimeout(t0);
      clearInterval(id);
    };
  }, [load]);

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      toast({ title: "نُسخ الرابط" });
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast({ title: "تعذر النسخ", variant: "destructive" });
    }
  };

  return (
    <Card className="border-zinc-800 bg-zinc-900/60">
      <CardHeader>
        <CardTitle className="text-lg font-bold">لوحة المهام</CardTitle>
        <CardDescription className="text-sm text-zinc-400">
          أحدث المهام تتحدث تلقائيًا كل 5 ثوانٍ — الصور والفيديو والدمجات بروابطها.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* شرائح الإحصائيات */}
        <div className="grid grid-cols-4 gap-2">
          <StatChip label="الإجمالي" value={stats?.total ?? 0} cls="text-zinc-200 bg-zinc-800/60" />
          <StatChip label="مكتملة" value={stats?.completed ?? 0} cls="text-emerald-400 bg-emerald-500/10" />
          <StatChip label="فاشلة" value={stats?.failed ?? 0} cls="text-rose-400 bg-rose-500/10" />
          <StatChip label="جارية" value={stats?.processing ?? 0} cls="text-violet-300 bg-violet-500/10" />
        </div>

        {tasks.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-700 p-4 text-center text-sm text-zinc-500">
            لا توجد مهام بعد — أول توليد سيظهر هنا تلقائيًا.
          </p>
        ) : (
          <ul className="max-h-96 space-y-3 overflow-y-auto pr-1">
            {tasks.map((t) => (
              <li key={t.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="font-bold text-zinc-300">
                    {TYPE_LABEL[t.type]}
                  </Badge>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-bold ${STATUS_BADGE[t.status].cls}`}
                  >
                    {STATUS_BADGE[t.status].label}
                  </span>
                  {(t.status === "processing" || t.status === "pending") && (
                    <div className="min-w-[90px] flex-1">
                      <Progress value={t.progress} className="h-1.5" />
                    </div>
                  )}
                  <span className="ml-auto text-[11px] text-zinc-500">
                    {t.created_at.replace("T", " ").slice(0, 16)}
                  </span>
                </div>

                <p className="ltr-code mt-2 text-xs text-zinc-400">{t.model}</p>
                {t.prompt && (
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-zinc-300">
                    {t.prompt}
                  </p>
                )}

                {t.status === "completed" && t.result_urls.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <a
                      href={t.result_urls[0]}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-md bg-emerald-500/15 px-3 py-1.5 text-xs font-bold text-emerald-400 hover:bg-emerald-500/25"
                    >
                      فتح النتيجة
                    </a>
                    <button
                      onClick={() => copyUrl(t.result_urls[0])}
                      className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs font-bold text-zinc-300 hover:bg-zinc-700"
                    >
                      {copied === t.result_urls[0] ? "نُسخ" : "نسخ الرابط"}
                    </button>
                  </div>
                )}

                {t.status === "failed" && t.error_message && (
                  <p className="mt-2 rounded bg-rose-500/10 px-2 py-1.5 text-xs text-rose-300">
                    {t.error_message}
                  </p>
                )}

                {t.attempts_count > 1 && (
                  <p className="mt-2 text-[11px] text-zinc-500">
                    المحاولات: {t.attempts_count} (تبديل تلقائي صامت)
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function StatChip({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className={`rounded-lg p-3 text-center ${cls}`} aria-label={`${label}: ${value}`}>
      <p className="text-xl font-extrabold">{value}</p>
      <p className="text-[11px] opacity-80">{label}</p>
    </div>
  );
}
