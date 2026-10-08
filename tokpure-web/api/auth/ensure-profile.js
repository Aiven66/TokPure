'use strict';

/**
 * POST /api/auth/ensure-profile
 *
 * public-pkg 的 `auth.endpoints.ensureProfile`：注册/登录后幂等补建业务档案
 * （users / credits / subscriptions）。用 service role 写入，绕过 RLS。
 *
 * 幂等策略：users 行已存在则直接返回，绝不覆盖已有积分与角色。
 */

const { requireUser, rest, ADMIN_EMAILS, INITIAL_CREDITS, configured } = require('../_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!configured()) {
    return res.status(503).json({ error: 'supabase not configured' });
  }

  const user = await requireUser(req, res);
  if (!user) return;

  const email = String(user.email || '').toLowerCase();
  const name =
    (user.user_metadata && typeof user.user_metadata.name === 'string' && user.user_metadata.name) ||
    email.split('@')[0];
  const role = ADMIN_EMAILS.includes(email) ? 'admin' : 'user';

  // 已建档：直接返回，避免重置积分 / 覆盖管理员角色。
  const existing = await rest(`users?select=id&id=eq.${encodeURIComponent(user.id)}&limit=1`);
  if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
    return res.status(200).json({ ok: true, created: false });
  }

  const inserted = await rest('users', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ id: user.id, email, name, role, credits: INITIAL_CREDITS }]),
  });
  if (!inserted.ok) {
    return res.status(500).json({ error: 'failed to create user profile', detail: inserted.data });
  }

  await rest('credits', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ user_id: user.id, balance: INITIAL_CREDITS }]),
  });

  await rest('subscriptions', {
    method: 'POST',
    body: JSON.stringify([{ user_id: user.id, plan_type: 'free', status: 'active', email }]),
  });

  return res.status(200).json({ ok: true, created: true });
};