'use strict';

/**
 * /api/payment/waffo —— Waffo Pancake 收银台。
 *
 *   POST  创建 checkout（需登录），返回 checkout_url
 *   GET   ?user_id=xxx 查询订阅权益状态
 *
 * 环境变量：WAFFO_MERCHANT_ID / WAFFO_PRIVATE_KEY / WAFFO_PRODUCT_IDS（JSON）
 */

const { requireUser, configured } = require('../_lib');
const { getPlan, resolveOrigin, getSubscription, isEntitled } = require('../_payment');
const { isConfigured, getClient, getProductId } = require('../_waffo');

async function handlePost(req, res) {
  if (!configured()) return res.status(503).json({ error: 'supabase 未配置' });

  const user = await requireUser(req, res);
  if (!user) return;

  const planId = (req.body || {}).planId;
  if (!getPlan(planId)) return res.status(400).json({ error: `未知套餐：${planId}` });

  if (!isConfigured()) {
    return res.status(503).json({ error: 'Waffo 未配置：缺少 WAFFO_MERCHANT_ID / WAFFO_PRIVATE_KEY' });
  }

  const productId = getProductId(planId);
  if (!productId) {
    return res.status(400).json({ error: `Waffo 商品未配置：${planId}` });
  }

  const origin = resolveOrigin((req.body || {}).origin);
  const successUrl = `${origin}/pricing.html?payment=success&plan=${encodeURIComponent(planId)}`;

  try {
    const client = getClient();
    // authenticated checkout：buyerIdentity 绑定我们的 userId，metadata 会原样回传到 webhook
    const result = await client.checkout.authenticated.create({
      productId,
      currency: 'USD',
      buyerIdentity: user.id,
      buyerEmail: user.email,
      successUrl,
      metadata: { plan_id: planId, user_id: user.id, source: 'tokpure' },
      orderMerchantExternalId: `tokpure:${user.id}:${planId}`.slice(0, 128),
    });

    if (!result || !result.checkoutUrl) {
      console.error('[Waffo] 响应缺少 checkoutUrl:', result);
      return res.status(502).json({ error: 'Waffo 未返回收银台地址' });
    }

    return res.status(200).json({
      checkoutUrl: result.checkoutUrl,
      sessionId: result.sessionId,
      demo: false,
    });
  } catch (err) {
    console.error('[Waffo] 创建收银台失败:', err);
    const message = err instanceof Error ? err.message : 'Waffo 收银台创建失败';
    return res.status(502).json({ error: message });
  }
}

async function handleGet(req, res) {
  if (!configured()) return res.status(503).json({ error: 'supabase 未配置' });

  const user = await requireUser(req, res);
  if (!user) return;

  const sub = await getSubscription(user.id);
  return res.status(200).json({
    status: sub ? sub.status : 'none',
    plan: sub ? sub.plan : null,
    paid: isEntitled(sub),
  });
}

module.exports = async (req, res) => {
  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  return res.status(405).json({ error: 'method not allowed' });
};
