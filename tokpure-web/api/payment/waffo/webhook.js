'use strict';

/**
 * POST /api/payment/waffo/webhook —— Waffo Pancake 支付回调。
 *
 * 签名：RSA-SHA256，头 x-waffo-signature（格式 t=<ts>,v1=<sig>），签的是 `${t}.${rawBody}`。
 * 必须用「原始字节」验签：Vercel 的 req.body 是惰性 getter，本文件刻意不访问它，
 * 直接消费 req 流拿到原文，避免 JSON 重新序列化破坏 RSA 校验。
 *
 * 不锁定环境：SDK 会依次尝试 prod / test 内置公钥，避免环境错配导致合法回调被拒。
 * 落库失败一律回 5xx —— 渠道会重试，避免「已付款但权益没发放」。
 */

const { configured } = require('../../_lib');
const {
  applyPlanPurchase,
  applySubscriptionLapse,
  applySubscriptionRestore,
} = require('../../_payment');
const { sdk } = require('../../_waffo');

/** 读取请求原始字节（不触碰 req.body，保留流）。 */
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!configured()) return res.status(503).json({ error: 'supabase 未配置' });

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-waffo-signature'];

  let event;
  try {
    const { verifyWebhook } = sdk();
    event = verifyWebhook(rawBody, signature);
  } catch (err) {
    console.warn('[Waffo Webhook] 签名校验失败:', err instanceof Error ? err.message : err);
    return res.status(401).json({ error: 'invalid signature' });
  }

  const { WebhookEventType } = sdk();
  const data = event.data || {};
  const meta = data.orderMetadata || {};
  const planId = meta.plan_id || String(data.orderMerchantExternalId || '').split(':').pop() || '';
  const userId = meta.user_id || data.merchantProvidedBuyerIdentity || '';
  const orderId = data.orderId || event.id;

  console.log('[Waffo Webhook] 事件:', event.eventType, orderId);

  try {
    switch (event.eventType) {
      case WebhookEventType.OrderCompleted:
      case WebhookEventType.SubscriptionActivated:
      case WebhookEventType.SubscriptionPaymentSucceeded: {
        const applied = await applyPlanPurchase({ userId, planId, email: data.buyerEmail });
        if (!applied) {
          console.error('[Waffo Webhook] 订阅落库失败，等待重试:', { userId, planId, orderId });
          return res.status(500).json({ error: 'failed to apply subscription' });
        }
        console.log('[Waffo Webhook] 订阅已激活:', { userId, planId, orderId });
        return res.status(200).json({ received: true });
      }

      // 用户发起取消：停止续订，但已付周期内权益仍然有效
      case WebhookEventType.SubscriptionCanceling: {
        if (!userId) break;
        const applied = await applySubscriptionLapse({ userId, reason: 'canceled' });
        if (!applied) return res.status(500).json({ error: 'failed to apply lapse' });
        console.log('[Waffo Webhook] 订阅停止续订:', { userId, orderId });
        return res.status(200).json({ received: true });
      }

      // 订阅彻底终止：立即回收
      case WebhookEventType.SubscriptionCanceled: {
        if (!userId) break;
        const applied = await applySubscriptionLapse({ userId, reason: 'expired' });
        if (!applied) return res.status(500).json({ error: 'failed to apply lapse' });
        console.log('[Waffo Webhook] 订阅已回收:', { userId, orderId });
        return res.status(200).json({ received: true });
      }

      // 撤回取消：必须恢复 active，否则周期末会被误降级
      case WebhookEventType.SubscriptionUncanceled: {
        if (!userId) break;
        const restored = await applySubscriptionRestore(userId);
        console.log('[Waffo Webhook] 订阅已恢复:', { userId, restored, orderId });
        return res.status(200).json({ received: true });
      }

      default:
        console.log('[Waffo Webhook] 未处理的事件类型:', event.eventType);
        return res.status(200).json({ received: true });
    }

    console.warn('[Waffo Webhook] 事件缺少 userId，已跳过:', event.eventType, orderId);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[Waffo Webhook] 处理异常:', err);
    return res.status(500).json({ error: 'webhook processing failed' });
  }
};
