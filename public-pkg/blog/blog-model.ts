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