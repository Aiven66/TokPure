'use strict';

/**
 * /api/blog/posts/[id] —— 博客删除（仅管理员）。
 *
 * public-pkg 的 `blog.editor.endpoints.posts` 删除调用为：
 *   DELETE `${posts}/{id}`，带 Bearer token。
 */

const { requireAdmin, rest, configured } = require('../../_lib');

module.exports = async (req, res) => {
  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!configured()) {
    return res.status(503).json({ error: 'supabase not configured' });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const id = req.query?.id;
  if (!id) return res.status(400).json({ error: 'id is required' });

  const { ok, data } = await rest(`blogs?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
  if (!ok) return res.status(500).json({ error: 'delete failed', detail: data });

  return res.status(200).json({ ok: true });
};