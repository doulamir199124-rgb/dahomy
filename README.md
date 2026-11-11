# MCP Media Generator — خادم MCP لتوليد الوسائط ودمج الفيديو

خادم **MCP (Model Context Protocol)** يجمع ثلاث قدرات في أداة واحدة، مع لوحة إدارة عربية RTL:

1. **توليد صور** من وصف نصي — الموديل: `gpt-image-2-6/flare-text-to-image`.
2. **توليد فيديو بصوت متزامن أصلي** (حوار/مؤثرات/موسيقى) — الموديل: `grok-imagine-video-1-5-preview`.
3. **دمج عدة مقاطع فيديو** في مقطع واحد بالترتيب المطلوب (عبر خدمة Video Merger v2).

يعمل الخادم على المسار `/mcp` بنقل **Streamable HTTP** الرسمي عبر `@modelcontextprotocol/sdk`،
ويمكن ربطه بـ ChatGPT Connectors و Claude Desktop و Cursor و Windsurf و Cline وأي عميل MCP.

## القواعد الجوهرية

- **روابط فقط** — لا يُنزَّل أي ملف وسائط على السيرفر إطلاقًا؛ تُخزَّن روابط النتائج في قاعدة Turso.
- **تبديل تسلسلي صارم للمفاتيح**: أول مفتاح أُضيف يُجرَّب أولًا (`created_at ASC`)، وعند أي خطأ أو
  نفاد رصيد ينتقل فورًا للمفتاح التالي ويستأنف **نفس المهمة بنفس `task_id`** — العميل لا يرى
  أخطاء المفاتيح/الرصيد أبدًا.
- مهمة فشل إنشاؤها على كل المفاتيح تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task`
  (بتهدئة 45 ثانية).
- المفاتيح **مُقنَّعة دائمًا** في كل الاستجابات (`ABCD123••••••••WXYZ`).

## الأدوات الخمس

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة — تعيد الرابط فورًا أو `task_id` للمتابعة |
| `generate_video` | توليد فيديو بصوت متزامن + خيار صورة أول إطار (image-to-video) |
| `merge_videos` | دمج مقاطع عبر `urls` مباشرة أو `task_ids` لمهام مكتملة (2–10 مقاطع) |
| `get_task` | تتبع أي مهمة (صور/فيديو/دمج) — حدّث حي من المزود ثم صياغة عربية |
| `list_media` | أحدث الوسائط المخزنة بروابطها من قاعدة البيانات |

## البنية

```
src/
├─ lib/
│  ├─ turso.ts          # طبقة القاعدة: المخطط + عمليات المهام والمفاتيح
│  ├─ errors.ts         # classifyProviderError + maskKey (جدول تصنيف الأخطاء)
│  ├─ models.ts         # سجل الموديلات والأسماء البديلة وأسماء المزودين
│  ├─ keys.ts           # المسبح التسلسلي + تسجيل المحاولات + عدادات المفاتيح
│  ├─ generator.ts      # runGeneration + refreshTask (قلب التبديل «لا توقف أبدًا»)
│  ├─ merger.ts         # عميل Video Merger API v2 + runMerge + refreshMergeTask
│  ├─ providers/        # kie.ts (Jobs API) + cometapi.ts + types.ts
│  └─ mcp-server.ts     # تسجيل الأدوات الخمس + المخططات + SERVER_INSTRUCTIONS
├─ app/
│  ├─ mcp/route.ts      # مسار /mcp (Streamable HTTP، حماية Bearer اختيارية)
│  ├─ api/health/route.ts
│  ├─ api/keys/route.ts + api/keys/[id]/route.ts
│  ├─ api/tasks/route.ts
│  └─ page.tsx          # لوحة الإدارة العربية RTL
└─ components/dashboard/ # مدير المفاتيح + لوحة المهام + بطاقة ربط السيرفر
```

## التشغيل محليًا

```bash
# 1) انسخ المتغيرات
cp .env.example .env.local
# ثم املأ TURSO_DATABASE_URL و TURSO_AUTH_TOKEN

# 2) ثبّت وشغّل
bun install   # أو npm install
npm run dev   # http://localhost:3000
```

افتح اللوحة على `/` — فيها: حالة الاتصال، مدير المفاتيح، لوحة المهام الحية، وإعدادات
ربط جاهزة للنسخ لكل عميل.

## متغيرات البيئة

| المتغير | إلزامي؟ | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | نعم | رابط قاعدة Turso (`libsql://...`) |
| `TURSO_AUTH_TOKEN` | نعم | توكن Turso بصلاحيات كتابة |
| `MERGER_API_BASE` | للدمج فقط | عنوان خدمة Video Merger v2 (مثل `https://xxx.vercel.app`) |
| `MCP_ACCESS_TOKEN` | لا | إن ضُبط يُطلب `Authorization: Bearer <token>` على `/mcp` |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` | لا | تجاوز اسم الموديل لدى kie.ai |
| `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | لا | تجاوز اسم الموديل لدى CometAPI |

> **تنبيه أمني:** `.env*` مستثنى في `.gitignore` منذ أول commit — لا ترفع أي سر إلى Git
> إطلاقًا، ولا يُعاد المفتاح الكامل في أي استجابة API (مقنَّع فقط).

## النشر على Vercel

1. ارفع المستودع إلى GitHub (تم).
2. في [vercel.com](https://vercel.com): **Add New → Project** واختر المستودع.
3. في خطوة **Environment Variables** أضف:
   - `TURSO_DATABASE_URL` = `libsql://...`
   - `TURSO_AUTH_TOKEN` = التوكن
   - `MERGER_API_BASE` = عنوان خدمة الدمج (اختياري — يعمل كل شيء عدا الدمج بدونه)
4. **Deploy** — لا يحتاج أي إعداد إضافي (libSQL يتصل عبر HTTP ومناسب للـ serverless).
5. بعد النشر: افتح `https://<project>.vercel.app` → أضف مفاتيحك من مدير المفاتيح
   → انسخ رابط `https://<project>.vercel.app/mcp` من بطاقة الربط إلى عميلك.

إعداد قاعدة Turso المجانية (إن لم تكن جاهزة):

```bash
turso db create <name>
turso db show <name> --url      # TURSO_DATABASE_URL
turso db tokens create <name>   # TURSO_AUTH_TOKEN
```

## ربط العملاء

**ChatGPT (Settings → Connectors → Create → Custom MCP server):**

```json
{ "mcpServers": { "media-generator": { "url": "https://<domain>/mcp" } } }
```

**Claude Desktop (`claude_desktop_config.json`):**

```json
{ "mcpServers": { "media-generator": { "type": "http", "url": "https://<domain>/mcp" } } }
```

**Cursor / Windsurf / Cline (`mcp.json`):** نفس صيغة ChatGPT.
وإن ضُبط `MCP_ACCESS_TOKEN` أضف `"headers": { "Authorization": "Bearer <token>" }`.

سير العمل داخل الدردشة: استدعِ `generate_image` أو `generate_video` — إن وصلت الروابط اعرضها،
وإن وصل `task_id` فاستدعِ `get_task` كل ~10 ثوانٍ حتى تكتمل المهمة.

## واجهات اللوحة (API)

| Endpoint | الوصف |
|---|---|
| `GET /api/health` | الجهوزية: القاعدة + الموديلات + خدمة الدمج |
| `GET /api/keys` | قائمة المفاتيح مقنَّعة |
| `POST /api/keys` | إضافة مفتاح `{provider, api_key, label?}` (رفض التكرار 409) |
| `PATCH /api/keys/{id}` | `{action: "enable" \| "disable"}` |
| `DELETE /api/keys/{id}` | حذف مفتاح |
| `GET /api/tasks` | إحصائيات + أحدث المهام |
| `POST/GET/DELETE /mcp` | بروتوكول MCP (Streamable HTTP) |

## حدود خدمة الدمج (عند ضبط MERGER_API_BASE)

- 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد.
- الناتج MP4 (H.264 + AAC) بجودة CRF 18 — **يُحذف تلقائيًا بعد 24 ساعة**، فشاهده/نزّله سريعًا.
- أي خطأ معلن من الخدمة (4xx/5xx) = فشل حتمي فوري؛ أخطاء الشبكة لدينا = مؤقتة وتستمر بالاستعلام.

## ملاحظات تقنية

- `gpt-image-2-6/flare-text-to-image` و`grok-imagine-video-1-5-preview` — الأسماء المرسلة
  للمزود **مقاسة بنداءات حقيقية** (الشكل بالنقطة الذي في بعض صفحات التوثيق يرد 422).
- `background` يُرسل فقط عند `resolution=1K` (حسب توثيق الموديل)، والصوت مدمج دائمًا
  في موديل الفيديو (لا معامل enable_audio لدى المزود).
- النقل على `/mcp` بنمط **stateless** — الأنسب لبيئة Vercel serverless بلا جلسات ثابتة،
  وكل الأدوات تعمل مع أي عميل يحترم Streamable HTTP.
