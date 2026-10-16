/**
 * `<BlogDetail id />` —— 博客详情组件（客户端）。
 *
 * 用法：
 *   import { BlogDetail } from 'public-pkg/blog/blog-detail';
 *   <BlogDetail id={params.id} />
 *
 * 行为：
 * - 优先 `config.adapters.blog.getById`；未注入适配器时回落 Supabase `blogs` 表查询，
 *   并支持 SEO slug URL（`{slug}-{shortId}.html`）与旧 UUID URL；
 * - `config.blog.jsonLd` 为 true 时渲染 BlogPosting / BreadcrumbList 结构化数据；
 * - 右侧栏「推荐阅读」与底部「相关文章」共用同一候选池，但使用不同权重分别排序，
 *   且两榜互斥（底部先选取，右侧只从剩余候选中挑选），保证两处列表内容不重复。
 * - 注：组件内无法使用 Next 的 `generateMetadata`，SSR metadata 请用 `blog-seo.ts` 在宿主 page 中生成。
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

import { getSupabaseClient } from '../adapters/supabase/client';
import type { BlogPost, BlogRow } from '../config/types';
import { usePublicPkg } from '../config/provider';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Skeleton } from '../ui/skeleton';
import { buildBreadcrumbJsonLd, buildBlogPostingJsonLd } from './blog-seo';
import { BlogArticleBody } from './blog-article-body';
import {
  buildBlogUrl,
  extractShortIdFromSlug,
  formatBlogDate,
  groupPostsByLocale,
  groupRowsByLocale,
  isUuid,
  normalizeBlogRow,
  resolveBlogCover,
  slugifyTitle,
} from './blog-model';

const FETCH_LIMIT = 60;
const RELATED_LIMIT = 4;
const SIDEBAR_LIMIT = 5;
const COVER_GRADIENT = 'bg-gradient-to-br from-primary/20 via-muted to-primary/10';

/* ────────────────────────── 推荐算法 ──────────────────────────
 * 完全确定性的客观打分模型（无随机数，同一输入必得同一结果）：
 *   topical    = 主题相关度（同分类 + 标题/摘要词元 Dice 相似度）
 *   recency    = 新鲜度（半衰期衰减）
 *   popularity = 热度（浏览量在候选池内归一化）
 * 两处列表使用不同权重：底部偏主题相关，右侧偏热度与新鲜度。
 * ─────────────────────────────────────────────────────────── */

/** 新鲜度半衰期（天）：约 120 天后权重降到 0.5。 */
const RECENCY_HALF_LIFE_DAYS = 120;
/** 主题相关度内部配比：分类占 6 成，标题词元相似度占 4 成。 */
const TOPICAL_CATEGORY_WEIGHT = 0.6;
const TOPICAL_TITLE_WEIGHT = 0.4;

/** 右侧栏权重：更看重热度与新鲜度。 */
const WEIGHTS_SIDEBAR = { topical: 0.25, recency: 0.35, popularity: 0.4 };
/** 底部相关文章权重：更看重主题相关。 */
const WEIGHTS_RELATED = { topical: 0.6, recency: 0.25, popularity: 0.15 };

/** 拉丁停用词（含 URL 转义残留词元）。 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by',
  'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this',
  'that', 'these', 'those', 'you', 'your', 'yours', 'we', 'our', 'ours', 'i', 'my', 'me',
  'mine', 'he', 'she', 'they', 'them', 'him', 'us', 'his', 'her', 'their', 'theirs', 'how',
  'what', 'which', 'who', 'when', 'where', 'why', 'not', 'no', 'yes', 'do', 'does', 'did',
  'done', 'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
  'have', 'has', 'had', 'if', 'then', 'than', 'so', 'such', 'into', 'about', 'up', 'down',
  'out', 'over', 'more', 'most', 'some', 'any', 'all', 'each', 'every', 'both', 'few',
  'many', 'much', 'very', 'just', 'also', 'only', 'get', 'got', 'make', 'made', 'use',
  'using', 'one', 'two', 'via', 'per', 'amp', 'nbsp', 'quot', 'http', 'https', 'www',
  'com', 'html', 'htm', 'png', 'jpg',
]);

/** 单个汉字的 CJK 虚词：仅在整段 run 长度恰为 1 时用于过滤。 */
const CJK_STOP_FRAGMENTS = new Set([
  '的', '了', '是', '在', '和', '与', '及', '或', '我', '你', '他', '她', '它', '这', '那',
  '有', '就', '都', '而', '也', '很', '会', '对', '把', '被', '让', '从', '到', '为', '之',
  '其', '上', '下', '中', '里', '呢', '吗', '吧', '啊', '哦', '嗯',
]);

/** 提取文本词元：拉丁取单词（长度 ≥2 且非停用词），CJK 取连续汉字二元组。 */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  const lower = String(text || '').toLowerCase();

  const latin = lower.match(/[a-z0-9][a-z0-9+#.]*/g) || [];
  for (const word of latin) {
    if (word.length < 2) continue;
    if (STOP_WORDS.has(word)) continue;
    out.add(word);
  }

  const cjkRuns = lower.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      if (!CJK_STOP_FRAGMENTS.has(run)) out.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      out.add(run.slice(i, i + 2));
    }
  }

  return out;
}

/** 词元集合的 Dice 相似度（0~1）。 */
function diceSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  a.forEach((token) => {
    if (b.has(token)) overlap += 1;
  });
  return (2 * overlap) / (a.size + b.size);
}

/** 新鲜度评分（0~1）：越新越高，按半衰期指数衰减。 */
function recencyScore(iso: string | undefined, now: number): number {
  const ts = Date.parse(String(iso || ''));
  if (!Number.isFinite(ts)) return 0;
  const ageDays = Math.max(0, (now - ts) / 86400000);
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

/** 热度评分（0~1）：候选池内浏览量归一化。 */
function popularityScore(views: number | undefined, maxViews: number): number {
  if (maxViews <= 0) return 0;
  const v = typeof views === 'number' && Number.isFinite(views) ? views : 0;
  return Math.max(0, v) / maxViews;
}

interface RankWeights {
  topical: number;
  recency: number;
  popularity: number;
}

/** 按权重对候选池打分排序并截取前 N 篇（并列时依次按发布时间更新、id 字典序）。 */
function rankCandidates(
  pool: BlogPost[],
  current: BlogPost,
  weights: RankWeights,
  take: number,
): BlogPost[] {
  if (take <= 0 || pool.length === 0) return [];

  const now = Date.now();
  const currentTokens = tokenize(`${current.title} ${current.summary || ''}`);
  let maxViews = 0;
  pool.forEach((p) => {
    const v = typeof p.viewCount === 'number' && Number.isFinite(p.viewCount) ? p.viewCount : 0;
    if (v > maxViews) maxViews = v;
  });

  const scored = pool.map((candidate) => {
    const sameCategory =
      candidate.category && current.category && candidate.category === current.category ? 1 : 0;
    const titleSim = diceSimilarity(
      currentTokens,
      tokenize(`${candidate.title} ${candidate.summary || ''}`),
    );
    const topical =
      TOPICAL_CATEGORY_WEIGHT * sameCategory + TOPICAL_TITLE_WEIGHT * titleSim;
    const recency = recencyScore(candidate.publishedAt, now);
    const popularity = popularityScore(candidate.viewCount, maxViews);
    return {
      post: candidate,
      score: weights.topical * topical + weights.recency * recency + weights.popularity * popularity,
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ta = Date.parse(String(a.post.publishedAt || '')) || 0;
    const tb = Date.parse(String(b.post.publishedAt || '')) || 0;
    if (tb !== ta) return tb - ta;
    return String(a.post.id).localeCompare(String(b.post.id));
  });

  return scored.slice(0, take).map((entry) => entry.post);
}

export interface BlogDetailProps {
  /** 路由参数：UUID 或 SEO slug（含 `.html`）。 */
  id: string;
}

export function BlogDetail({ id }: BlogDetailProps) {
  const { config, locale, t } = usePublicPkg();
  const [post, setPost] = useState<BlogPost | null>(null);
  const [related, setRelated] = useState<BlogPost[]>([]);
  const [recommended, setRecommended] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchPublishedList = useCallback(async (): Promise<BlogPost[]> => {
    const adapter = config.adapters?.blog;
    if (adapter?.listPublished) {
      return adapter.listPublished({ limit: FETCH_LIMIT });
    }
    const creds = config.supabase;
    if (!creds?.url || !creds.anonKey) return [];
    const client = getSupabaseClient(creds);
    const { data, error } = await client
      .from('blogs')
      .select('*')
      .eq('is_published', true)
      .order('created_at', { ascending: false })
      .limit(FETCH_LIMIT);
    if (error) throw error;
    return ((data || []) as BlogRow[]).map(normalizeBlogRow);
  }, [config]);

  const loadPost = useCallback(async () => {
    setLoading(true);
    try {
      const adapter = config.adapters?.blog;
      let found: BlogPost | null = null;

      if (adapter?.getById) {
        found = await adapter.getById(id);
      }

      if (!found) {
        const creds = config.supabase;
        if (!creds?.url || !creds.anonKey) {
          setPost(null);
          setRelated([]);
          setRecommended([]);
          return;
        }
        const client = getSupabaseClient(creds);
        if (isUuid(id)) {
          const { data, error } = await client
            .from('blogs')
            .select('*')
            .eq('id', id)
            .maybeSingle();
          if (error) throw error;
          found = data ? normalizeBlogRow(data as BlogRow) : null;
        } else {
          // SEO slug URL：拉取已发布列表后在 JS 中按 shortId / slug 匹配
          const { data, error } = await client
            .from('blogs')
            .select('*')
            .eq('is_published', true)
            .order('created_at', { ascending: false })
            .limit(100);
          if (error) throw error;
          const selected = groupRowsByLocale((data || []) as BlogRow[], locale);
          const shortId = extractShortIdFromSlug(id);
          const slugWithoutId = id.replace(/\.html?$/i, '').replace(/-([0-9a-f]{8})$/i, '');
          const row = selected.find((r) => {
            if (shortId) {
              const rowShort = String(r.id || '').replace(/-/g, '').slice(0, 8).toLowerCase();
              if (rowShort === shortId) return true;
            }
            return slugifyTitle(String(r.title || '')) === slugWithoutId;
          });
          found = row ? normalizeBlogRow(row) : null;
        }
      }

      setPost(found);

      // 候选池：同语言、排除当前文章
      let rel: BlogPost[] = [];
      try {
        rel = await fetchPublishedList();
      } catch {
        rel = [];
      }
      const pool = groupPostsByLocale(rel, locale).filter(
        (p) => String(p.id) !== String(found?.id),
      );

      if (!found || pool.length === 0) {
        setRelated([]);
        setRecommended([]);
        return;
      }

      // 底部「相关文章」先选：偏主题相关
      const relatedTake = Math.min(RELATED_LIMIT, Math.ceil(pool.length / 2));
      const relatedList = rankCandidates(pool, found, WEIGHTS_RELATED, relatedTake);

      // 右侧「推荐阅读」只从底部未占用的候选中挑选：两榜互斥，保证内容不重复
      const takenIds = new Set(relatedList.map((p) => String(p.id)));
      const remaining = pool.filter((p) => !takenIds.has(String(p.id)));
      const sidebarTake = Math.min(SIDEBAR_LIMIT, remaining.length);
      const sidebarList = rankCandidates(remaining, found, WEIGHTS_SIDEBAR, sidebarTake);

      setRelated(relatedList);
      setRecommended(sidebarList);
    } catch {
      setPost(null);
      setRelated([]);
      setRecommended([]);
    } finally {
      setLoading(false);
    }
  }, [config, id, locale, fetchPublishedList]);

  useEffect(() => {
    loadPost();
  }, [loadPost]);

  if (loading) {
    return (
      <div className="container mx-auto max-w-4xl px-4 py-16">
        <Skeleton className="mb-8 h-4 w-64" />
        <Skeleton className="mb-4 h-4 w-24" />
        <Skeleton className="mb-6 h-10 w-3/4" />
        <Skeleton className="mb-10 h-72 w-full" />
        <div className="space-y-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (!post) {
    return (
      <div className="container mx-auto max-w-4xl px-4 py-16 text-center">
        <h1 className="mb-4 text-2xl font-bold">{t('blog.notFound')}</h1>
        <Button asChild>
          <a href={config.blog.basePath}>{t('blog.backToList')}</a>
        </Button>
      </div>
    );
  }

  const cover = resolveBlogCover(post, config.blog.defaultCoverFor);
  const seoCtx = {
    siteUrl: typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_SITE_URL : undefined,
    brandName: config.brand.name,
    basePath: config.blog.basePath,
    defaultOgImage: config.blog.defaultCoverFor?.(post.category),
  };

  return (
    <div className="container mx-auto max-w-7xl px-4 py-12 md:py-16">
      {config.blog.jsonLd && (
        <>
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: JSON.stringify(buildBlogPostingJsonLd(post, seoCtx)) }}
          />
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: JSON.stringify(buildBreadcrumbJsonLd(config.blog.basePath, post, seoCtx)),
            }}
          />
        </>
      )}

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-12">
        <article className="min-w-0">
          <nav aria-label="Breadcrumb" className="mb-8 flex items-center gap-1.5 text-sm text-muted-foreground">
            <a href={config.brand.homeHref} className="hover:text-foreground">
              {config.brand.name}
            </a>
            <span>/</span>
            <a href={config.blog.basePath} className="hover:text-foreground">
              {t('blog.title')}
            </a>
            <span>/</span>
            <span className="max-w-[240px] truncate font-medium text-foreground">{post.title}</span>
          </nav>

          <header className="mb-10">
            <div className="mb-5 flex flex-wrap items-center gap-3">
              <Badge variant="secondary" className="px-3 py-1 text-xs font-medium">
                {post.category}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {formatBlogDate(post.publishedAt, locale)}
              </span>
              {typeof post.viewCount === 'number' && (
                <span className="text-sm text-muted-foreground">
                  {post.viewCount} {t('blog.views')}
                </span>
              )}
            </div>
            <h1 className="mb-6 text-3xl font-extrabold leading-tight tracking-tight md:text-4xl">
              {post.title}
            </h1>
          </header>

          <div className="mb-10 overflow-hidden rounded-xl shadow-sm">
            {cover ? (
              <img
                src={cover}
                alt={post.title}
                decoding="async"
                className="max-h-[420px] w-full object-cover"
              />
            ) : (
              <div className={`h-56 w-full ${COVER_GRADIENT}`} aria-hidden />
            )}
          </div>

          <BlogArticleBody html={post.content} />

          <div className="mt-12 border-t border-border pt-8">
            <Button variant="outline" asChild>
              <a href={config.blog.basePath}>{t('blog.backToList')}</a>
            </Button>
          </div>

          {related.length > 0 && (
            <section className="mt-10">
              <h2 className="mb-4 text-lg font-bold">{t('blog.related')}</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {related.map((rp) => {
                  const rpCover = resolveBlogCover(rp, config.blog.defaultCoverFor);
                  return (
                    <a key={rp.id} href={buildBlogUrl(config.blog.basePath, rp)} className="group">
                      <Card className="overflow-hidden transition-shadow hover:shadow-md">
                        <CardContent className="p-3">
                          <div className="flex items-start gap-3">
                            <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-md">
                              {rpCover ? (
                                <img
                                  src={rpCover}
                                  alt={rp.title}
                                  loading="lazy"
                                  decoding="async"
                                  className="absolute inset-0 h-full w-full object-cover"
                                />
                              ) : (
                                <div className={`absolute inset-0 ${COVER_GRADIENT}`} aria-hidden />
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <Badge variant="secondary" className="mb-1 px-1.5 py-0.5 text-[10px]">
                                {rp.category}
                              </Badge>
                              <h3 className="mb-0.5 text-sm font-semibold leading-snug text-foreground group-hover:text-primary">
                                {rp.title}
                              </h3>
                              <p className="text-xs text-muted-foreground">
                                {formatBlogDate(rp.publishedAt, locale)}
                              </p>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </a>
                  );
                })}
              </div>
            </section>
          )}
        </article>

        {recommended.length > 0 && (
          <aside className="hidden lg:block">
            <div className="lg:sticky lg:top-24">
              <h2 className="mb-4 border-b border-border pb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {t('blog.recommended')}
              </h2>
              <div className="space-y-3">
                {recommended.map((rp) => {
                  const rpCover = resolveBlogCover(rp, config.blog.defaultCoverFor);
                  return (
                    <a
                      key={rp.id}
                      href={buildBlogUrl(config.blog.basePath, rp)}
                      className="group block overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-colors hover:border-primary/50"
                    >
                      <div className="relative aspect-video w-full overflow-hidden">
                        {rpCover ? (
                          <img
                            src={rpCover}
                            alt={rp.title}
                            loading="lazy"
                            decoding="async"
                            className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                          />
                        ) : (
                          <div className={`absolute inset-0 ${COVER_GRADIENT}`} aria-hidden />
                        )}
                        <span className="absolute bottom-2 left-2 rounded-full border border-white/15 bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
                          {rp.category}
                        </span>
                      </div>
                      <div className="px-3 py-3">
                        <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-foreground transition-colors group-hover:text-primary">
                          {rp.title}
                        </h3>
                        <p className="mt-1.5 text-[11px] text-muted-foreground">
                          {formatBlogDate(rp.publishedAt, locale)}
                        </p>
                      </div>
                    </a>
                  );
                })}
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
