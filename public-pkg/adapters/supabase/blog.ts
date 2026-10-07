/**
 * Supabase 博客适配器工厂。
 *
 * 用法：
 *   import { createSupabaseBlogAdapter } from 'public-pkg/adapters/supabase/blog';
 *   const blog = createSupabaseBlogAdapter(resolvedConfig);
 *   <PublicPkgProvider config={{ brand, adapters: { blog } }}>...
 *
 * 说明：
 * - 表名固定为 `blogs`，字段与宿主生产表一致（is_published / created_at / parent_id / category / cover_image / locale 等）；
 * - 连接信息来自 `config.supabase`（未配置时使用占位客户端，调用返回空数据，不抛错）；
 * - 只做数据读写，不含任何种子数据与品牌信息。
 */

import type { BlogAdapter, BlogPost, BlogRow, ResolvedConfig } from '../../config/types';
import { normalizeBlogRow } from '../../blog/blog-model';
import { getSupabaseClient } from './client';

/** `BlogPost` → 数据库行（snake_case）。 */
function toRow(post: Partial<BlogPost> & { id?: string }): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (post.id !== undefined) row.id = post.id;
  if (post.title !== undefined) row.title = post.title;
  if (post.category !== undefined) row.category = post.category;
  if (post.content !== undefined) row.content = post.content;
  if (post.summary !== undefined) row.summary = post.summary;
  if (post.coverImage !== undefined) row.cover_image = post.coverImage;
  if (post.author !== undefined) row.author = post.author;
  if (post.isPublished !== undefined) row.is_published = post.isPublished;
  if (post.locale !== undefined) row.locale = post.locale;
  if (post.parentId !== undefined) row.parent_id = post.parentId;
  if (post.publishedAt !== undefined) row.created_at = post.publishedAt;
  row.updated_at = new Date().toISOString();
  return row;
}

export function createSupabaseBlogAdapter(config: ResolvedConfig): BlogAdapter {
  const creds = config.supabase ?? { url: '', anonKey: '' };
  const client = () => getSupabaseClient(creds);

  return {
    async listPublished({ limit, category }) {
      let query = client()
        .from('blogs')
        .select('*')
        .eq('is_published', true)
        .order('created_at', { ascending: false })
        .limit(limit || 60);
      if (category) query = query.eq('category', category);
      const { data, error } = await query;
      if (error) throw error;
      return ((data || []) as BlogRow[]).map(normalizeBlogRow);
    },

    async getById(id) {
      const { data, error } = await client().from('blogs').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data ? normalizeBlogRow(data as BlogRow) : null;
    },

    async listAll() {
      const { data, error } = await client()
        .from('blogs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1000);
      if (error) throw error;
      return ((data || []) as BlogRow[]).map(normalizeBlogRow);
    },

    async save(post) {
      try {
        const row = toRow(post);
        const { data, error } = await client()
          .from('blogs')
          .upsert(row, { onConflict: 'id' })
          .select('*')
          .maybeSingle();
        if (error) return { error: error.message };
        return { error: null, post: data ? normalizeBlogRow(data as BlogRow) : undefined };
      } catch (err) {
        return { error: err instanceof Error ? err.message : 'Save failed' };
      }
    },

    async remove(id) {
      const { error } = await client().from('blogs').delete().eq('id', id);
      return { error: error ? error.message : null };
    },
  };
}