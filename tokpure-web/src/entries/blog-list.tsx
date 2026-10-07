'use client';

/**
 * 博客前台列表岛屿（blog.html）。
 *
 * 复用 public-pkg 的 <BlogList>：分类筛选、分页、多语言分组全部内置，
 * 数据来源为 config.adapters.blog 或 Supabase `blogs` 表（未配置时显示空状态）。
 */

import { BlogList } from '@pkg';
import { PkgRoot } from '@/components/PkgRoot';
import { mount, readSiteLocale } from '@/lib/mount';

mount(
  'blog-root',
  <PkgRoot initialLocale={readSiteLocale()}>
    <BlogList />
  </PkgRoot>,
);