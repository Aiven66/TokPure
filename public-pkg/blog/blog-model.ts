/**
 * 博客领域模型与纯函数工具（无副作用、无种子数据）。
 *
 * 用法：
 *   import { normalizeBlogRow, stripHtml, buildBlogUrl, formatBlogDate } from 'public-pkg/blog/blog-model';
 *
 * 说明：
 * - `normalizeBlogRow` 把数据库行（snake_case / camelCase 混用）归一化为 `BlogPost`；
 * - 不含任何内置文章数据、不 import `@/` 别名、不硬编码品牌或封面图；
 * - 封面缺失时 `coverImage` 为空串，由组件结合 `config.blog.defaultCoverFor` 兜底渲染。
 */

import type { BlogLocale, BlogPost, BlogRow } from '../config/types';

/** 分类兜底值（中性词，非品牌）。 */
const FALLBACK_CATEGORY = 'General';

/** 支持的语言值（用于把任意 locale 字符串归一化到 pkg 三语之一）。 */
const VALID_LOCALES = ['en', 'zh', 'zh-Hant'];

/** 把任意语言标识归一化为 pkg 支持的 `BlogLocale`，无法识别时回落英文。 */
export function normalizeLocale(locale: string | undefined | null): BlogLocale {
  if (!locale) return 'en';
  const raw = String(locale).trim();
  if ((VALID_LOCALES as string[]).includes(raw)) return raw as BlogLocale;
  const short = raw.split('-')[0].split('_')[0].toLowerCase();
  if (short === 'zh' || short === 'cn') {
    if (/hant|tw|hk|mo|traditional|繁/i.test(raw)) return 'zh-Hant';
    return 'zh';
  }
  if (short === 'en') return 'en';
  return 'en';
}

/** 剥离 HTML 标签与常见实体，得到纯文本（与源实现一致）。 */
export function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 标题 → URL 安全 slug，保留 Unicode 字母（CJK 等）以利于 SEO。
 */
export function slugifyTitle(title: string): string {
  return (
    String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u0590-\u05FF\u0600-\u06FF\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  );
}

/** 判断字符串是否为 UUID（兼容旧 URL 格式）。 */
export function isUuid(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

/** 从 slug 末尾解析 UUID 前 8 位短 id，失败返回 null。 */
export function extractShortIdFromSlug(slug: string): string | null {
  const cleaned = slug.replace(/\.html?$/i, '');
  const match = cleaned.match(/-([0-9a-f]{8})$/i);
  return match ? match[1] : null;
}

/**
 * 生成 SEO 友好的文章链接：`{basePath}/{slug}-{shortId}.html`。
 * basePath 来自 `config.blog.basePath`，禁止硬编码。
 */
export function buildBlogUrl(basePath: string, post: Pick<BlogPost, 'id' | 'title'>): string {
  const base = (basePath || '/blog').replace(/\/+$/, '');
  const slug = slugifyTitle(post.title);
  const shortId = String(post.id || '').replace(/-/g, '').slice(0, 8).toLowerCase();
  return `${base}/${slug}-${shortId}.html`;
}

/**
 * 按语言格式化发布时间。locale 映射：zh→zh-CN，zh-Hant→zh-TW，其它→en-US。
 */
export function formatBlogDate(iso: string, locale: BlogLocale = 'en'): string {
  if (!iso) return '';
  const dateLocale = locale === 'zh' ? 'zh-CN' : locale === 'zh-Hant' ? 'zh-TW' : 'en-US';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(dateLocale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * 数据库行 → 领域模型。字段缺失时使用中性兜底值（不使用品牌名 / 外部图片）。
 */
export function normalizeBlogRow(row: BlogRow): BlogPost {
  const id = String(row.id ?? row.slug ?? `blog-${Date.now()}`);
  const slug = String(row.slug ?? id);
  const title = String(row.title ?? 'Untitled');
  const rawContent = String(row.content ?? '');

  let summary = String(row.summary ?? '').trim();
  if (!summary) {
    const text = stripHtml(rawContent);
    summary = text.slice(0, 180).trim();
    if (text.length > 180) summary += '...';
  }

  const category = String(row.category ?? FALLBACK_CATEGORY);
  const coverImage = String(row.cover_image ?? row.coverImage ?? '');
  const author = row.author ? String(row.author) : undefined;
  const publishedAt = String(
    row.created_at ?? row.published_at ?? row.publishedAt ?? new Date().toISOString(),
  );
  const viewCount =
    typeof row.view_count === 'number'
      ? row.view_count
      : typeof row.views === 'number'
        ? row.views
        : 0;
  const parentId = row.parent_id ?? row.parentId ?? null;
  const translationGroup = row.translation_group ? String(row.translation_group) : undefined;

  return {
    id,
    slug,
    title,
    content: rawContent,
    summary,
    category,
    coverImage,
    author,
    publishedAt,
    viewCount,
    isPublished: row.is_published ?? true,
    locale: normalizeLocale(row.locale),
    parentId,
    translationGroup,
  };
}

function rowDateMs(row: BlogRow): number {
  const value = row.created_at ?? row.published_at ?? row.publishedAt ?? '';
  const ms = new Date(String(value)).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * 多语言分组：按 `parent_id || id` 归组，每组仅保留一条——优先当前语言版本，
 * 其次英文 root，最后取组内最新的一条；结果按时间降序。
 * 逻辑与源 `src/app/blog/page.tsx` 一致（语言自动检测一步已省略，见注释）。
 */
export function groupRowsByLocale(rows: BlogRow[], locale: BlogLocale): BlogRow[] {
  const groups = new Map<string, BlogRow[]>();
  for (const row of rows) {
    const parentId = String(row.parent_id ?? row.parentId ?? row.id ?? '');
    if (!groups.has(parentId)) groups.set(parentId, []);
    groups.get(parentId)!.push(row);
  }

  const selected: BlogRow[] = [];
  for (const group of groups.values()) {
    const pick =
      group.find((r) => (r.locale ?? '') === locale) ||
      group.find((r) => !r.locale || r.locale === 'en') ||
      [...group].sort((a, b) => rowDateMs(b) - rowDateMs(a))[0];
    if (pick) selected.push(pick);
  }

  selected.sort((a, b) => rowDateMs(b) - rowDateMs(a));
  return selected;
}

/**
 * 归一化后的 `BlogPost[]` 多语言分组：按 `parentId || id` 归组，每组仅保留
 * 当前语言版本（其次英文，最后组内第一条），结果按发布时间降序。
 */
export function groupPostsByLocale(posts: BlogPost[], locale: BlogLocale): BlogPost[] {
  const groups = new Map<string, BlogPost[]>();
  for (const post of posts) {
    const key = String(post.parentId ?? post.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(post);
  }

  const selected: BlogPost[] = [];
  for (const group of groups.values()) {
    const pick =
      group.find((p) => p.locale === locale) ||
      group.find((p) => p.locale === 'en') ||
      group[0];
    if (pick) selected.push(pick);
  }

  selected.sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );
  return selected;
}

/**
 * 计算文章封面：优先文章自带封面，其次 `config.blog.defaultCoverFor(category)`，
 * 都没有时返回 undefined，交由组件渲染中性渐变占位（不使用外部图片 API）。
 */
export function resolveBlogCover(
  post: Pick<BlogPost, 'coverImage' | 'category'>,
  defaultCoverFor?: (category: string) => string,
): string | undefined {
  if (post.coverImage) return post.coverImage;
  const fallback = defaultCoverFor?.(post.category);
  return fallback || undefined;
}

// ────────────────────────────────────────────────────────────
// HTML 上传模式：解析 / 清洗 / 分类提炼 / 图集追加
// 全部为纯函数（regex 实现，Node 与浏览器通用，不依赖 DOMParser）。
// ────────────────────────────────────────────────────────────

/** `parseBlogHtml` 的解析结果。 */
export interface ParsedBlogHtml {
  /** 文章标题（`og:title` → 首个 `<h1>` → `<title>` → 首个 `<h2>`）。 */
  title: string;
  /** 分类（`meta article:section` → `meta category` → `keywords` 命中候选）。 */
  category: string;
  /** 正文（已 sanitize；若首个 `<h1>` 与标题重复则移除）。 */
  content: string;
  /** 摘要（`meta description` → 首个 `<p>` 截断）。 */
  summary: string;
  /** 正文中的相对路径图片（上传后必然 404，提示运营改用配图上传）。 */
  relativeImages: string[];
}

/** 危险容器标签：成对时整段删除，落单时只删标签本身。 */
const DANGEROUS_TAGS = 'script|style|iframe|object|embed|form|noscript|link|meta|base';

/** 常见实体解码（与 `stripHtml` 保持一致的口径）。 */
function decodeEntities(str: string): string {
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** HTML 片段 → 纯文本（先摘 script/style，再剥标签并解码实体）。 */
function textOf(html: string): string {
  const cleaned = String(html || '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(cleaned).replace(/\s+/g, ' ').trim();
}

/** 取某标签的首个实例的内层文本（大小写不敏感）。 */
function firstTagText(html: string, tag: string): string {
  const match = String(html || '').match(
    new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'i'),
  );
  return match ? textOf(match[1]) : '';
}

/** 收集 `<meta>` 的 name/property/itemprop → content 映射（同名取首个）。 */
function parseMetaTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const tagRe = /<meta\b[^>]*>/gi;
  const attrRe = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(html))) {
    const attrs: Record<string, string> = {};
    attrRe.lastIndex = 0;
    let attr: RegExpExecArray | null;
    while ((attr = attrRe.exec(tag[0]))) {
      attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? '';
    }
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content !== undefined && out[key] === undefined) {
      out[key] = attrs.content;
    }
  }
  return out;
}

/** 取 `<body>` 内层；无 body 标签时返回原文（后续会整段清洗）。 */
function bodyInner(html: string): string {
  const match = String(html || '').match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  return match ? match[1] : String(html || '');
}

/**
 * 内容安全清洗：删注释/doctype/xml 声明、整段删危险容器、删事件属性、
 * 删 `javascript:`/`vbscript:`/`data:text/html` 协议、剔 CSS `expression(`。
 * 保留 `style` 属性（仅剔 expression）与 `img[src]`。
 */
export function sanitizeBlogHtml(html: string): string {
  if (!html) return '';
  let out = String(html);
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<!DOCTYPE[^>]*>/gi, '');
  out = out.replace(/<\?xml[\s\S]*?\?>/gi, '');
  // 成对危险容器：整段删除
  out = out.replace(
    new RegExp(`<(${DANGEROUS_TAGS})\\b[\\s\\S]*?<\\/\\1\\s*>`, 'gi'),
    '',
  );
  // 落单/自闭合同类标签
  out = out.replace(new RegExp(`<(${DANGEROUS_TAGS})\\b[^>]*\\/?>`, 'gi'), '');
  // 事件属性（onclick / onerror / onload ...）
  out = out.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // 危险协议
  out = out.replace(
    /\s(?:href|src|xlink:href|formaction|srcdoc|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (whole, dq, sq, bare) => {
      const value = String(dq ?? sq ?? bare ?? '').toLowerCase();
      return /^(?:javascript:|vbscript:|data:text\/html)/.test(value) ? '' : whole;
    },
  );
  // CSS expression()
  out = out.replace(/expression\s*\(/gi, '');
  return out.trim();
}

/** 统计 needle 在 haystack 中出现的次数（不重叠）。 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** 若正文首个 `<h1>` 的文本与标题一致，则删除该 h1（详情页已单独渲染标题）。 */
function stripLeadingDuplicateH1(content: string, title: string): string {
  if (!title) return content;
  const match = content.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
  if (!match || match.index === undefined) return content;
  if (textOf(match[1]).toLowerCase() !== title.trim().toLowerCase()) return content;
  return (content.slice(0, match.index) + content.slice(match.index + match[0].length)).trim();
}

/** 收集正文中相对路径的图片引用（绝对 URL / 根路径 / data: 除外）。 */
function collectRelativeImages(html: string): string[] {
  const found: string[] = [];
  const re = /\b(?:src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const value = String(match[1] ?? match[2] ?? match[3] ?? '');
    for (const part of value.split(',')) {
      const candidate = part.trim().split(/\s+/)[0];
      if (!candidate) continue;
      if (/^(https?:)?\/\//i.test(candidate) || /^data:/i.test(candidate) || candidate.startsWith('/')) {
        continue;
      }
      if (!/\.(png|jpe?g|webp|gif|avif|svg)(\?|#|$)/i.test(candidate)) continue;
      if (!found.includes(candidate)) found.push(candidate);
      if (found.length >= 20) return found;
    }
  }
  return found;
}

/**
 * 解析上传的 HTML 文件，抽出标题 / 分类 / 正文 / 摘要。
 *
 * `opts.candidates` 用于把 `meta[keywords]` 归一化到宿主已知的分类集合
 * （`article:section` / `category` 视为权威，直接采用）。
 */
export function parseBlogHtml(
  html: string,
  opts: { candidates?: string[] } = {},
): ParsedBlogHtml {
  const raw = String(html || '');
  const meta = parseMetaTags(raw);
  const candidates = (opts.candidates || []).filter(Boolean);

  // 标题：og/twitter → 首个 h1 → title（剥离「 | 站点」后缀）→ 首个 h2
  let title = '';
  const ogTitle = (meta['og:title'] || meta['twitter:title'] || '').trim();
  if (ogTitle) {
    title = ogTitle;
  } else {
    const h1 = firstTagText(raw, 'h1');
    if (h1) {
      title = h1;
    } else {
      const docTitle = firstTagText(raw, 'title');
      title = docTitle
        ? docTitle.replace(/\s+[|｜\-–—]\s+[^|｜\-–—]{1,40}$/, '').trim()
        : firstTagText(raw, 'h2');
    }
  }

  // 分类：article:section / category 为权威；否则用 keywords 命中候选集合
  let category = (meta['article:section'] || meta['category'] || '').trim();
  if (!category) {
    const keywords = (meta['keywords'] || '')
      .split(/[,，;；]/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const keyword of keywords) {
      const lower = keyword.toLowerCase();
      const hit = candidates.find(
        (c) => c.toLowerCase() === lower || c.toLowerCase().includes(lower),
      );
      if (hit) {
        category = hit;
        break;
      }
    }
  }

  // 正文：取 body 内层 → 清洗 → 去掉与标题重复的首个 h1
  const body = bodyInner(raw);
  const content = stripLeadingDuplicateH1(sanitizeBlogHtml(body), title);

  // 摘要：meta description → 首个 p 截断
  let summary = (meta['description'] || meta['og:description'] || '').trim();
  if (!summary) {
    const paragraph = firstTagText(body, 'p');
    summary = paragraph.slice(0, 180);
    if (paragraph.length > 180) summary += '...';
  } else if (summary.length > 180) {
    summary = summary.slice(0, 180);
  }

  return {
    title: title.trim(),
    category,
    content,
    summary,
    relativeImages: collectRelativeImages(body),
  };
}

/** `inferBlogCategory` 的输入。 */
export interface InferCategoryInput {
  title?: string;
  content?: string;
}

/** `inferBlogCategory` 的选项。 */
export interface InferCategoryOptions {
  /** 候选分类集合（通常来自 `config.blog.categories`）。 */
  candidates?: string[];
  /** 无命中时的兜底分类。 */
  fallback?: string;
}

/**
 * 纯启发式分类提炼（同步、离线可用、不依赖任何 AI 接口）。
 *
 * 打分：`3 × 标题命中 + 1.5 × 正文词频 + 1 × 正文命中`，各项封顶 3；
 * 最高分低于阈值（3）时回落 `fallback`。
 */
export function inferBlogCategory(
  input: InferCategoryInput,
  opts: InferCategoryOptions = {},
): string {
  const candidates = (opts.candidates || []).filter(Boolean);
  const fallback = opts.fallback || FALLBACK_CATEGORY;
  if (candidates.length === 0) return fallback;

  const title = stripHtml(input.title || '').toLowerCase();
  const body = stripHtml(input.content || '').toLowerCase();
  if (!title && !body) return fallback;

  const threshold = 3;
  let bestCategory = '';
  let bestScore = 0;

  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const tokens = lower.split(/[^a-z0-9\u4e00-\u9fff]+/).filter((w) => w.length > 2);
    let score = 0;

    // 标题命中：完整分类名或任一关键词
    if (title.includes(lower) || tokens.some((tk) => title.includes(tk))) score += 3;
    // 正文词频：token 出现次数（封顶 3）× 1.5
    const tokenHits = Math.min(
      3,
      tokens.reduce((sum, tk) => sum + countOccurrences(body, tk), 0),
    );
    score += tokenHits * 1.5;
    // 正文命中完整分类名
    if (body.includes(lower)) score += 1;

    if (score > bestScore) {
      bestScore = score;
      bestCategory = candidate;
    }
  }

  return bestScore >= threshold ? bestCategory : fallback;
}

/** 属性值转义（仅用于生成的 `<figure>` 字符串）。 */
function escapeAttr(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 把「其他配图」以语义化 `<figure><img loading="lazy">` 按顺序追加到正文末尾
 * （不打 Tailwind 工具类，样式交给宿主的 `.blog-article-scope`）。
 */
export function appendImageGallery(
  contentHtml: string,
  images: { url: string; alt?: string }[],
): string {
  const valid = (images || []).filter((img) => img && img.url);
  const base = String(contentHtml || '').trim();
  if (valid.length === 0) return base;

  const figures = valid
    .map(
      (img) =>
        `<figure><img src="${escapeAttr(img.url)}" alt="${escapeAttr(img.alt || '')}" loading="lazy" decoding="async" /></figure>`,
    )
    .join('\n');

  return base ? `${base}\n${figures}` : figures;
}