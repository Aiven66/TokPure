/**
 * 博客 SEO 构造器（供宿主在自己的 page.tsx / layout.tsx 中调用）。
 *
 * 用法（服务端）：
 *   const meta = buildBlogMetadata(post, { siteUrl, brandName, basePath });
 *   export async function generateMetadata() { return meta; }
 *
 *   const jsonLd = buildBlogPostingJsonLd(post, ctx);
 *   <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
 *
 * 注意：本模块只“导出”普通对象，不依赖 Next 的 `generateMetadata`，因此也可在别处复用。
 * 品牌名 / 站点 URL 全部通过 `ctx` 注入，未提供时省略相关字段，绝不硬编码。
 */

import type { BlogPost } from '../config/types';
import { buildBlogUrl, stripHtml } from './blog-model';

export interface BlogSeoCtx {
  /** 站点根 URL（绝对地址，如 https://example.com），用于生成 canonical / og:url。 */
  siteUrl?: string;
  /** 品牌名，用于 og:siteName / Organization 名称。 */
  brandName?: string;
  /** 前台路由前缀，默认 '/blog'。 */
  basePath?: string;
  /** 默认 OG 图 URL 或 { url, alt }。 */
  defaultOgImage?: string | { url: string; alt?: string };
  /** 组织 logo URL（用于 JSON-LD publisher）。 */
  logoUrl?: string;
  /** 面包屑首页名称，默认 'Home'。 */
  homeLabel?: string;
  /** 面包屑博客名称，默认 'Blog'。 */
  blogLabel?: string;
}

export interface BlogMetadata {
  title: string;
  description: string;
  alternates: { canonical: string };
  openGraph: {
    title: string;
    description: string;
    url: string;
    siteName?: string;
    type: 'article';
    images: Array<{ url: string; alt?: string }>;
    publishedTime?: string;
  };
  twitter: {
    card: 'summary_large_image';
    title: string;
    description: string;
    images: string[];
  };
}

function normalizeBase(basePath?: string): string {
  return (basePath || '/blog').replace(/\/+$/, '');
}

function absUrl(siteUrl: string | undefined, path: string): string {
  if (!siteUrl) return path;
  return `${siteUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

function buildDescription(post: BlogPost): string {
  const fromSummary = (post.summary || '').trim();
  if (fromSummary) return fromSummary.slice(0, 155).trim();
  const text = stripHtml(post.content || '');
  return text.slice(0, 155).trim();
}

function resolveOgImage(
  post: BlogPost,
  ctx?: BlogSeoCtx,
): { url: string; alt?: string } | undefined {
  if (post.coverImage) return { url: post.coverImage, alt: post.title };
  const fallback = ctx?.defaultOgImage;
  if (!fallback) return undefined;
  return typeof fallback === 'string' ? { url: fallback, alt: post.title } : fallback;
}

/**
 * 生成博客详情页的 metadata 对象（title / description / canonical / OG / Twitter）。
 */
export function buildBlogMetadata(post: BlogPost, ctx?: BlogSeoCtx): BlogMetadata {
  const path = buildBlogUrl(normalizeBase(ctx?.basePath), post);
  const url = absUrl(ctx?.siteUrl, path);
  const description = buildDescription(post);
  const image = resolveOgImage(post, ctx);

  return {
    title: post.title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title: post.title,
      description,
      url,
      type: 'article',
      ...(ctx?.brandName ? { siteName: ctx.brandName } : {}),
      ...(image ? { images: [image] } : { images: [] }),
      ...(post.publishedAt ? { publishedTime: post.publishedAt } : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title: post.title,
      description,
      images: image ? [image.url] : [],
    },
  };
}

/**
 * 生成 BlogPosting 结构化数据（schema.org）。
 */
export function buildBlogPostingJsonLd(post: BlogPost, ctx?: BlogSeoCtx) {
  const path = buildBlogUrl(normalizeBase(ctx?.basePath), post);
  const url = absUrl(ctx?.siteUrl, path);
  const description = buildDescription(post);
  const image = resolveOgImage(post, ctx);
  const authorName = post.author || ctx?.brandName;

  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description,
    ...(image ? { image: [image.url] } : {}),
    ...(post.publishedAt ? { datePublished: post.publishedAt } : {}),
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    ...(authorName
      ? { author: { '@type': post.author ? 'Person' : 'Organization', name: authorName } }
      : {}),
    ...(ctx?.brandName
      ? {
          publisher: {
            '@type': 'Organization',
            name: ctx.brandName,
            ...(ctx.logoUrl ? { logo: { '@type': 'ImageObject', url: ctx.logoUrl } } : {}),
          },
        }
      : {}),
  };
}

/**
 * 生成 BreadcrumbList 结构化数据（首页 → 博客列表 → 文章）。
 */
export function buildBreadcrumbJsonLd(basePath: string, post: BlogPost, ctx?: BlogSeoCtx) {
  const base = normalizeBase(basePath || ctx?.basePath);
  const path = buildBlogUrl(base, post);
  const url = absUrl(ctx?.siteUrl, path);

  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: ctx?.homeLabel || ctx?.brandName || 'Home',
        item: absUrl(ctx?.siteUrl, '/'),
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: ctx?.blogLabel || 'Blog',
        item: absUrl(ctx?.siteUrl, base),
      },
      {
        '@type': 'ListItem',
        position: 3,
        name: post.title,
        item: url,
      },
    ],
  };
}