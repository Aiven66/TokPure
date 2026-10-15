/**
 * `<BlogHtmlUploadForm />` —— 后台「HTML 上传模式」（客户端）。
 *
 * 用法：
 *   import { BlogHtmlUploadForm } from 'public-pkg/blog/blog-html-upload-form';
 *   <BlogHtmlUploadForm onSubmit={save} uploadImage={upload} uploadEnabled
 *                       categoryCandidates={['Tutorials']} />
 *
 * 行为：
 * - 拖入 `.html` 后自动读出标题 / 分类 / 正文 / 摘要（见 `parseBlogHtml`），全部可再编辑；
 * - 「按文章内容自动提炼分类」勾选后走纯前端启发式打分（见 `inferBlogCategory`），不调用后端；
 * - 封面 / 配图经 `uploadImage` 上传到宿主接口，返回公开 URL；
 * - 「其他配图」按顺序以 `<figure>` 追加到正文末尾（见 `appendImageGallery`）；
 * - 「预览发布效果」用弹窗复刻详情页 DOM，渲染的是即将保存的最终内容串（已清洗）。
 */

'use client';

import * as React from 'react';
import { Eye, FileCode2, ImageIcon, Sparkles, XIcon } from 'lucide-react';

import { usePublicPkg } from '../config/provider';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Dropzone } from '../ui/dropzone';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { BlogArticleBody } from './blog-article-body';
import {
  appendImageGallery,
  formatBlogDate,
  inferBlogCategory,
  parseBlogHtml,
  resolveContentImages,
} from './blog-model';

/** 无封面时的中性渐变（与前台列表/详情一致）。 */
const COVER_GRADIENT = 'bg-gradient-to-br from-primary/20 via-muted to-primary/10';

/** 提交给父级的最终载荷（与 `BlogPost` 字段名一致）。 */
export interface BlogHtmlUploadPayload {
  title: string;
  category: string;
  coverImage: string;
  content: string;
  summary: string;
  publish: boolean;
}

export interface BlogHtmlUploadFormProps {
  /** 保存并跳转；失败时抛错，由本表单展示错误文案。 */
  onSubmit: (payload: BlogHtmlUploadPayload) => Promise<void>;
  /** 上传单张图片并返回公开 URL。 */
  uploadImage: (file: File, scope: 'cover' | 'gallery') => Promise<string>;
  /** 上传端点是否已配置（未配置则禁用拖拽并展示 URL 兜底输入）。 */
  uploadEnabled: boolean;
  /** 候选分类集合（用于 meta 归一化与启发式提炼）。 */
  categoryCandidates: string[];
  /** 编辑已有文章时的初值。 */
  initial?: {
    title: string;
    category: string;
    coverImage: string;
    content: string;
    summary: string;
  };
  /** 是否编辑已有文章（仅影响副标题文案）。 */
  editing?: boolean;
}

interface GalleryItem {
  url: string;
  name: string;
}

/** 读取文件文本（HTML 解析用）。 */
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsText(file);
  });
}

export function BlogHtmlUploadForm({
  onSubmit,
  uploadImage,
  uploadEnabled,
  categoryCandidates,
  initial,
  editing,
}: BlogHtmlUploadFormProps) {
  const { config, locale, t } = usePublicPkg();

  const [htmlName, setHtmlName] = React.useState('');
  const [parsing, setParsing] = React.useState(false);
  const [title, setTitle] = React.useState(initial?.title ?? '');
  const [category, setCategory] = React.useState(
    initial?.category ?? config.blog.defaultCategory ?? '',
  );
  const [autoCategory, setAutoCategory] = React.useState(true);
  const [cover, setCover] = React.useState(initial?.coverImage ?? '');
  const [coverUploading, setCoverUploading] = React.useState(false);
  const [gallery, setGallery] = React.useState<GalleryItem[]>([]);
  const [galleryUploading, setGalleryUploading] = React.useState(false);
  const [content, setContent] = React.useState(initial?.content ?? '');
  const [summary, setSummary] = React.useState(initial?.summary ?? '');
  const [message, setMessage] = React.useState<{ kind: 'error' | 'info'; text: string } | null>(
    null,
  );
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  /** 启发式分类：候选集合 + 兜底分类来自配置。 */
  const heuristicCategory = React.useCallback(
    (nextTitle: string, nextContent: string) =>
      inferBlogCategory(
        { title: nextTitle, content: nextContent },
        { candidates: categoryCandidates, fallback: config.blog.defaultCategory || '' },
      ),
    [categoryCandidates, config.blog.defaultCategory],
  );

  /** 解析 HTML 文件并回填可编辑字段。 */
  const handleHtmlFiles = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setMessage(null);
    setParsing(true);
    try {
      const text = await readFileText(file);
      const parsed = parseBlogHtml(text, { candidates: categoryCandidates });
      setHtmlName(file.name);
      if (parsed.title) setTitle(parsed.title);
      if (parsed.summary) setSummary(parsed.summary);
      setContent(parsed.content);

      // 分类：meta 解析结果为权威 → 否则启发式 → 否则保留原值
      let next = parsed.category;
      if (!next && autoCategory) {
        next = heuristicCategory(parsed.title || title, parsed.content);
      }
      if (next) setCategory(next);

      if (!parsed.content) {
        setMessage({ kind: 'error', text: t('blog.admin.htmlParseFailed') });
      } else if (parsed.relativeImages.length > 0) {
        setMessage({
          kind: 'info',
          text: t('blog.admin.relativeImageWarning', { count: parsed.relativeImages.length }),
        });
      }
    } catch {
      setMessage({ kind: 'error', text: t('blog.admin.htmlParseFailed') });
    } finally {
      setParsing(false);
    }
  };

  const handleAutoCategory = (checked: boolean) => {
    setAutoCategory(checked);
    if (!checked) return;
    const next = heuristicCategory(title, content);
    if (next) setCategory(next);
  };

  const handleCoverFiles = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setMessage(null);
    setCoverUploading(true);
    try {
      setCover(await uploadImage(file, 'cover'));
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : t('blog.admin.uploadFailed'),
      });
    } finally {
      setCoverUploading(false);
    }
  };

  const handleGalleryFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setMessage(null);
    setGalleryUploading(true);
    try {
      const added: GalleryItem[] = [];
      for (const file of files) {
        added.push({ url: await uploadImage(file, 'gallery'), name: file.name });
      }
      setGallery((prev) => [...prev, ...added]);
      setMessage({
        kind: 'info',
        text: t('blog.admin.galleryAdded', { count: added.length }),
      });
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : t('blog.admin.uploadFailed'),
      });
    } finally {
      setGalleryUploading(false);
    }
  };

  /**
   * 封面取用顺序：手传封面 → 第一张配图。
   * （提到 `finalContent` 之前：正文里与封面同一张的图片会被移除，避免重复展示。）
   */
  const coverForSave = cover || gallery[0]?.url || '';

  /**
   * 即将保存的最终正文：
   * 1. 把正文里相对路径的图片按文件名就地换成已上传的 URL（与封面重复的移除）；
   * 2. 未被正文引用的「其他配图」再按上传顺序追加到文末。
   */
  const finalContent = React.useMemo(() => {
    const items = gallery.map((item) => ({ url: item.url, name: item.name }));
    const resolved = resolveContentImages(content, items, { coverUrl: coverForSave });
    const pending = items
      .filter((item) => item.url !== coverForSave && !resolved.includes(item.url))
      .map((item) => ({ url: item.url, alt: title }));
    return appendImageGallery(resolved, pending);
  }, [content, gallery, coverForSave, title]);

  const coverForPreview =
    coverForSave || config.blog.defaultCoverFor?.(category) || '';

  const busy = saving || parsing || coverUploading || galleryUploading;

  const handlePublish = async () => {
    const nextTitle = title.trim();
    const nextContent = finalContent.trim();
    if (!nextTitle || !nextContent) {
      setMessage({ kind: 'error', text: t('blog.admin.requiredFields') });
      return;
    }
    setMessage(null);
    setSaving(true);
    try {
      await onSubmit({
        title: nextTitle,
        category: category.trim() || config.blog.defaultCategory || '',
        coverImage: coverForSave,
        content: nextContent,
        summary: summary.trim(),
        publish: true,
      });
    } catch (err) {
      setMessage({
        kind: 'error',
        text:
          err instanceof Error && err.message
            ? err.message
            : t('blog.admin.saveFailed'),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-6 pt-6">
        <div className="flex items-start gap-3">
          <FileCode2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {t('blog.admin.articleInfo')}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {editing ? t('blog.admin.editSubtitle') : t('blog.admin.newSubtitle')}
            </p>
          </div>
        </div>

        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="blog-html-title">{t('blog.admin.titleLabel')}</Label>
            <span className="text-xs text-muted-foreground">
              {t('blog.admin.htmlTitleAutoHint')}
            </span>
          </div>
          <Input
            id="blog-html-title"
            value={title}
            placeholder={t('blog.admin.htmlTitlePlaceholder')}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>

        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="blog-html-category">{t('blog.admin.categoryLabel')}</Label>
            <span className="text-xs text-muted-foreground">
              {t('blog.admin.categoryAutoHint')}
            </span>
          </div>
          <Input
            id="blog-html-category"
            value={category}
            list="blog-html-category-options"
            onChange={(event) => setCategory(event.target.value)}
          />
          <datalist id="blog-html-category-options">
            {categoryCandidates.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </div>

        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox
            checked={autoCategory}
            onCheckedChange={(checked) => handleAutoCategory(checked === true)}
          />
          <span className="text-sm text-foreground">{t('blog.admin.autoCategoryLabel')}</span>
        </label>

        <div className="grid gap-2">
          <Label>{t('blog.admin.htmlFileTitle')}</Label>
          <Dropzone
            title={t('blog.admin.htmlDropTitle')}
            hint={t('blog.admin.htmlDropHint')}
            accept=".html,.htm,.txt"
            disabled={busy}
            loading={parsing}
            icon={<FileCode2 />}
            onFiles={handleHtmlFiles}
          />
          {htmlName ? (
            <p className="text-xs text-muted-foreground">{htmlName}</p>
          ) : null}
        </div>

        <div className="grid gap-2">
          <Label>{t('blog.admin.coverLabel')}</Label>
          <Dropzone
            title={t('blog.admin.coverDropTitle')}
            hint={t('blog.admin.coverDropHint')}
            accept="image/*"
            disabled={busy || !uploadEnabled}
            loading={coverUploading}
            icon={<ImageIcon />}
            onFiles={handleCoverFiles}
          />
          {cover ? (
            <div className="flex items-center gap-3">
              <img src={cover} alt="" className="h-16 w-24 rounded-md object-cover" />
              <Button variant="ghost" size="sm" onClick={() => setCover('')} disabled={busy}>
                <XIcon />
                {t('blog.admin.removeImage')}
              </Button>
            </div>
          ) : null}
          {!uploadEnabled ? (
            <div className="grid gap-2">
              <p className="text-xs text-muted-foreground">
                {t('blog.admin.uploadNotConfigured')}
              </p>
              <Input
                value={cover}
                placeholder={t('blog.admin.coverPlaceholder')}
                onChange={(event) => setCover(event.target.value)}
              />
            </div>
          ) : null}
        </div>

        <div className="grid gap-2">
          <Label>{t('blog.admin.galleryTitle')}</Label>
          <Dropzone
            title={t('blog.admin.galleryDropTitle')}
            hint={t('blog.admin.galleryDropHint')}
            accept="image/*"
            multiple
            disabled={busy || !uploadEnabled}
            loading={galleryUploading}
            icon={<ImageIcon />}
            onFiles={handleGalleryFiles}
          />
          {gallery.length > 0 ? (
            <div className="flex flex-wrap gap-3">
              {gallery.map((item, index) => (
                <div key={`${item.url}-${index}`} className="relative">
                  <img
                    src={item.url}
                    alt={item.name}
                    className="h-20 w-20 rounded-md object-cover"
                  />
                  <button
                    type="button"
                    aria-label={t('blog.admin.removeImage')}
                    onClick={() =>
                      setGallery((prev) => prev.filter((_, i) => i !== index))
                    }
                    className="absolute -right-1.5 -top-1.5 grid size-5 place-content-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:text-foreground"
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Button
            variant="outline"
            disabled={busy || (!title.trim() && !content.trim())}
            onClick={() => setPreviewOpen(true)}
          >
            <Eye />
            {t('blog.admin.preview')}
          </Button>
          <Button onClick={handlePublish} disabled={busy}>
            <Sparkles />
            {saving ? t('blog.admin.saving') : t('blog.admin.publishArticle')}
          </Button>
          {parsing || coverUploading || galleryUploading ? (
            <span className="text-sm text-muted-foreground">{t('blog.admin.uploading')}</span>
          ) : null}
          {message ? (
            <span
              className={
                message.kind === 'error'
                  ? 'text-sm text-destructive'
                  : 'text-sm text-muted-foreground'
              }
            >
              {message.text}
            </span>
          ) : null}
        </div>
      </CardContent>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('blog.admin.previewTitle')}</DialogTitle>
            <DialogDescription>{title || t('blog.admin.titlePlaceholder')}</DialogDescription>
          </DialogHeader>

          <article>
            <div className="mb-5 flex flex-wrap items-center gap-3">
              <Badge variant="secondary" className="px-3 py-1 text-xs font-medium">
                {category.trim() || config.blog.defaultCategory || ''}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {formatBlogDate(new Date().toISOString(), locale)}
              </span>
            </div>
            <h1 className="mb-5 text-3xl font-extrabold leading-tight tracking-tight">
              {title.trim() || t('blog.admin.titlePlaceholder')}
            </h1>
            <div className="mb-8 overflow-hidden rounded-xl shadow-sm">
              {coverForPreview ? (
                <img
                  src={coverForPreview}
                  alt={title}
                  decoding="async"
                  className="max-h-[320px] w-full object-cover"
                />
              ) : (
                <div className={`h-40 w-full ${COVER_GRADIENT}`} aria-hidden />
              )}
            </div>
            <BlogArticleBody html={finalContent} />
          </article>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
