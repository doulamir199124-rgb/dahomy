import { HealthHeader } from "@/components/dashboard/health-header";
import { KeyManager } from "@/components/dashboard/key-manager";
import { TasksPanel } from "@/components/dashboard/tasks-panel";
import { ConnectCard } from "@/components/dashboard/connect-card";

/**
 * لوحة الإدارة العربية RTL — صفحة واحدة بثلاث بطاقات:
 * مدير المفاتيح / لوحة المهام / ربط السيرفر + هيدر يعرض حالة /api/health.
 */
export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        <HealthHeader />

        <main className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            <KeyManager />
          </div>
          <div className="space-y-6">
            <TasksPanel />
          </div>
        </main>

        <div className="mt-6">
          <ConnectCard />
        </div>

        <footer className="mt-10 border-t border-zinc-800 pt-4 text-center text-xs text-zinc-500">
          <p>
            خادم MCP للوسائط — توليد الصور والفيديو ودمج المقاطع · النسخة 1.2.0 · الملفات لا تُخزَّن
            على السيرفر إطلاقًا — الروابط فقط
          </p>
        </footer>
      </div>
    </div>
  );
}
