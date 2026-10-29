'use client';

/**
 * 博客详情岛屿（blog-detail.html）。
 *
 * 静态站无法用 Next 动态路由，这里从 `location.pathname`（形如
 * `/blog/<slug>-<id8>.html`）解析出最后一段作为文章标识传给 <BlogDetail>：
 * 它支持 SEO slug（slug + id 前 8 位）与旧 UUID 两种形式。
 *
 * 另外：文章内容是客户端从 Supabase 拉取后渲染的，服务端 HTML 里没有标题/描述，
 * 所以拿到文章 DOM 后再把 title / description / canonical / OG / BlogPosting
 * 结构化数据补写到 <head>。只改 meta，不参与任何业务逻辑。
 */

import { BlogDetail } from '@pkg';
import { PkgRoot } from '@/components/PkgRoot';
import { mount, readSiteLocale } from '@/lib/mount';

const BASE_PATH = '/blog';
const SITE_URL = 'https://tokpure.clipopai.com';
const DEFAULT_OG_IMAGE = `${SITE_URL}/assets/og/og-cover.jpg`;

function readPostId(): string {
  const path = window.location.pathname;
  const rest = path.startsWith(`${BASE_PATH}/`) ? path.slice(BASE_PATH.length + 1) : '';
  return decodeURIComponent(rest);
}

/** 按 name / property 更新 head 里的 meta，不存在就创建。 */
function upsertMeta(key: 'name' | 'property', value: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${key}="${value}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(key, value);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function upsertLink(rel: string, href: string): void {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', rel);
    document.head.appendChild(el);
  }
  el.setAttribute('href', href);
}

/** 从正文取一段可用的摘要（跳过代码块与图注）。 */
function buildDescription(article: HTMLElement): string {
  const blocks = Array.from(article.querySelectorAll<HTMLElement>('p, li'));
  for (const block of blocks) {
    const text = (block.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length >= 30) return text.slice(0, 155).trim();
  }
  return '';
}

function applyArticleSeo(): boolean {
  const article = document.querySelector<HTMLElement>('#blog-detail-root article');
  const h1 = article?.querySelector('h1');
  const title = (h1?.textContent || '').replace(/\s+/g, ' ').trim();
  if (!article || !title) return false;

  const path = window.location.pathname || `${BASE_PATH}/`;
  const url = `${SITE_URL}${path}`;
  const description = buildDescription(article) || title;
  const cover = article.querySelector<HTMLImageElement>('img');
  const image = cover?.currentSrc || cover?.src || DEFAULT_OG_IMAGE;

  document.title = `${title} · TokPure 博客`;

  upsertMeta('name', 'description', description);
  upsertLink('canonical', url);
  upsertMeta('property', 'og:type', 'article');
  upsertMeta('property', 'og:title', title);
  upsertMeta('property', 'og:description', description);
  upsertMeta('property', 'og:url', url);
  upsertMeta('property', 'og:image', image);
  upsertMeta('name', 'twitter:card', 'summary_large_image');
  upsertMeta('name', 'twitter:title', title);
  upsertMeta('name', 'twitter:description', description);
  upsertMeta('name', 'twitter:image', image);

  return true;
}

/** 文章是异步渲染的：等 h1 出现后再写 head，成功一次即停止观察。 */
function watchArticleSeo(): void {
  if (applyArticleSeo()) return;
  const root = document.getElementById('blog-detail-root');
  if (!root) return;
  const observer = new MutationObserver(() => {
    if (applyArticleSeo()) observer.disconnect();
  });
  observer.observe(root, { childList: true, subtree: true });
  window.setTimeout(() => observer.disconnect(), 15000);
}

mount(
  'blog-detail-root',
  <PkgRoot initialLocale={readSiteLocale()}>
    <BlogDetail id={readPostId()} />
  </PkgRoot>,
);

watchArticleSeo();
