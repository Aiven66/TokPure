'use strict';

/**
 * /api/blog/posts —— 博客后台读写（仅管理员）。
 *
 * public-pkg 的 `blog.editor.endpoints.posts`：
 *   GET    列出全部文章（含草稿）
 *   POST   新建（body.publish → is_published）
 *   PATCH  更新（body.id 必填）
 * 删除走同级动态路由 /api/blog/posts/[id]。
 *
 * 前台列表/详情不经过这里，由浏览器直连 Supabase 读 `blogs`
 * （RLS 只放行 is_published = true）。
 */

const { requireAdmin, rest, configured } = require('../_lib');

/** BlogPost（camelCase）→ blogs 行（snake_case）。 */
function toRow(body = {}) {
  const row = {};
  if (body.title !== undefined) row.title = body.title;
  if (body.category !== undefined) row.category = body.category;
  if (body.content !== undefined) row.content = body.content;
  if (body.summary !== undefined) row.summary = body.summary;
  if (body.coverImage !== undefined) row.cover_image = body.coverImage;
  if (body.author !== undefined) row.author = body.author;
  if (body.locale !== undefined) row.locale = body.locale;
  if (body.slug !== undefined) row.slug = body.slug;
  if (body.parentId !== undefined) row.parent_id = body.parentId;
  if (body.publish !== undefined) row.is_published = !!body.publish;
  if (body.isPublished !== undefined) row.is_published = !!body.isPublished;
  return row;
}

module.exports = async (req, res) => {
  if (!configured()) {
    return res.status(503).json({ error: 'supabase not configured' });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET') {
    const { ok, data } = await rest('blogs?select=*&order=created_at.desc&limit=1000');
    if (!ok) return res.status(500).json({ error: 'query failed', detail: data });
    return res.status(200).json({ posts: data });
  }

  if (req.method === 'POST' || req.method === 'PATCH') {
    const body = req.body || {};
    const row = toRow(body);

    if (req.method === 'POST') {
      const { ok, data } = await rest('blogs', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify([row]),
      });
      if (!ok) return res.status(500).json({ error: 'insert failed', detail: data });
      return res.status(201).json({ ok: true, post: Array.isArray(data) ? data[0] : data });
    }

    if (!body.id) return res.status(400).json({ error: 'id is required for update' });
    const { ok, data } = await rest(`blogs?id=eq.${encodeURIComponent(body.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    if (!ok) return res.status(500).json({ error: 'update failed', detail: data });
    return res.status(200).json({ ok: true, post: Array.isArray(data) ? data[0] : data });
  }

  return res.status(405).json({ error: 'method not allowed' });
};