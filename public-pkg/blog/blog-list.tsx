/**
 * `<BlogList />` —— 博客前台列表组件（客户端）。
 *
 * 用法：
 *   import { BlogList } from 'public-pkg/blog/blog-list';
 *   <BlogList />
 *
 * 行为：
 * - 通过 `config.adapters.blog.listPublished` 取数；未注入适配器时回落 Supabase `blogs` 表查询；
 * - 多语言分组（当前语言优先）、分类筛选、分页（`config.blog.pageSize`）；
 * - 链接前缀用 `config.blog.basePath`，封面兜底用 `config.blog.defaultCoverFor`，无封面时渲染中性渐变。
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { getSupabaseClient } from '../adapters/supabase/client';
import type { BlogPost, BlogRow } from '../config/types';
import { usePublicPkg } from '../config/provider';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Skeleton } from '../ui/skeleton';
import {
  buildBlogUrl,
  formatBlogDate,
  groupPostsByLocale,
  normalizeBlogRow,
  resolveBlogCover,
} from './blog-model';

/** 单次拉取上限：足够覆盖分页，避免全表扫描。 */
const FETCH_LIMIT = 60;

/** 无封面时的中性渐变（纯 CSS，不依赖外部图片）。 */
const COVER_GRADIENT = 'bg-gradient-to-br from-primary/20 via-muted to-primary/10';

export function BlogList() {
  const { config, locale, t } = usePublicPkg();
  const pageSize = config.blog.pageSize;

  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const loadPosts = useCallback(async () => {
    setLoading(true);
    try {
      const adapter = config.adapters?.blog;
      if (adapter?.listPublished) {
        const data = await adapter.listPublished({ limit: FETCH_LIMIT });
        setPosts(groupPostsByLocale(data, locale));
        return;
      }

      const creds = config.supabase;
      if (!creds?.url || !creds.anonKey) {
        setPosts([]);
        return;
      }
      const client = getSupabaseClient(creds);
      const { data, error } = await client
        .from('blogs')
        .select('*')
        .eq('is_published', true)
        .order('created_at', { ascending: false })
        .limit(FETCH_LIMIT);
      if (error) throw error;
      const normalized = ((data || []) as BlogRow[]).map(normalizeBlogRow);
      setPosts(groupPostsByLocale(normalized, locale));
    } catch {
      setPosts([]);
    } finally {
      setLoading(false);
    }
  }, [config, locale]);

  useEffect(() => {
    loadPosts();
  }, [loadPosts]);

  // 分类选项：优先 config.blog.categories，否则从文章数据聚合
  const categories = useMemo(() => {
    if (config.blog.categories && config.blog.categories.length > 0) {
      return config.blog.categories;
    }
    const set = new Set<string>();
    for (const post of posts) if (post.category) set.add(post.category);
    return Array.from(set);
  }, [config.blog.categories, posts]);

  const filteredPosts = useMemo(
    () => (selectedCategory ? posts.filter((p) => p.category === selectedCategory) : posts),
    [posts, selectedCategory],
  );

  const totalPages = Math.max(1, Math.ceil(filteredPosts.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paginatedPosts = filteredPosts.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  const handleCategory = (category: string | null) => {
    setSelectedCategory(category);
    setPage(1);
  };

  const handlePageChange = (next: number) => {
    setPage(next);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (loading) {
    return (
      <div className="container mx-auto max-w-4xl px-4 py-16">
        <Skeleton className="mb-4 h-9 w-48" />
        <Skeleton className="mb-12 h-4 w-72" />
        <div className="grid gap-8">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="overflow-hidden">
              <div className="md:flex">
                <Skeleton className="h-48 md:w-1/3" />
                <div className="p-6 md:w-2/3">
                  <Skeleton className="mb-3 h-4 w-24" />
                  <Skeleton className="mb-4 h-6 w-3/4" />
                  <Skeleton className="mb-2 h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto max-w-4xl px-4 py-16">
      <h1 className="mb-4 text-4xl font-bold">{t('blog.title')}</h1>
      <p className="mb-8 text-muted-foreground">{t('blog.subtitle')}</p>

      {categories.length > 0 && (
        <div className="mb-12">
          <div className="mb-3 flex items-center gap-2">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t('blog.filterByCategory')}
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>
          <div className="flex flex-wrap gap-2.5">
            <Button
              variant={selectedCategory === null ? 'default' : 'outline'}
              size="sm"
              onClick={() => handleCategory(null)}
              className="rounded-full"
            >
              {t('blog.allCategories')}
              <span className="ml-1 text-xs opacity-70">{posts.length}</span>
            </Button>
            {categories.map((category) => (
              <Button
                key={category}
                variant={selectedCategory === category ? 'default' : 'outline'}
                size="sm"
                onClick={() => handleCategory(category)}
                className="rounded-full"
              >
                {category}
                <span className="ml-1 text-xs opacity-70">
                  {posts.filter((p) => p.category === category).length}
                </span>
              </Button>
            ))}
          </div>
        </div>
      )}

      {filteredPosts.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-muted-foreground">{t('blog.empty')}</p>
        </div>
      ) : (
        <>
          <div className="grid gap-8">
            {paginatedPosts.map((post) => {
              const url = buildBlogUrl(config.blog.basePath, post);
              const cover = resolveBlogCover(post, config.blog.defaultCoverFor);
              return (
                <Card key={post.id} className="overflow-hidden transition-shadow hover:shadow-lg">
                  <div className="md:flex">
                    <div className="relative h-48 md:min-h-[240px] md:w-1/3">
                      {cover ? (
                        <img
                          src={cover}
                          alt={post.title}
                          loading="lazy"
                          decoding="async"
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      ) : (
                        <div className={`absolute inset-0 ${COVER_GRADIENT}`} aria-hidden />
                      )}
                    </div>
                    <div className="p-6 md:w-2/3">
                      <div className="mb-3 flex items-center gap-4">
                        <Badge variant="secondary">{post.category}</Badge>
                        <span className="text-sm text-muted-foreground">
                          {formatBlogDate(post.publishedAt, locale)}
                        </span>
                      </div>
                      <h2 className="mb-3 text-2xl font-bold">
                        <a href={url} className="text-primary transition-colors hover:text-primary/80">
                          {post.title}
                        </a>
                      </h2>
                      <p className="mb-4 line-clamp-3 text-muted-foreground">
                        {(post.summary || '').slice(0, 200)}
                      </p>
                      <Button variant="link" className="h-auto p-0" asChild>
                        <a href={url}>{t('blog.readMore')}</a>
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div className="mt-12 flex flex-wrap items-center justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage === 1}
                onClick={() => handlePageChange(currentPage - 1)}
              >
                {t('blog.prev')}
              </Button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((num) => (
                <Button
                  key={num}
                  variant={currentPage === num ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => handlePageChange(num)}
                >
                  {num}
                </Button>
              ))}
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage === totalPages}
                onClick={() => handlePageChange(currentPage + 1)}
              >
                {t('blog.next')}
              </Button>
              <span className="ml-3 text-sm text-muted-foreground">
                {t('blog.pageInfo', {
                  page: currentPage,
                  total: totalPages,
                  count: filteredPosts.length,
                })}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}