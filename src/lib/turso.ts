/**
 * طبقة قاعدة البيانات Turso (libSQL عبر HTTP — متوافقة مع Vercel serverless).
 * - عميل واحد معاد استخدامه.
 * - ensureSchema تُنشئ الجداول عند أول وصول (بلا migrations).
 * - كل عمليات المهام والمفاتيح المطلوبة في المواصفة.
 */
import { createClient, type Client, type InValue } from "@libsql/client";

let _client: Client | null = null;
let _schemaPromise: Promise<void> | null = null;

export function getDb(): Client {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة");
    }
    _client = createClient({ url, authToken: token });
  }
  return _client;
}

/** إنشاء الجداول عند أول وصول فقط (نتيجة مخزنة لكل العملية) */
export function ensureSchema(): Promise<void> {
  if (!_schemaPromise) {
    _schemaPromise = (async () => {
      const db = getDb();
      await db.execute(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          provider TEXT,
          provider_task_id TEXT,
          key_id TEXT,
          model TEXT NOT NULL,
          type TEXT NOT NULL,
          prompt TEXT DEFAULT '',
          params_json TEXT DEFAULT '{}',
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          result_urls_json TEXT,
          error_message TEXT,
          attempts_json TEXT DEFAULT '[]',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        )
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          label TEXT DEFAULT '',
          api_key TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          usage_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          fail_count INTEGER DEFAULT 0,
          last_used_at TEXT,
          last_checked_at TEXT,
          last_error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      // فهارس بسيطة تسريع الاستعلامات المتكررة
      await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks (created_at DESC, id DESC)`
      );
      await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_keys_order ON api_keys (provider, created_at ASC, id ASC)`
      );
    })().catch((e) => {
      // فشل التهيئة لا يُخزَّن — المحاولة القادمة تعيد التهيئة
      _schemaPromise = null;
      throw e;
    });
  }
  return _schemaPromise;
}

/** فحص صحة الاتصال بالقاعدة */
export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    await getDb().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// ————————————————————————— أنواع الصفوف —————————————————————————

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  params_json: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface KeyRow {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  api_key: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface AttemptRecord {
  provider?: string;
  keyId?: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

// ————————————————————————— عمليات المهام —————————————————————————

export async function insertTask(t: {
  id: string;
  model: string;
  type: "image" | "video" | "merge";
  prompt?: string;
  paramsJson?: string;
  provider?: string | null;
  status?: TaskRow["status"];
}): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO tasks (id, provider, model, type, prompt, params_json, status, progress)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    args: [t.id, t.provider ?? null, t.model, t.type, t.prompt ?? "", t.paramsJson ?? "{}", t.status ?? "processing"],
  });
}

function mapTaskRow(r: Record<string, unknown>): TaskRow {
  return {
    id: String(r.id),
    provider: (r.provider as string) ?? null,
    provider_task_id: (r.provider_task_id as string) ?? null,
    key_id: (r.key_id as string) ?? null,
    model: String(r.model),
    type: r.type as TaskRow["type"],
    prompt: String(r.prompt ?? ""),
    params_json: String(r.params_json ?? "{}"),
    status: r.status as TaskRow["status"],
    progress: Number(r.progress ?? 0),
    result_urls_json: (r.result_urls_json as string) ?? null,
    error_message: (r.error_message as string) ?? null,
    attempts_json: String(r.attempts_json ?? "[]"),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    completed_at: (r.completed_at as string) ?? null,
  };
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const res = await getDb().execute({
    sql: "SELECT * FROM tasks WHERE id = ?",
    args: [id],
  });
  if (res.rows.length === 0) return null;
  return mapTaskRow(res.rows[0] as unknown as Record<string, unknown>);
}

export interface TaskPatch {
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  status?: TaskRow["status"];
  progress?: number;
  result_urls?: string[] | null;
  error_message?: string | null;
  model?: string;
  attempt?: AttemptRecord; // يُضاف إلى attempts_json تلقائيًا
  params_json_set?: string; // استبدال params_json (لعلامات مثل processFired)
}

/** تحديث جزئي للمهمة — يضبط completed_at عند الاكتمال ويضيف المحاولات تلقائيًا */
export async function updateTask(id: string, patch: TaskPatch): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];

  if (patch.provider !== undefined) {
    sets.push("provider = ?");
    args.push(patch.provider);
  }
  if (patch.provider_task_id !== undefined) {
    sets.push("provider_task_id = ?");
    args.push(patch.provider_task_id);
  }
  if (patch.key_id !== undefined) {
    sets.push("key_id = ?");
    args.push(patch.key_id);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
    if (patch.status === "completed") sets.push("completed_at = datetime('now')");
  }
  if (patch.progress !== undefined) {
    sets.push("progress = ?");
    args.push(Math.max(0, Math.min(100, Math.round(patch.progress))));
  }
  if (patch.result_urls !== undefined) {
    sets.push("result_urls_json = ?");
    args.push(patch.result_urls ? JSON.stringify(patch.result_urls) : null);
  }
  if (patch.error_message !== undefined) {
    sets.push("error_message = ?");
    args.push(patch.error_message);
  }
  if (patch.model !== undefined) {
    sets.push("model = ?");
    args.push(patch.model);
  }
  if (patch.params_json_set !== undefined) {
    sets.push("params_json = ?");
    args.push(patch.params_json_set);
  }
  if (patch.attempt) {
    const current = await getTask(id);
    const attempts: AttemptRecord[] = current ? safeParse(current.attempts_json, []) : [];
    attempts.push(patch.attempt);
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(attempts));
  }

  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  args.push(id);
  await getDb().execute({
    sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
}

export async function listRecentTasks(
  limit = 10,
  filters?: { type?: TaskRow["type"]; status?: TaskRow["status"] }
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filters?.type) {
    where.push("type = ?");
    args.push(filters.type);
  }
  if (filters?.status) {
    where.push("status = ?");
    args.push(filters.status);
  }
  args.push(limit);
  const res = await getDb().execute({
    sql: `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY created_at DESC, id DESC LIMIT ?`,
    args,
  });
  return res.rows.map((r) => mapTaskRow(r as unknown as Record<string, unknown>));
}

export async function taskStats(): Promise<{
  total: number;
  completed: number;
  failed: number;
  processing: number;
}> {
  await ensureSchema();
  const res = await getDb().execute(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'processing' OR status = 'pending' THEN 1 ELSE 0 END) AS processing
     FROM tasks`
  );
  const r = res.rows[0] as unknown as Record<string, unknown> | undefined;
  return {
    total: Number(r?.total ?? 0),
    completed: Number(r?.completed ?? 0),
    failed: Number(r?.failed ?? 0),
    processing: Number(r?.processing ?? 0),
  };
}

/** حذف المهام (لتنظيف آثار الاختبار) */
export async function deleteTasks(ids: string[]): Promise<void> {
  await ensureSchema();
  for (const id of ids) {
    await getDb().execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [id] });
  }
}

// ————————————————————————— عمليات المفاتيح —————————————————————————

function mapKeyRow(r: Record<string, unknown>): KeyRow {
  return {
    id: String(r.id),
    provider: r.provider as KeyRow["provider"],
    label: String(r.label ?? ""),
    api_key: String(r.api_key),
    status: r.status as KeyRow["status"],
    usage_count: Number(r.usage_count ?? 0),
    success_count: Number(r.success_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
    last_used_at: (r.last_used_at as string) ?? null,
    last_checked_at: (r.last_checked_at as string) ?? null,
    last_error: (r.last_error as string) ?? null,
    created_at: String(r.created_at),
  };
}

export async function insertKey(k: {
  id: string;
  provider: "kie" | "cometapi";
  label?: string;
  api_key: string;
}): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key, status) VALUES (?, ?, ?, ?, 'active')`,
    args: [k.id, k.provider, k.label ?? "", k.api_key],
  });
}

export async function listAllKeys(): Promise<KeyRow[]> {
  await ensureSchema();
  const res = await getDb().execute(
    `SELECT * FROM api_keys ORDER BY created_at ASC, id ASC`
  );
  return res.rows.map((r) => mapKeyRow(r as unknown as Record<string, unknown>));
}

/**
 * قلب نظام المفاتيح: كل المفاتيح غير المعطلة لهذه المزودات
 * بترتيب تسلسلي صارم حسب الإضافة (created_at ASC, id ASC) — ليس round-robin.
 * المفتاح المستنزف (exhausted) يبقى في القائمة عمدًا.
 */
export async function getKeyPool(providers: Array<"kie" | "cometapi">): Promise<KeyRow[]> {
  await ensureSchema();
  if (providers.length === 0) return [];
  const placeholders = providers.map(() => "?").join(", ");
  const res = await getDb().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers as InValue[],
  });
  return res.rows.map((r) => mapKeyRow(r as unknown as Record<string, unknown>));
}

export async function getKeyById(id: string): Promise<KeyRow | null> {
  await ensureSchema();
  const res = await getDb().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  if (res.rows.length === 0) return null;
  return mapKeyRow(res.rows[0] as unknown as Record<string, unknown>);
}

export async function findDuplicateKey(
  provider: "kie" | "cometapi",
  apiKey: string
): Promise<boolean> {
  await ensureSchema();
  const res = await getDb().execute({
    sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  return res.rows.length > 0;
}

export interface KeyPatch {
  status?: KeyRow["status"];
  last_used_at?: boolean; // true = ضبط datetime('now')
  last_checked_at?: boolean;
  last_error?: string | null;
  usage_delta?: number;
  success_delta?: number;
  fail_delta?: number;
}

export async function updateKey(id: string, patch: KeyPatch): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
  }
  if (patch.last_used_at) sets.push("last_used_at = datetime('now')");
  if (patch.last_checked_at) sets.push("last_checked_at = datetime('now')");
  if (patch.last_error !== undefined) {
    sets.push("last_error = ?");
    args.push(patch.last_error);
  }
  if (patch.usage_delta) {
    sets.push("usage_count = usage_count + ?");
    args.push(patch.usage_delta);
  }
  if (patch.success_delta) {
    sets.push("success_count = success_count + ?");
    args.push(patch.success_delta);
  }
  if (patch.fail_delta) {
    sets.push("fail_count = fail_count + ?");
    args.push(patch.fail_delta);
  }
  if (sets.length === 0) return;
  args.push(id);
  await getDb().execute({
    sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
}

export async function deleteKey(id: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}

// ————————————————————————— أدوات مساعدة —————————————————————————

export function safeParse<T>(json: string | null | undefined, fallback: T): T {
  try {
    if (!json) return fallback;
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/** تحويل توقيت Turso "YYYY-MM-DD HH:MM:SS" إلى Date (UTC) */
export function tursoDateToMs(s: string | null | undefined): number {
  if (!s) return 0;
  const d = new Date(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}
