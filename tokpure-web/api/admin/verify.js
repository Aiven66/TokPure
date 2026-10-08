'use strict';

/**
 * POST /api/admin/verify
 *
 * public-pkg 的 `admin.verifyEndpoint`：服务端校验管理员身份，返回 { isAdmin }。
 * 前端传 Bearer access token，这里用 Supabase 校验 token 后判定角色，
 * 防止前端伪造管理员状态。
 */

const { requireAdmin } = require('../_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ isAdmin: false, error: 'method not allowed' });
  }
  const user = await requireAdmin(req, res);
  if (!user) return;
  return res.status(200).json({ isAdmin: true });
};