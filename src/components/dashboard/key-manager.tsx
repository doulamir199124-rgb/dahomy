"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";

interface KeyItem {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  masked: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

const STATUS_BADGE: Record<KeyItem["status"], { label: string; cls: string }> = {
  active: { label: "نشط", cls: "bg-emerald-500/15 text-emerald-400" },
  exhausted: { label: "مستنزف", cls: "bg-amber-500/15 text-amber-400" },
  disabled: { label: "معطّل", cls: "bg-zinc-500/15 text-zinc-400" },
};

const PROVIDER_LABEL: Record<KeyItem["provider"], string> = {
  kie: "kie.ai",
  cometapi: "CometAPI",
};

/** البطاقة (أ) — مدير المفاتيح: إضافة/تعطيل/تنشيط/حذف مع إخفاء دائم للمفاتيح */
export function KeyManager() {
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [provider, setProvider] = useState<"kie" | "cometapi">("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/keys", { cache: "no-store" });
      const data = (await res.json()) as { keys: KeyItem[] };
      setKeys(data.keys || []);
    } catch {
      /* الشبكة تعود تلقائيًا */
    }
  }, []);

  useEffect(() => {
    // التحميل الأول خارج المسار المتزامن
    const t0 = setTimeout(load, 0);
    return () => clearTimeout(t0);
  }, [load]);

  const addKey = async () => {
    if (!apiKey.trim()) {
      toast({ title: "المفتاح مطلوب", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error || "فشل إضافة المفتاح", variant: "destructive" });
      } else {
        toast({ title: "أُضيف المفتاح بنجاح" });
        setApiKey("");
        setLabel("");
        await load();
      }
    } catch {
      toast({ title: "تعذر الاتصال بالخادم", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (k: KeyItem) => {
    const action = k.status === "disabled" ? "enable" : "disable";
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    await load();
  };

  const remove = async (k: KeyItem) => {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    toast({ title: "حُذف المفتاح" });
    await load();
  };

  return (
    <Card className="border-zinc-800 bg-zinc-900/60">
      <CardHeader>
        <CardTitle className="text-lg font-bold">مدير المفاتيح</CardTitle>
        <CardDescription className="text-sm leading-relaxed text-zinc-400">
          أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري
          تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* نموذج الإضافة */}
        <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
          <div className="space-y-1.5">
            <Label htmlFor="provider">المزود</Label>
            <Select value={provider} onValueChange={(v) => setProvider(v as "kie" | "cometapi")}>
              <SelectTrigger id="provider" aria-label="اختيار المزود">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="kie">kie.ai</SelectItem>
                <SelectItem value="cometapi">CometAPI</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="key-label">تسمية (اختياري)</Label>
            <Input
              id="key-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="مثال: المفتاح الرئيسي"
            />
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="الصق مفتاح API هنا"
            className="ltr-code flex-1"
            type="password"
            autoComplete="off"
          />
          <Button onClick={addKey} disabled={busy} className="min-h-[44px] px-6 font-bold">
            {busy ? "جارٍ الإضافة…" : "إضافة المفتاح"}
          </Button>
        </div>

        {/* قائمة المفاتيح */}
        {keys.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-700 p-4 text-center text-sm text-zinc-500">
            لا توجد مفاتيح بعد — أضف أول مفتاح لتشغيل التوليد.
          </p>
        ) : (
          <ul className="max-h-96 space-y-3 overflow-y-auto pr-1">
            {keys.map((k) => (
              <li
                key={k.id}
                className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="font-bold text-violet-300">
                      {PROVIDER_LABEL[k.provider]}
                    </Badge>
                    <span className={`ltr-code rounded bg-zinc-800 px-2 py-0.5 text-xs`}>
                      {k.masked}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-bold ${STATUS_BADGE[k.status].cls}`}
                    >
                      {STATUS_BADGE[k.status].label}
                    </span>
                    {k.label && <span className="text-zinc-400">{k.label}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => toggle(k)}
                      className="min-h-[36px] px-3 text-xs"
                    >
                      {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => remove(k)}
                      className="min-h-[36px] px-3 text-xs"
                    >
                      حذف
                    </Button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
                  <span>الاستخدام: {k.usage_count}</span>
                  <span className="text-emerald-400">نجاح: {k.success_count}</span>
                  <span className="text-rose-400">فشل: {k.fail_count}</span>
                  {k.last_used_at && (
                    <span>آخر استخدام: {k.last_used_at.replace("T", " ").slice(0, 16)}</span>
                  )}
                </div>
                {k.last_error && (
                  <p className="ltr-code mt-1.5 rounded bg-zinc-800/70 px-2 py-1 text-[11px] text-amber-300">
                    آخر خطأ: {k.last_error}
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
