/**
 * `<BlogEditor />` —— 博客后台发布组件（客户端，list / new / edit 三视图）。
 *
 * 用法：
 *   import { BlogEditor } from 'public-pkg/blog/blog-editor';
 *   <BlogEditor />
 *
 * 行为：
 * - 列表数据优先 `config.adapters.blog.listAll`，其次内置 Supabase `blogs` 表查询，
 *   最后回落 `config.blog.editor.endpoints.posts` 的 GET；
 * - 保存 / 删除优先 `config.adapters.blog.save|remove`，否则请求
 *   `config.blog.editor.endpoints.posts`（新建 POST、更新 PATCH、删除 `{posts}/{id}` DELETE），
 *   并从 `config.adapters.auth.getAccessToken` 取 Bearer token；
 * - 有意简化：省略源实现的富文本编辑器、HTML 文件上传、封面本地上传与一键多语言翻译，
 *   正文改为 HTML `<textarea>` 直填（见文末注）。
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { getSupabaseClient } from '../adapters/supabase/client';
import type { BlogPost, BlogRow } from '../config/types';
import { usePublicPkg } from '../config/provider';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Skeleton } from '../ui/skeleton';
import { Switch } from '../ui/switch';
import { Textarea } from '../ui/textarea';
import { formatBlogDate, normalizeBlogRow, resolveBlogCover } from './blog-model';

const COVER_GRADIENT = 'bg-gradient-to-br from-primary/20 via-muted to-primary/10';

type EditorView = 'list' | 'new' | 'edit';

interface BlogFormState {
  title: string;
  category: string;
  coverImage: string;
  content: string;
  summary: string;
  publish: boolean;
}

const EMPTY_FORM: BlogFormState = {
  title: '',
  category: '',
  coverImage: '',
  content: '',
  summary: '',
  publish: true,
};

export function BlogEditor() {
  const { config, locale, t } = usePublicPkg();
  const pageSize = config.blog.pageSize;
  const endpoints = config.blog.editor?.endpoints;

  const [view, setView] = useState<EditorView>('list');
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const [editingPost, setEditingPost] = useState<BlogPost | null>(null);
  const [form, setForm] = useState<BlogFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const getToken = useCallback((): string | null => {
    return config.adapters?.auth?.getAccessToken?.() ?? null;
  }, [config]);

  const authHeaders = useCallback(
    (withJson = false): Record<string, string> => {
      const token = getToken();
      return {
        ...(withJson ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
    },
    [getToken],
  );

  const loadPosts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const adapter = config.adapters?.blog;
      if (adapter?.listAll) {
        setPosts(await adapter.listAll());
        return;
      }

      const creds = config.supabase;
      if (creds?.url && creds.anonKey) {
        const client = getSupabaseClient(creds);
        const { data, error: queryError } = await client
          .from('blogs')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1000);
        if (queryError) throw queryError;
        setPosts(((data || []) as BlogRow[]).map(normalizeBlogRow));
        return;
      }

      if (endpoints?.posts) {
        const res = await fetch(endpoints.posts, { headers: authHeaders(), cache: 'no-store' });
        if (res.ok) {
          const json = await res.json().catch(() => ({}));
          setPosts(((json.posts || []) as BlogRow[]).map(normalizeBlogRow));
        }
        return;
      }

      setPosts([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.failed'));
      setPosts([]);
    } finally {
      setLoading(false);
    }
  }, [config, endpoints?.posts, authHeaders, t]);

  useEffect(() => {
    if (view === 'list') {
      setPage(1);
      loadPosts();
    }
  }, [view, loadPosts]);

  const totalPages = Math.max(1, Math.ceil(posts.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paginatedPosts = useMemo(
    () => posts.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [posts, currentPage, pageSize],
  );

  function openNewForm() {
    setEditingPost(null);
    setForm({ ...EMPTY_FORM, category: config.blog.defaultCategory ?? '' });
    setStatus(null);
    setView('new');
  }

  function openEditForm(post: BlogPost) {
    setEditingPost(post);
    setForm({
      title: post.title,
      category: post.category,
      coverImage: post.coverImage || '',
      content: post.content || '',
      summary: post.summary || '',
      publish: post.isPublished !== false,
    });
    setStatus(null);
    setView('edit');
  }

  async function savePost() {
    setStatus(null);
    const title = form.title.trim();
    const content = form.content.trim();
    if (!title || !content) {
      setStatus(t('blog.admin.requiredFields'));
      return;
    }

    setSaving(true);
    try {
      const adapter = config.adapters?.blog;
      const basePayload = {
        title,
        category: form.category.trim() || config.blog.defaultCategory || '',
        content,
        summary: form.summary.trim(),
        coverImage: form.coverImage.trim(),
        locale: editingPost?.locale ?? locale,
      };

      if (adapter?.save) {
        // 适配器按 BlogPost（camelCase）入参
        const result = await adapter.save(
          editingPost
            ? { ...basePayload, isPublished: form.publish, id: editingPost.id }
            : { ...basePayload, isPublished: form.publish },
        );
        if (result.error) throw new Error(result.error);
      } else {
        if (!endpoints?.posts) throw new Error(t('blog.admin.saveFailed'));
        // 服务端 API 使用 `publish` 字段
        const body = { ...basePayload, publish: form.publish };
        const res = await fetch(endpoints.posts, {
          method: editingPost ? 'PATCH' : 'POST',
          headers: authHeaders(true),
          body: JSON.stringify(editingPost ? { id: editingPost.id, ...body } : body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || res.statusText);
        }
      }

      setForm(EMPTY_FORM);
      setEditingPost(null);
      setView('list');
    } catch (err) {
      setStatus(`${t('blog.admin.saveFailed')}: ${err instanceof Error ? err.message : ''}`);
    } finally {
      setSaving(false);
    }
  }

  async function removePost(post: BlogPost) {
    if (typeof window !== 'undefined' && !window.confirm(t('blog.admin.confirmDelete'))) return;
    setError(null);
    try {
      const adapter = config.adapters?.blog;
      if (adapter?.remove) {
        const result = await adapter.remove(post.id);
        if (result.error) throw new Error(result.error);
      } else {
        if (!endpoints?.posts) throw new Error(t('blog.admin.deleteFailed'));
        const res = await fetch(`${endpoints.posts}/${encodeURIComponent(post.id)}`, {
          method: 'DELETE',
          headers: authHeaders(),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || res.statusText);
        }
      }
      await loadPosts();
    } catch (err) {
      setError(`${t('blog.admin.deleteFailed')}: ${err instanceof Error ? err.message : ''}`);
    }
  }

  // ── 编辑 / 新建视图 ──────────────────────────────────────────────
  if (view !== 'list') {
    const isEditing = view === 'edit';
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold">
            {isEditing ? t('blog.admin.edit') : t('blog.admin.new')}
          </h1>
          <Button variant="ghost" onClick={() => setView('list')}>
            {t('common.back')}
          </Button>
        </div>

        <Card>
          <CardContent className="space-y-5 pt-6">
            <div className="grid gap-2">
              <Label htmlFor="blog-editor-title">{t('blog.admin.titleLabel')}</Label>
              <Input
                id="blog-editor-title"
                value={form.title}
                placeholder={t('blog.admin.titlePlaceholder')}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="blog-editor-category">{t('blog.admin.categoryLabel')}</Label>
                <Input
                  id="blog-editor-category"
                  value={form.category}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="blog-editor-cover">{t('blog.admin.coverLabel')}</Label>
                <Input
                  id="blog-editor-cover"
                  value={form.coverImage}
                  placeholder={t('blog.admin.coverPlaceholder')}
                  onChange={(e) => setForm((f) => ({ ...f, coverImage: e.target.value }))}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="blog-editor-summary">{t('blog.admin.summaryLabel')}</Label>
              <Textarea
                id="blog-editor-summary"
                value={form.summary}
                placeholder={t('blog.admin.summaryPlaceholder')}
                rows={2}
                onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="blog-editor-content">{t('blog.admin.contentLabel')}</Label>
              <Textarea
                id="blog-editor-content"
                value={form.content}
                placeholder={t('blog.admin.contentPlaceholder')}
                rows={14}
                className="font-mono text-xs"
                onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
              />
            </div>

            <div className="flex items-center gap-3">
              <Switch
                id="blog-editor-publish"
                checked={form.publish}
                onCheckedChange={(checked) => setForm((f) => ({ ...f, publish: checked }))}
              />
              <Label htmlFor="blog-editor-publish">{t('blog.admin.publish')}</Label>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Button onClick={savePost} disabled={saving}>
                {saving ? t('blog.admin.saving') : t('blog.admin.save')}
              </Button>
              <Button variant="outline" onClick={() => setView('list')} disabled={saving}>
                {t('common.cancel')}
              </Button>
              {status && <span className="text-sm text-muted-foreground">{status}</span>}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── 列表视图 ────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('blog.admin.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('blog.admin.manageSubtitle')}</p>
        </div>
        <Button onClick={openNewForm}>{t('blog.admin.new')}</Button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      {loading ? (
        <Card>
          <CardContent className="space-y-4 pt-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : posts.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <p className="mb-4 text-muted-foreground">{t('blog.admin.empty')}</p>
            <Button onClick={openNewForm}>{t('blog.admin.new')}</Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {paginatedPosts.map((post) => {
                const cover = resolveBlogCover(post, config.blog.defaultCoverFor);
                return (
                  <div
                    key={post.id}
                    className="group flex items-start gap-4 p-5 transition-colors hover:bg-muted/30"
                  >
                    <div className="h-20 w-20 flex-shrink-0 overflow-hidden rounded-md bg-muted">
                      {cover ? (
                        <img src={cover} alt={post.title} className="h-full w-full object-cover" />
                      ) : (
                        <div className={`h-full w-full ${COVER_GRADIENT}`} aria-hidden />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="mb-1 line-clamp-1 text-lg font-semibold">{post.title}</h3>
                      <div className="mb-2 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                        <Badge variant="secondary">{post.category}</Badge>
                        <span>{formatBlogDate(post.publishedAt, locale)}</span>
                        <Badge variant={post.isPublished === false ? 'secondary' : 'default'}>
                          {post.isPublished === false
                            ? t('blog.admin.draft')
                            : t('blog.admin.published')}
                        </Badge>
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                      <Button variant="outline" size="sm" onClick={() => openEditForm(post)}>
                        {t('blog.admin.edit')}
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => removePost(post)}>
                        {t('blog.admin.delete')}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {totalPages > 1 && (
        <div className="mt-6 flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage === 1}
            onClick={() => setPage(currentPage - 1)}
          >
            {t('blog.prev')}
          </Button>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((num) => (
            <Button
              key={num}
              variant={currentPage === num ? 'default' : 'outline'}
              size="sm"
              onClick={() => setPage(num)}
            >
              {num}
            </Button>
          ))}
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage === totalPages}
            onClick={() => setPage(currentPage + 1)}
          >
            {t('blog.next')}
          </Button>
        </div>
      )}
    </div>
  );
}

/*
 * 注（有意简化）：源 `src/components/admin-blog.tsx` 内置了富文本编辑器、HTML 文件上传、
 * 封面本地压缩上传、`localStorage` 草稿、以及一键多语言翻译 / 自动分类等能力。这些能力
 * 依赖宿主私有接口（多语言翻译、自动分类、HTML 发布等）与内置种子数据，不适合放进可复用包，
 * 故本组件仅保留核心的 list/new/edit 三视图与标准 CRUD 端点。如需这些增强能力，可在宿主侧另行扩展或通过 `config.adapters.blog` 注入自定义实现。
 */