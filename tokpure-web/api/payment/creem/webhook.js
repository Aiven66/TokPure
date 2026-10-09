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
const { configured } = require('../../_lib');
const { applyPlanPurchase, applySubscriptionLapse } = require('../../_payment');

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
  const metadata = obj.metadata || {};
  console.log('[Creem Webhook] 事件:', eventType, event.id);

  try {
    if (eventType === 'checkout.completed' || eventType === 'subscription.active' || eventType === 'subscription.paid') {
      const orderId = (obj.order && obj.order.id) || obj.last_transaction_id || event.id || `creem_${Date.now()}`;
      const applied = await applyPlanPurchase({
        userId: metadata.user_id,
        planId: metadata.plan_id,
        email: obj.customer && obj.customer.email,
      });
      if (!applied) {
        console.error('[Creem Webhook] 订阅落库失败，等待重试:', { metadata, orderId });
        return res.status(500).json({ error: 'failed to apply subscription' });
      }
      console.log('[Creem Webhook] 订阅已激活:', { userId: metadata.user_id, planId: metadata.plan_id, orderId });
      return res.status(200).json({ received: true });
    }

    if (eventType === 'subscription.canceled' || eventType === 'subscription.expired') {
      if (!metadata.user_id) {
        console.warn('[Creem Webhook] 缺少 user_id，无法回收:', eventType, event.id);
        return res.status(200).json({ received: true });
      }
      const reason = eventType === 'subscription.expired' ? 'expired' : 'canceled';
      const applied = await applySubscriptionLapse({ userId: metadata.user_id, reason });
      if (!applied) {
        console.error('[Creem Webhook] 订阅回收落库失败，等待重试:', { userId: metadata.user_id, reason });
        return res.status(500).json({ error: 'failed to apply lapse' });
      }
      console.log('[Creem Webhook] 订阅回收:', { userId: metadata.user_id, reason });
      return res.status(200).json({ received: true });
    }

    console.log('[Creem Webhook] 未处理的事件类型:', eventType);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[Creem Webhook] 处理异常:', err);
    return res.status(500).json({ error: 'webhook processing failed' });
  }
};
