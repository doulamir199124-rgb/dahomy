"use client";

import { useEffect, useState } from "react";

interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: Array<{ canonical: string; type: string; providers: string[] }>;
  merger: { base: string | null; healthy: boolean };
  authRequired: boolean;
}

/** هيدر اللوحة: العنوان + شارة حالة Turso (أخضر/أحمر) + شارة خدمة الدمج */
export function HealthHeader() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = (await res.json()) as Health;
        if (alive) setHealth(data);
      } catch {
        if (alive) setHealth(null);
      }
    };
    // التحميل الأول خارج المسار المتزامن + تحديث دوري كل 30 ثانية
    const t0 = setTimeout(load, 0);
    const id = setInterval(load, 30000);
    return () => {
      alive = false;
      clearTimeout(t0);
      clearInterval(id);
    };
  }, []);

  const connected = health?.database === "turso-connected";

  return (
    <header className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-xl font-extrabold sm:text-2xl">MCP Media Generator</h1>
        <p className="mt-1 text-sm text-zinc-400">
          خادم MCP لتوليد الصور والفيديو ودمج المقاطع — تبديل تسلسلي تلقائي للمفاتيح دون توقف
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold ${
            connected
              ? "bg-emerald-500/15 text-emerald-400"
              : "bg-rose-500/15 text-rose-400"
          }`}
          aria-live="polite"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              connected ? "bg-emerald-400" : "bg-rose-400"
            }`}
          />
          {connected ? "Turso متصل" : "Turso غير متصل"}
        </span>
        <span
          className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold ${
            health?.merger?.healthy
              ? "bg-emerald-500/15 text-emerald-400"
              : "bg-amber-500/15 text-amber-400"
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${
              health?.merger?.healthy ? "bg-emerald-400" : "bg-amber-400"
            }`}
          />
          خدمة الدمج: {health?.merger?.healthy ? "جاهزة" : "غير مهيأة"}
        </span>
        <span className="ltr-code inline-flex rounded-full bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300">
          POST /mcp
        </span>
      </div>
    </header>
  );
}
