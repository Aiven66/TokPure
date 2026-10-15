/**
 * `<BlogArticleBody html />` —— 博客正文渲染（客户端）。
 *
 * 用法：
 *   import { BlogArticleBody } from 'public-pkg/blog/blog-article-body';
 *   <BlogArticleBody html={post.content} />
 *
 * 说明：
 * - 统一 `blog-article-scope` 作用域，排版样式随组件打包（见 ./blog-article.css），
 *   不依赖宿主静态样式表，嵌套路由（如 /blog/<slug>.html）下同样生效；
 * - 渲染前一律经 `sanitizeBlogHtml` 清洗（详情页与后台预览共用同一入口）。
 */

'use client';

import { cn } from '../lib/utils';
import { sanitizeBlogHtml } from './blog-model';
import './blog-article.css';

export interface BlogArticleBodyProps {
  /** 正文 HTML（未清洗也可以，组件内部会清洗）。 */
  html: string;
  className?: string;
}

export function BlogArticleBody({ html, className }: BlogArticleBodyProps) {
  return (
    <div
      className={cn('blog-article-scope max-w-none', className)}
      dangerouslySetInnerHTML={{ __html: sanitizeBlogHtml(html || '') }}
    />
  );
}
