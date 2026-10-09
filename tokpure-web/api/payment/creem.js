'use strict';

/**
 * /api/payment/creem —— Creem 收银台。
 *
 *   POST  创建 checkout（需登录，Bearer token），返回 checkout_url
 *   GET   ?session_id=xxx 查询支付状态
 *
 * 环境变量：CREEM_API_KEY / CREEM_PRODUCT_IDS（JSON: { "tokpure-pro": "prod_xxx" }）
 * 未配置 CREEM_API_KEY 时进入 demo 模式（返回本页回跳地址），方便本地联调。
 */

const { requireUser, configured } = require('../_lib');
const { getPlan, resolveOrigin } = require('../_payment');

const CREEM_API_BASE = 'https://api.creem.io/v1';
const CREEM_TEST_API_BASE = 'https://test-api.creem.io/v1';

function getApiBase(apiKey) {
  return apiKey.startsWith('creem_test_') ? CREEM_TEST_API_BASE : CREEM_API_BASE;
}

/** 主库失败（401）时自动回退到另一套环境，避免 key 环境错配。 */
function apiBases(apiKey) {
  const primary = getApiBase(apiKey);
  const fallback = primary === CREEM_API_BASE ? CREEM_TEST_API_BASE : CREEM_API_BASE;
  return [primary, fallback];
}

function getProductId(planId) {
  const raw = process.env.CREEM_PRODUCT_IDS;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw)[planId];
  } catch {
    console.warn('[Creem] CREEM_PRODUCT_IDS 不是合法 JSON');
    return undefined;
  }
}

async function createCheckout(apiBase, apiKey, body) {
  const res = await fetch(`${apiBase}/checkouts`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function handlePost(req, res) {
  if (!configured()) return res.status(503).json({ error: 'supabase 未配置' });

  const user = await requireUser(req, res);
  if (!user) return;

  const planId = (req.body || {}).planId;
  const plan = getPlan(planId);
  if (!plan) return res.status(400).json({ error: `未知套餐：${planId}` });

  const origin = resolveOrigin((req.body || {}).origin);
  const successUrl = `${origin}/pricing.html?payment=success&plan=${encodeURIComponent(planId)}`;

  const apiKey = process.env.CREEM_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'Creem 未配置：缺少 CREEM_API_KEY' });
  }

  const productId = getProductId(planId);
  if (!productId) {
    return res.status(400).json({ error: `Creem 商品未配置：${planId}` });
  }

  const body = {
    product_id: productId,
    success_url: successUrl,
    metadata: {
      plan_id: planId,
      user_id: user.id,
      source: 'tokpure',
    },
    request_id: `tokpure_${user.id}_${Date.now()}`,
  };
  if (user.email) body.customer = { email: user.email };

  const bases = apiBases(apiKey);
  for (let i = 0; i < bases.length; i += 1) {
    const apiBase = bases[i];
    try {
      const { res: r, data } = await createCheckout(apiBase, apiKey, body);
      if (!r.ok) {
        console.error('[Creem] API error:', r.status, data, { apiBase });
        if (r.status === 401 && i < bases.length - 1) continue;
        return res.status(400).json({ error: data.message || data.error || `Creem API 错误：${r.status}` });
      }
      if (!data.checkout_url) {
        console.error('[Creem] 响应缺少 checkout_url:', data);
        return res.status(502).json({ error: 'Creem 未返回收银台地址' });
      }
      return res.status(200).json({
        checkoutUrl: data.checkout_url,
        sessionId: data.id,
        demo: false,
      });
    } catch (err) {
      console.error('[Creem] 请求失败:', apiBase, err);
      if (i < bases.length - 1) continue;
      return res.status(502).json({ error: 'Creem 连接失败，请稍后重试' });
    }
  }
  return res.status(502).json({ error: 'Creem 全部接口均不可用' });
}

async function handleGet(req, res) {
  const sessionId = (req.query || {}).session_id;
  if (!sessionId) return res.status(400).json({ error: 'session_id 必填' });

  const apiKey = process.env.CREEM_API_KEY;
  if (!apiKey) return res.status(200).json({ status: 'demo', paid: false });

  const bases = apiBases(apiKey);
  for (let i = 0; i < bases.length; i += 1) {
    const apiBase = bases[i];
    try {
      const r = await fetch(`${apiBase}/checkouts?checkout_id=${encodeURIComponent(sessionId)}`, {
        headers: { 'x-api-key': apiKey },
      });
      const data = await r.json().catch(() => ({}));
      if (r.status === 401 && i < bases.length - 1) continue;
      return res.status(200).json({
        status: data.status || 'unknown',
        paid: data.status === 'completed',
      });
    } catch (err) {
      console.error('[Creem] 状态查询失败:', apiBase, err);
      if (i < bases.length - 1) continue;
    }
  }
  return res.status(200).json({ status: 'unknown', paid: false });
}

module.exports = async (req, res) => {
  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  return res.status(405).json({ error: 'method not allowed' });
};
