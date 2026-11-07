'use strict';

/**
 * GET /api/entitlement
 *
 * 桌面客户端用它判断「当前账号是否是付费用户」，从而决定是否开放 Pro 专属功能。
 * 只认 `Authorization: Bearer <supabase access_token>`，不读取任何客户端自报的套餐字段，
 * 避免本地改配置就能解锁。
 *
 * 返回：
 *   { paid: boolean, plan: 'free'|'pro'|'studio', status, currentPeriodEnd, email }
 * 未登录：401；服务端未配置 Supabase：503（客户端按「未付费」处理并提示）。
 */

const { configured, bearer, getAuthUser } = require('./_lib');
const { getSubscription, isEntitled } = require('./_payment');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (!configured()) {
    res.status(503).json({ error: 'server_not_configured' });
    return;
  }

  const token = bearer(req);
  if (!token) {
    res.status(401).json({ error: 'unauthorized', paid: false, plan: 'free' });
    return;
  }

  const user = await getAuthUser(token);
  if (!user || !user.id) {
    res.status(401).json({ error: 'invalid_token', paid: false, plan: 'free' });
    return;
  }

  const sub = await getSubscription(user.id);
  const paid = isEntitled(sub);
  res.status(200).json({
    paid,
    plan: paid ? sub.plan_type : 'free',
    status: sub ? sub.status : 'none',
    planId: sub ? sub.plan || null : null,
    currentPeriodEnd: sub ? sub.current_period_end || null : null,
    email: user.email || null,
    checkedAt: new Date().toISOString(),
  });
};
