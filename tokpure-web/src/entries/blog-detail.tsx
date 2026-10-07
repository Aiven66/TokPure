'use client';

/**
 * 博客详情岛屿（blog-detail.html）。
 *
 * 静态站无法用 Next 动态路由，这里从 `location.pathname`（形如
 * `/blog/<slug>-<id8>.html`）解析出最后一段作为文章标识传给 <BlogDetail>：
 * 它支持 SEO slug（slug + id 前 8 位）与旧 UUID 两种形式。
 */

import { BlogDetail } from '@pkg';
import { PkgRoot } from '@/components/PkgRoot';
import { mount, readSiteLocale } from '@/lib/mount';

const BASE_PATH = '/blog';

function readPostId(): string {
  const path = window.location.pathname;
  const rest = path.startsWith(`${BASE_PATH}/`) ? path.slice(BASE_PATH.length + 1) : '';
  return decodeURIComponent(rest);
}

mount(
  'blog-detail-root',
  <PkgRoot initialLocale={readSiteLocale()}>
    <BlogDetail id={readPostId()} />
  </PkgRoot>,
);