'use strict';

/**
 * POST /api/payment/creem/webhook —— Creem 支付回调。
 *
 * 签名：creem-signature = HMAC-SHA256(rawBody, CREEM_WEBHOOK_SECRET)（hex）。
 * 必须用「原始字节」验签：Vercel 的 req.body 是惰性 getter，本文件刻意不访问它，
 * 直接消费 req 流拿到原文，避免 JSON 重新序列化导致 HMAC 不匹配。
 *
 * 落库失败一律回 5xx —— Creem 会重试，避免「已付款但权益没发放」。
 */

const { createHmac, timingSafeEqual } = require('crypto');
const { configured, rest } = require('../../_lib');
const {
  getPlan,
  getSubscription,
  isEntitled,
  applyPlanPurchase,
  applySubscriptionLapse,
} = require('../../_payment');
const { trackPurchase, trackChurn, resolveClientId } = require('../../_ga4');

/** 读取请求原始字节（不触碰 req.body，保留流）。 */
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function verifySignature(rawBody, signature, secret) {
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
  const received = Buffer.from(String(signature || ''), 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * Creem 不同事件的 metadata 位置不一致：checkout.completed 在顶层，
 * subscription.* 常挂在 checkout / subscription 子对象上。三处都收，避免取空。
 */
function pickMetadata(obj) {
  const out = {};
  [obj.metadata, obj.checkout && obj.checkout.metadata, obj.subscription && obj.subscription.metadata].forEach((src) => {
    if (src && typeof src === 'object') Object.assign(out, src);
  });
  return out;
}

/** metadata 丢失时按邮箱兜底定位用户（profiles.email 有索引）。 */
async function resolveUserIdByEmail(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return null;
  const { ok, data } = await rest(`profiles?select=id&email=eq.${encodeURIComponent(clean)}&limit=1`);
  if (ok && Array.isArray(data) && data[0] && data[0].id) return data[0].id;
  return null;
}

/** plan_id 丢失时，用商品 ID 反查套餐（CREEM_PRODUCT_IDS 是 planId → productId 的映射）。 */
function planIdForProduct(productId) {
  if (!productId) return null;
  let map = {};
  try {
    map = JSON.parse(process.env.CREEM_PRODUCT_IDS || '{}');
  } catch {
    return null;
  }
  for (const key of Object.keys(map)) {
    if (map[key] === productId) return key;
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!configured()) return res.status(503).json({ error: 'supabase 未配置' });

  const rawBody = await readRawBody(req);

  const secret = process.env.CREEM_WEBHOOK_SECRET;
  if (secret) {
    if (!verifySignature(rawBody, req.headers['creem-signature'], secret)) {
      console.warn('[Creem Webhook] 签名校验失败');
      return res.status(401).json({ error: 'invalid signature' });
    }
  } else {
    console.warn('[Creem Webhook] 未配置 CREEM_WEBHOOK_SECRET，已跳过签名校验');
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid json' });
  }

  const eventType = event.eventType || event.type;
  const obj = event.object || {};
  const metadata = pickMetadata(obj);
  const customerEmail =
    (obj.customer && obj.customer.email) ||
    (obj.checkout && obj.checkout.customer && obj.checkout.customer.email) ||
    metadata.email ||
    null;
  console.log('[Creem Webhook] 事件:', eventType, event.id);

  try {
    if (eventType === 'checkout.completed' || eventType === 'subscription.active' || eventType === 'subscription.paid') {
      const orderId = (obj.order && obj.order.id) || obj.last_transaction_id || event.id || `creem_${Date.now()}`;
      // metadata 缺失时先按邮箱找用户，再按商品 ID 反推套餐，避免「已扣款但没开通」
      const userId = metadata.user_id || (await resolveUserIdByEmail(customerEmail));
      const planId = metadata.plan_id || planIdForProduct(obj.product && obj.product.id);
      if (!userId) {
        console.error('[Creem Webhook] 无法定位用户，需人工补发:', { eventType, eventId: event.id, email: customerEmail, orderId });
        return res.status(500).json({ error: 'user not resolvable' });
      }
      // 续订判定必须在落库前取：落库后订阅一定是 active，分不出新购与续费
      const prior = await getSubscription(userId);
      const renewal = isEntitled(prior);
      const applied = await applyPlanPurchase({
        userId,
        planId,
        email: customerEmail,
      });
      if (!applied) {
        console.error('[Creem Webhook] 订阅落库失败，等待重试:', { metadata, userId, planId, orderId });
        return res.status(500).json({ error: 'failed to apply subscription' });
      }
      const plan = getPlan(planId);
      // 付款事件以服务端为准：GA4 按 transaction_id 去重，webhook 重试不会重复计收入
      await trackPurchase({
        clientId: metadata.ga_client_id || resolveClientId(req.headers.cookie, userId),
        userId,
        planId,
        planName: plan && plan.name,
        amount: plan && plan.amount,
        transactionId: orderId,
        provider: 'creem',
        renewal,
      });
      console.log('[Creem Webhook] 订阅已激活:', { userId, planId, orderId, renewal });
      return res.status(200).json({ received: true });
    }

    if (eventType === 'subscription.canceled' || eventType === 'subscription.expired') {
      const userId = metadata.user_id || (await resolveUserIdByEmail(customerEmail));
      if (!userId) {
        console.warn('[Creem Webhook] 缺少 user_id，无法回收:', eventType, event.id, customerEmail);
        return res.status(200).json({ received: true });
      }
      const reason = eventType === 'subscription.expired' ? 'expired' : 'canceled';
      const prior = await getSubscription(userId);
      const applied = await applySubscriptionLapse({ userId, reason });
      if (!applied) {
        console.error('[Creem Webhook] 订阅回收落库失败，等待重试:', { userId, reason });
        return res.status(500).json({ error: 'failed to apply lapse' });
      }
      const planId = metadata.plan_id || planIdForProduct(obj.product && obj.product.id) || (prior && prior.plan);
      const plan = getPlan(planId);
      await trackChurn({
        clientId: metadata.ga_client_id || resolveClientId(req.headers.cookie, userId),
        userId,
        planId: plan ? plan.planType : planId,
        amount: plan && plan.amount,
        provider: 'creem',
        reason,
      });
      console.log('[Creem Webhook] 订阅回收:', { userId, reason });
      return res.status(200).json({ received: true });
    }

    console.log('[Creem Webhook] 未处理的事件类型:', eventType);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[Creem Webhook] 处理异常:', err);
    return res.status(500).json({ error: 'webhook processing failed' });
  }
};
