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
const COVER_GRADIENT = 'bg-gradient-to-br from-primary/20 via-muted to-primary/10';

export interface BlogDetailProps {
  /** 路由参数：UUID 或 SEO slug（含 `.html`）。 */
  id: string;
}

export function BlogDetail({ id }: BlogDetailProps) {
  const { config, locale, t } = usePublicPkg();
  const [post, setPost] = useState<BlogPost | null>(null);
  const [related, setRelated] = useState<BlogPost[]>([]);
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

      // 相关文章：同分类优先，最多 4 篇
      let rel: BlogPost[] = [];
      try {
        rel = await fetchPublishedList();
      } catch {
        rel = [];
      }
      const grouped = groupPostsByLocale(rel, locale).filter(
        (p) => String(p.id) !== String(found?.id),
      );
      grouped.sort((a, b) => {
        const ac = found && a.category === found.category ? 0 : 1;
        const bc = found && b.category === found.category ? 0 : 1;
        return ac - bc;
      });
      setRelated(grouped.slice(0, RELATED_LIMIT));
    } catch {
      setPost(null);
      setRelated([]);
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
    <article className="container mx-auto max-w-4xl px-4 py-12 md:py-16">
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

      <div className="blog-article-scope max-w-none" dangerouslySetInnerHTML={{ __html: post.content }} />

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
  );
}