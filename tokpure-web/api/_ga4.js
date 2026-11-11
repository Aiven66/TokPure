'use strict';

/**
 * GA4 Measurement Protocol 服务端上报（付费漏斗的唯一权威口径）。
 *
 * 为什么放在服务端：支付回调不依赖浏览器，广告拦截、跳回页面失败都不会丢单；
 * 客户端只负责 begin_checkout 之前的漏斗，purchase 一律以 webhook 为准。
 *
 * 环境变量：
 *   GA4_MEASUREMENT_ID  G-XXXXXXX（与页面 gtag 的 ID 相同）
 *   GA4_API_SECRET      GA4 后台「管理 → 数据流 → Measurement Protocol API secret」
 * 未配置时所有函数静默返回 false，不影响支付主流程。
 */

const ENDPOINT = 'https://www.google-analytics.com/mp/collect';
const TIMEOUT_MS = 3000;

function configured() {
  return Boolean(process.env.GA4_MEASUREMENT_ID && process.env.GA4_API_SECRET);
}

/** 从 Cookie 里取 GA4 client_id（`_ga=GA1.1.<随机>.<时间戳>`）。 */
function readGaClientId(cookieHeader) {
  const m = /(?:^|;\s*)_ga=GA\d\.\d\.(\d{1,20}\.\d{1,20})/.exec(String(cookieHeader || ''));
  return m ? m[1] : '';
}

/** 没有 _ga 时用 user_id 生成稳定的伪 client_id，保证事件不丢（只是归因弱一些）。 */
function fallbackClientId(seed) {
  const s = String(seed || 'anonymous');
  let h1 = 2166136261;
  let h2 = 5381;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619);
    h2 = (Math.imul(h2, 33) + c) | 0;
  }
  return `${h1 >>> 0}.${Math.abs(h2) >>> 0}`;
}

function resolveClientId(cookieHeader, userId) {
  return readGaClientId(cookieHeader) || fallbackClientId(userId);
}

/** 组装单条事件（engagement_time_msec 必填，否则事件不会进入报表）。 */
function buildEvent(name, params) {
  return {
    name,
    params: {
      engagement_time_msec: 1,
      ...params,
    },
  };
}

/** 统一 POST，永不抛错：埋点失败绝不能影响支付回执。 */
async function send({ clientId, userId, events }) {
  if (!configured() || !clientId || !Array.isArray(events) || events.length === 0) return false;
  const url =
    `${ENDPOINT}?measurement_id=${encodeURIComponent(process.env.GA4_MEASUREMENT_ID)}` +
    `&api_secret=${encodeURIComponent(process.env.GA4_API_SECRET)}`;
  const body = { client_id: clientId, events };
  if (userId) body.user_id = String(userId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn('[GA4] Measurement Protocol 返回', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[GA4] Measurement Protocol 失败:', err instanceof Error ? err.message : err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 单件商品结构（GA4 电商事件要求 items）。 */
function item({ planId, planName, amount, provider, renewal }) {
  return {
    item_id: planId,
    item_name: planName || planId,
    item_category: renewal ? 'renewal' : 'subscription',
    item_variant: provider,
    price: Number(amount) || 0,
    quantity: 1,
  };
}

/**
 * 付款成功 → purchase。
 * transaction_id 由渠道订单号提供，GA4 会按它去重，webhook 重试不会重复计数。
 */
async function trackPurchase({
  clientId,
  userId,
  planId,
  planName,
  amount,
  currency = 'USD',
  transactionId,
  provider,
  renewal = false,
}) {
  return send({
    clientId: clientId || fallbackClientId(userId),
    userId,
    events: [
      buildEvent('purchase', {
        transaction_id: String(transactionId || `unknown_${Date.now()}`),
        currency,
        value: Number(amount) || 0,
        affiliation: provider || 'unknown',
        items: [item({ planId, planName, amount, provider, renewal })],
      }),
    ],
  });
}

/** 退款 → refund（GA4 用 transaction_id 与原订单关联）。 */
async function trackRefund({
  clientId,
  userId,
  planId,
  planName,
  amount,
  currency = 'USD',
  transactionId,
  provider,
}) {
  return send({
    clientId: clientId || fallbackClientId(userId),
    userId,
    events: [
      buildEvent('refund', {
        transaction_id: String(transactionId || ''),
        currency,
        value: Number(amount) || 0,
        affiliation: provider || 'unknown',
        items: [item({ planId, planName, amount, provider })],
      }),
    ],
  });
}

/** 订阅停止续订 / 到期（用于看流失，不影响收入口径）。 */
async function trackChurn({ clientId, userId, planId, amount, provider, reason }) {
  return send({
    clientId: clientId || fallbackClientId(userId),
    userId,
    events: [
      buildEvent('subscription_churn', {
        plan_id: planId || 'unknown',
        value: Number(amount) || 0,
        currency: 'USD',
        affiliation: provider || 'unknown',
        reason: reason || 'canceled',
      }),
    ],
  });
}

module.exports = {
  configured,
  readGaClientId,
  fallbackClientId,
  resolveClientId,
  buildEvent,
  send,
  trackPurchase,
  trackRefund,
  trackChurn,
};
