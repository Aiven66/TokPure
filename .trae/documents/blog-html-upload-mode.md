# 管理后台「博客管理」新增 HTML 上传模式

## Context

管理后台（`/admin.html` → 「博客管理」页签）当前只渲染 `public-pkg/blog/blog-editor.tsx` 的 `<BlogEditor />`，编辑视图是一个传统表单：标题、分类、封面图 URL（Input 直填）、摘要、正文 HTML（Textarea 直填）。组件文件末尾的注释写明这是「有意简化」——源实现里的 **HTML 文件上传、封面本地上传、自动分类** 被刻意省略了。

现在需要按参考截图补回 **HTML 上传模式**：运营把做好的 .html 文件直接拖进后台，标题/分类自动读出，再配上封面与配图，一键发布。目标是让「从外部产出 HTML → 上线博客」这条路径不再需要手工把整段 HTML 粘进文本框、手工找图片外链。

## 现状与约束（已核实）

- `public-pkg/` 是**唯一真源**，官网通过 vite alias `@pkg` → `../public-pkg/index.ts` 直接引用源码，不复制。组件包内**不得硬编码 TokPure 专有信息**，宿主能力只能靠 config / adapters 注入。
- 后端是 Vercel Serverless（`tokpure-web/api/`，`api/package.json` = `{"type":"commonjs"}`）。`_lib.js` 已提供 `configured()` / `rest()` / `requireAdmin(req,res)` / `requireUser()`；`blog/posts.js` 已实现 POST/PATCH，`blog/posts/[id].js` 实现 DELETE。**没有**任何上传接口，`autoCategorize` 端点虽已配置但后端不存在（调用会 404）。
- Supabase 项目 `ljgeozvxdcnkomczxkyb` 的 **Storage 中一个 bucket 都没有**（已通过 Management API 确认）。环境变量 `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` 已就位（`.env.local` 与 Vercel）。
- 前台 `blog-detail.tsx` 用 `dangerouslySetInnerHTML` 渲染 `post.content`，外层 class 是 `blog-article-scope max-w-none`。
- **发现的缺口**：全仓库没有任何 `.blog-article-scope` 样式规则（`tokpure-web/assets/css/site.css` 仅 44 行），而 Tailwind Preflight 会把 `h1/h2/p/ul` 的字号与间距归零 —— 也就是说**即使今天手工粘贴 HTML，正文渲染也是「无排版」的**。本次必须一并补上，否则 HTML 上传模式上线即被判定「样式丢失」。
- 可复用 UI：`ui/` 下已有 `tabs`、`dialog`、`checkbox`、`button`、`card`、`input`、`label`、`badge`、`skeleton`、`alert` 等。i18n 是扁平词典，内置 `en`/`zh`/`zh-Hant`；现有 `blog.admin.*` 键 EN/ZH 各 27 个，**zh-Hant 只有 4 个**（缺的回落英文）。
- `package.json` 脚本：`dev` / `build` / `typecheck` / `preview`。`tsconfig.json` 的 `include` 含 `../public-pkg`，故 `npm run typecheck` 同时检查组件包。注意 **`vite dev` 不提供 `/api/*`**，完整链路需 `npx vercel dev`。

## 方案

### 1. 图片存储：新建 Supabase Storage 公开 bucket + 服务端上传接口

选它是因为：写入用 service role **绕过 RLS，无需编写任何 storage 策略**；公开桶读取走 `/storage/v1/object/public/...`，自带 CDN 缓存；service role 不出现在前端。

创建 bucket（由我通过 Supabase Management API 执行，幂等）：
```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('blog-images','blog-images', true, 3145728,
        array['image/jpeg','image/png','image/webp','image/gif','image/avif'])
on conflict (id) do update set public = true, file_size_limit = 3145728;
```

### 2. 上传接口 `tokpure-web/api/blog/upload.js`（新建）

**入参用 base64 JSON，不用 multipart**：Vercel Node runtime 不填 `req.body` 的 multipart，手工解析 boundary 无新依赖下很脆；客户端 `FileReader` 读 base64 后 POST JSON 最稳。代价是体积膨胀 33%，故单文件上限收到 **3MB**（base64 后约 4MB，留出 Vercel 4.5MB 请求体余量）。

要点：
- `requireAdmin(req,res)` 前置 —— 无 token 401、非管理员 403。
- MIME 白名单 → 扩展名映射；**不含 `image/svg+xml`**（SVG 可内嵌脚本）。
- 路径 `${scope}/${YYYY-MM}/${时间戳}-${4字节随机}-${slug}.${ext}` 防冲突；`scope` ∈ `cover|gallery`，便于日后运营清理。
- 返回 `{ ok, path, url }`，`url = ${SUPABASE_URL}/storage/v1/object/public/blog-images/${key}`。
- 错误码语义化：`400 unsupported mime type` / `413 file too large`。

### 3. 组件包侧抽象：新增通用 `uploadImage`

`config/types.ts` 最小改动：`BlogEndpoints` 增加 `uploadImage?: string`（保留 `uploadCover` 作兼容回落）；`BlogConfig.editor` 增加 `htmlUpload?: boolean`（默认 true，可关）。

`blog-editor.tsx` 取 `endpoints?.uploadImage || endpoints?.uploadCover`。**未配置时不能卡死发布**：拖拽区禁用并显示 `blog.admin.uploadNotConfigured`，同时保留 URL 输入兜底。按 401/403/413 分别映射 `uploadUnauthorized` / `uploadFailed` / `fileTooLarge`。

### 4. HTML 解析：`blog-model.ts` 新增纯函数

沿用现有 regex 风格（不引入 DOMParser，Node/浏览器通用）：
```ts
export interface ParsedBlogHtml { title: string; category: string; content: string; summary: string; relativeImages: string[] }
export function parseBlogHtml(html: string): ParsedBlogHtml;
export function sanitizeBlogHtml(html: string): string;
export function inferBlogCategory(input: { title?: string; content?: string },
  opts?: { candidates?: string[]; fallback?: string }): string;
export function appendImageGallery(contentHtml: string, images: { url: string; alt?: string }[]): string;
```
- **标题优先级**：`og:title`/`twitter:title` → 首个 `<h1>` → `<title>`（剥离 ` | 站点` 后缀）→ 首个 `<h2>`。
- **分类优先级**：`meta[article:section]` → `meta[category]` → `meta[keywords]` 首个命中候选集合的 token；全空则留空，UI 回落 `config.blog.defaultCategory`。
- **正文**：取 `<body>` 内层；若首个 `<h1>` 文本等于已抽标题则删除（详情页自己会渲染 `post.title` 为 h1，否则重复）。
- **清洗 `sanitizeBlogHtml`**：删 `<!-- -->`/`<!DOCTYPE>`/`<?xml?>`；整段删 `script/style/iframe/object/embed/form/noscript/link/meta/base`；删事件属性 `\son\w+\s*=`；删 `href|src|xlink:href|formaction|srcdoc` 里的 `javascript:`/`vbscript:`/`data:text/html`；保留 `style`（仅剔 `expression(`）与 `img[src]`。
- **`relativeImages`**：收集 `src="assets/x.png"` 这类相对路径（上传后必然 404），UI 提示改用配图上传。
- **回退**：解析失败不阻断发布，保留手填值 + 提示 `blog.admin.htmlParseFailed`。

### 5. 自动提炼分类：v1 走前端纯启发式，**不调用后端接口**

理由：同步、离线/演示模式可用、无 AI 依赖；`/api/blog/auto-categorize` 根本不存在，调用会让发布路径不可用。
候选集合来源（与 `blog-list.tsx` 既有约定一致）：`config.blog.categories` → 否则从已加载 posts 聚合 → 最后 `[defaultCategory]`。
打分 `3×标题命中 + 1.5×正文高频词重合 + 1×正文命中`（各项封顶 3），最高分 ≥ 阈值才采纳，否则回落 `defaultCategory`。执行顺序：**HTML meta 解析出的分类（权威）→ 启发式 → defaultCategory**，结果写进可编辑输入框。

### 6. 「其他配图」语义：按顺序以 `<figure>` 追加到正文末尾

用语义化标签（`<figure><img src alt loading="lazy" decoding="async">`），不打 Tailwind 工具类，交给宿主的 `.blog-article-scope` 排版。封面取用顺序：手传封面 → 第一张配图 → `config.blog.defaultCoverFor(category)`。UI 上传后回显缩略图并支持移除。

### 7. 「预览发布效果」：`ui/dialog` 弹窗，不开新页签

新页签需要伪造 slug 路由 + sessionStorage 传未保存内容，而 `/blog/:file` rewrite 只对已存在文章成立。弹窗内**复刻 `blog-detail.tsx` 的 DOM**（category Badge → `formatBlogDate` → `<h1>` → 封面或渐变占位 → 正文），渲染的是「即将保存的最终内容串」（含 gallery 追加），并先 sanitize。`admin.html` 与 `blog-detail.html` 同处 Tailwind CDN + `site.css` 上下文，所见基本即所得。

### 8. 顺带修掉的内容渲染缺口

- 新建 `public-pkg/blog/blog-article-body.tsx`：`<BlogArticleBody html />` 统一 `blog-article-scope max-w-none` + sanitize；`blog-detail.tsx` 与预览弹窗共用（同时收掉详情页未清洗的注入面）。
- 宿主 `assets/css/site.css` 补 `.blog-article-scope` 基础排版：标题字号与间距、段落行高、`img/figure` 最大宽度与圆角、`pre/code/table/blockquote` 基础样式。
- （建议）`api/blog/posts.js` 的 POST/PATCH 对 `content` 做同一份最小清洗（`<script` / `on\w+=` / `javascript:` 三条件）。

## 改动清单

**`public-pkg/`（通用、零品牌信息）**

| 文件 | 动作 |
|---|---|
| `blog/blog-model.ts` | 改：新增 4 个纯函数 + `ParsedBlogHtml` 类型 |
| `blog/blog-editor.tsx` | 改：`mode: 'form' \| 'html'` 状态 + `Tabs` 分段控件；HTML 模式挂载上传表单 |
| `blog/blog-html-upload-form.tsx` | 新：HTML 模式表单 UI（标题/分类/复选框/三个 Dropzone/预览+发布） |
| `blog/blog-article-body.tsx` | 新：统一正文渲染 + sanitize |
| `ui/dropzone.tsx` | 新：通用拖拽/点击选文件（`accept`/`multiple`/`disabled`/`loading`/`title`/`hint`/`onFiles`，文案由调用方传入） |
| `config/types.ts` | 改：`uploadImage`、`editor.htmlUpload` |
| `lib/i18n.ts` | 改：三语新增键（见下），顺手补齐 zh-Hant 缺失的 `blog.admin.*` |
| `index.ts` | 改：导出新组件与新模型函数 |

**`tokpure-web/`（宿主）**

| 文件 | 动作 |
|---|---|
| `api/blog/upload.js` | 新：上传接口 |
| `src/lib/pkg-config.ts` | 改：`endpoints.uploadImage`、`blog.categories`、`editor.htmlUpload` |
| `assets/css/site.css` | 改：`.blog-article-scope` 排版 |
| `supabase/schema.sql` | 改：追加 bucket 创建语句（幂等，留档） |
| `api/blog/posts.js` | 改（可选）：正文最小清洗 |

**i18n 新增键（en / zh / zh-Hant 三语）**：`blog.admin.mode.traditional`、`mode.html`、`newSubtitle`、`htmlTitleAutoHint`、`htmlFileTitle`、`htmlDropHint`、`coverDropHint`、`galleryTitle`、`galleryDropHint`、`autoCategoryLabel`、`preview`、`previewTitle`、`uploading`、`uploadFailed`、`uploadUnauthorized`、`fileTooLarge`、`uploadNotConfigured`、`htmlParseFailed`、`relativeImageWarning`、`galleryAdded`。

## 验证

1. **静态**：`npm run typecheck`（覆盖 `../public-pkg`）；`npm run build`（确认多页入口与新模块均打包无 `@pkg` 解析失败）。
2. **降级路径**：`npm run dev` 打开 `http://localhost:5173/admin.html` → 未提供 `/api/*` 时应看到上传区禁用 + `uploadNotConfigured` 提示，且**仍能靠手填 URL 发布**。
3. **完整链路**：`npx vercel dev` → `admin@126.com / admin@666666` 登录 → 博客管理 → 发布新博客 → 切「HTML 上传模式」→ 传含 `<title>`+`<h1>`+`<meta article:section>` 的样例 .html，确认标题/分类自动填充且可编辑 → 传封面 + 2 张配图 → 勾选自动分类 → 预览弹窗确认排版与配图位置 → 发布 → 列表出现该文。
4. **图片可达**：`curl -sI "<返回 url>"` 应 200 且 `Content-Type: image/*`（无需鉴权头）。
5. **渲染与安全**：打开 `/blog/{slug}-{shortId}.html`，DevTools 断言无 `<script>`、无 `on*` 属性、无 `javascript:`，`<figure>` 可见，标题/段落排版生效。
6. **权限与限制**：无 token → 401；非管理员 token → 403；`mimeType: application/octet-stream` → 400；>3MB → 413。
7. **回归**：传统编辑器的保存/删除仍可用；详情页视觉在 `BlogArticleBody` 替换前后一致。

## 待你确认

1. **分类清单**：`config.blog.categories` 目前只有 `defaultCategory: 'General'`，截图里显示的是 `AI Video Clipping`。我打算先按 TokPure 业务填一组（如 `AI Video Clipping` / `Watermark Removal` / `Tutorials` / `Product Updates` / `News`），你可随时改。
2. **服务端清洗是否上位**：在 `api/blog/posts.js` 也做最小清洗会把粘贴进正文的 `<script>` 一并移除（传统模式行为略有变化）。默认按「是」处理。
3. **是否允许上传 SVG**：默认不允许（可内嵌脚本）。若确需，我再加回白名单。
