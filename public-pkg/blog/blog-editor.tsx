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
 * - 编辑视图提供两种模式（`blog.editor.htmlUpload !== false` 时）：
 *   「传统编辑器」= 表单直填、「HTML 上传模式」= 拖入 .html 自动解析 + 封面/配图上传，
 *   见 `./blog-html-upload-form`；
 * - 有意简化：省略源实现的富文本编辑器与一键多语言翻译，正文仍为 HTML 直填。
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Code2, FileText } from 'lucide-react';

import { getSupabaseClient } from '../adapters/supabase/client';
import { readStoredTokens } from '../auth/session-storage';
import type { BlogPost, BlogRow } from '../config/types';
import { usePublicPkg } from '../config/provider';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Skeleton } from '../ui/skeleton';
import { Switch } from '../ui/switch';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { Textarea } from '../ui/textarea';
import { BlogHtmlUploadForm, type BlogHtmlUploadPayload } from './blog-html-upload-form';
import { formatBlogDate, normalizeBlogRow, resolveBlogCover } from './blog-model';

const COVER_GRADIENT = 'bg-gradient-to-br from-primary/20 via-muted to-primary/10';

/** 与 `api/blog/upload.js` 的上限保持一致（3MB）。 */
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

type EditorView = 'list' | 'new' | 'edit';

/** 编辑视图的两种输入方式。 */
type EditorMode = 'form' | 'html';

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
  const [mode, setMode] = useState<EditorMode>('form');
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const [editingPost, setEditingPost] = useState<BlogPost | null>(null);
  const [form, setForm] = useState<BlogFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const getToken = useCallback((): string | null => {
    // 宿主可注入 adapters.auth.getAccessToken；未注入时回退读取 public-pkg
    // 自己持久化的会话 token（storageKeys.accessToken），避免后台写入 401。
    const fromAdapter = config.adapters?.auth?.getAccessToken?.();
    if (fromAdapter) return fromAdapter;
    return readStoredTokens(config).access ?? null;
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
    setMode('form');
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
    setMode('form');
    setView('edit');
  }

  /** 候选分类集合：config.blog.categories → 已加载文章聚合 → defaultCategory。 */
  const categoryCandidates = useMemo(() => {
    if (config.blog.categories && config.blog.categories.length > 0) {
      return config.blog.categories;
    }
    const set = new Set<string>();
    for (const post of posts) if (post.category) set.add(post.category);
    const fallback = config.blog.defaultCategory;
    if (set.size === 0 && fallback) set.add(fallback);
    return Array.from(set);
  }, [config.blog.categories, config.blog.defaultCategory, posts]);

  /** 图片上传端点（`uploadImage` 优先，兼容旧的 `uploadCover`）。 */
  const uploadEndpoint = endpoints?.uploadImage || endpoints?.uploadCover;
  const uploadEnabled = Boolean(uploadEndpoint);

  /** 上传单张图片并返回公开 URL（未配置端点 / 401 / 403 / 413 分别映射文案）。 */
  const uploadImage = useCallback(
    async (file: File, scope: 'cover' | 'gallery'): Promise<string> => {
      if (!uploadEndpoint) throw new Error(t('blog.admin.uploadNotConfigured'));
      if (file.size > MAX_UPLOAD_BYTES) throw new Error(t('blog.admin.fileTooLarge'));

      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error(t('blog.admin.uploadFailed')));
        reader.readAsDataURL(file);
      });

      const res = await fetch(uploadEndpoint, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({
          data,
          mimeType: file.type,
          scope,
          name: file.name,
        }),
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error(t('blog.admin.uploadUnauthorized'));
      }
      if (res.status === 413) throw new Error(t('blog.admin.fileTooLarge'));
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || t('blog.admin.uploadFailed'));
      }
      const json = await res.json().catch(() => ({}));
      if (!json?.url) throw new Error(t('blog.admin.uploadFailed'));
      return String(json.url);
    },
    [uploadEndpoint, authHeaders, t],
  );

  /** 落库：优先 `config.adapters.blog.save`，否则请求 `endpoints.posts`。 */
  async function persistPost(payload: BlogHtmlUploadPayload) {
    const adapter = config.adapters?.blog;
    const basePayload = {
      title: payload.title,
      category: payload.category,
      content: payload.content,
      summary: payload.summary,
      coverImage: payload.coverImage,
      locale: editingPost?.locale ?? locale,
    };

    if (adapter?.save) {
      const result = await adapter.save(
        editingPost
          ? { ...basePayload, isPublished: payload.publish, id: editingPost.id }
          : { ...basePayload, isPublished: payload.publish },
      );
      if (result.error) throw new Error(result.error);
      return;
    }

    if (!endpoints?.posts) throw new Error(t('blog.admin.saveFailed'));
    const body = { ...basePayload, publish: payload.publish };
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

  /** 关闭编辑视图并回到列表。 */
  function finishEditing() {
    setForm(EMPTY_FORM);
    setEditingPost(null);
    setMode('form');
    setView('list');
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
      await persistPost({
        title,
        category: form.category.trim() || config.blog.defaultCategory || '',
        content,
        summary: form.summary.trim(),
        coverImage: form.coverImage.trim(),
        publish: form.publish,
      });
      finishEditing();
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
    const htmlUploadEnabled = config.blog.editor?.htmlUpload !== false;
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold">
            {isEditing ? t('blog.admin.edit') : t('blog.admin.new')}
          </h1>
          <Button variant="ghost" onClick={() => setView('list')} disabled={saving}>
            {t('common.back')}
          </Button>
        </div>

        {htmlUploadEnabled ? (
          <Tabs
            value={mode}
            onValueChange={(next) => setMode(next as EditorMode)}
            className="mb-6"
          >
            <TabsList>
              <TabsTrigger value="form">
                <FileText />
                {t('blog.admin.mode.traditional')}
              </TabsTrigger>
              <TabsTrigger value="html">
                <Code2 />
                {t('blog.admin.mode.html')}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}

        {htmlUploadEnabled && mode === 'html' ? (
          <BlogHtmlUploadForm
            onSubmit={async (payload) => {
              await persistPost(payload);
              finishEditing();
            }}
            uploadImage={uploadImage}
            uploadEnabled={uploadEnabled}
            categoryCandidates={categoryCandidates}
            editing={isEditing}
            initial={
              isEditing
                ? {
                    title: form.title,
                    category: form.category,
                    coverImage: form.coverImage,
                    content: form.content,
                    summary: form.summary,
                  }
                : undefined
            }
          />
        ) : (
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
        )}
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
 * 注（有意简化）：源 `src/components/admin-blog.tsx` 还内置了富文本编辑器、`localStorage`
 * 草稿与一键多语言翻译等能力。这些能力依赖宿主私有接口与内置种子数据，不适合放进可复用包，
 * 故本组件保留 list/new/edit 三视图、标准 CRUD 端点，以及「传统编辑器 / HTML 上传模式」
 * 两种输入方式（后者见 `./blog-html-upload-form`）。如需其余能力，可在宿主侧通过
 * `config.adapters.blog` 注入自定义实现。
 */