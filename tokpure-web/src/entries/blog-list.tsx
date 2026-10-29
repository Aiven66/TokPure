'use client';

/**
 * 博客前台列表岛屿（blog.html）。
 *
 * 复用 public-pkg 的 <BlogList>：分类筛选、分页、多语言分组全部内置，
 * 数据来源为 config.adapters.blog 或 Supabase `blogs` 表（未配置时显示空状态）。
 */

import { BlogList } from '@pkg';
import { PkgRoot } from '@/components/PkgRoot';
import { mount, readSiteLocale, dropStaticFallback } from '@/lib/mount';

mount(
  'blog-root',
  <PkgRoot initialLocale={readSiteLocale()}>
    <BlogList />
  </PkgRoot>,
);

// 静态 HTML 里有一份 sr-only 的 h1/h2 供不执行 JS 的爬虫读取；岛屿渲染出自己的 h1 后
// 把兜底标题移除，保持页面只有一个 h1。
const root = document.getElementById('blog-root');
if (root) {
  if (root.querySelector('h1')) dropStaticFallback();
  else {
    const observer = new MutationObserver(() => {
      if (root.querySelector('h1')) {
        dropStaticFallback();
        observer.disconnect();
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    window.setTimeout(() => observer.disconnect(), 15000);
  }
}
