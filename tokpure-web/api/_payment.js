'use strict';

/**
 * /api/payment 服务端公共库（Vercel Node Function · CommonJS）。
 *
 * Creem / Waffo 两个渠道共用同一套「套餐目录 + 订阅落库」逻辑，
 * 只使用 service role 直连 Supabase PostgREST，不引入额外依赖。
 *
 * 套餐 id 与 pricing.html 的 `data-checkout` 一一对应（见 src/entries/pricing.tsx）。
 */

const { rest } = require('./_lib');

/** 可在线购买的订阅档位。 */
const PLANS = {
  'tokpure-pro': { name: 'TokPure Pro', planType: 'pro', amount: 9.9 },
  'tokpure-studio': { name: 'TokPure Studio', planType: 'studio', amount: 29 },
};

/** 计入「已付费」的 plan_type（free 不算）。 */
const PAID_PLAN_TYPES = ['pro', 'studio'];

/** 支持的支付渠道。 */
const PROVIDERS = ['creem', 'waffo'];

/** 支付成功回跳的默认站点。 */
const DEFAULT_ORIGINS = ['https://tokpure.clipopai.com', 'https://tokpure.vercel.app'];

function isPaidPlanId(planId) {
  return typeof planId === 'string' && Object.prototype.hasOwnProperty.call(PLANS, planId);
}

function getPlan(planId) {
  return isPaidPlanId(planId) ? PLANS[planId] : null;
}

function isPaidPlanType(planType) {
  return PAID_PLAN_TYPES.includes(planType);
}

/**
 * 解析支付成功回跳来源。
 * 只接受白名单域名（+ 本地开发），避免被任意 Origin 伪造回跳地址。
 */
function resolveOrigin(candidate) {
  const extra = String(process.env.PAYMENT_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const allowed = [...DEFAULT_ORIGINS, ...extra];
  const origin = typeof candidate === 'string' ? candidate.trim().replace(/\/+$/, '') : '';
  if (origin && allowed.includes(origin)) return origin;
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return origin;
  return allowed[0];
}

/** 读取用户订阅行（每个用户最多一行）。 */
async function getSubscription(userId) {
  const { ok, data } = await rest(
    `subscriptions?select=*&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=1`,
  );
  if (!ok || !Array.isArray(data)) return null;
  return data[0] || null;
}

/**
 * 是否处于「已付费权益期」。
 * active 直接算；canceled 表示已停止续订，但当前已付周期内权益仍然有效。
 */
function isEntitled(sub) {
  if (!sub || !isPaidPlanType(sub.plan_type)) return false;
  if (sub.status === 'active') return true;
  if (sub.status === 'canceled') {
    const end = sub.current_period_end ? Date.parse(sub.current_period_end) : NaN;
    return Number.isFinite(end) && end > Date.now();
  }
  return false;
}

/** 当前时间 + months 个月的 ISO 字符串。 */
function periodEnd(from, months = 1) {
  const d = new Date(from.getTime());
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

/**
 * 支付成功 → 激活订阅（存在则更新，否则插入）。
 * 返回 true 表示已成功落库；false 时调用方应回 5xx 让渠道重试 webhook。
 */
async function applyPlanPurchase(input) {
  const plan = getPlan(input.planId);
  if (!plan || !input.userId) return false;

  const now = new Date();
  const row = {
    plan_type: plan.planType,
    status: 'active',
    plan: input.planId,
    amount: plan.amount,
    current_period_start: now.toISOString(),
    current_period_end: periodEnd(now),
    updated_at: now.toISOString(),
  };
  if (input.email) row.email = String(input.email).toLowerCase();

  const existing = await getSubscription(input.userId);
  if (existing) {
    const { ok, data } = await rest(`subscriptions?id=eq.${encodeURIComponent(existing.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    if (!ok) console.error('[payment] subscription update failed:', data);
    return ok;
  }

  const { ok, data } = await rest('subscriptions', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{ user_id: input.userId, ...row }]),
  });
  if (!ok) console.error('[payment] subscription insert failed:', data);
  return ok;
}

/**
 * 订阅回收。
 *   canceled —— 用户停止续订：保留 plan_type，宽限到已付周期末（period_end 之后 isEntitled 自动失效）。
 *   expired  —— 订阅彻底终止：立即降回 free。
 */
async function applySubscriptionLapse(input) {
  const existing = await getSubscription(input.userId);
  if (!existing) return false;

  const nowIso = new Date().toISOString();
  let patch;
  if (input.reason === 'expired') {
    patch = { status: 'expired', plan_type: 'free', updated_at: nowIso };
  } else {
    const end = existing.current_period_end ? Date.parse(existing.current_period_end) : NaN;
    const withinPaidPeriod = Number.isFinite(end) && end > Date.now();
    patch = {
      status: 'canceled',
      plan_type: withinPaidPeriod ? existing.plan_type : 'free',
      updated_at: nowIso,
    };
  }

  const { ok, data } = await rest(`subscriptions?id=eq.${encodeURIComponent(existing.id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!ok) console.error('[payment] subscription lapse failed:', data);
  return ok;
}

/** 撤回取消（Waffo subscription.uncanceled）→ 恢复 active，否则周期末会被误降级。 */
async function applySubscriptionRestore(userId) {
  const existing = await getSubscription(userId);
  if (!existing || !isPaidPlanType(existing.plan_type)) return false;

  const { ok, data } = await rest(`subscriptions?id=eq.${encodeURIComponent(existing.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'active', updated_at: new Date().toISOString() }),
  });
  if (!ok) console.error('[payment] subscription restore failed:', data);
  return ok;
}

module.exports = {
  PLANS,
  PROVIDERS,
  isPaidPlanId,
  getPlan,
  isPaidPlanType,
  resolveOrigin,
  getSubscription,
  isEntitled,
  applyPlanPurchase,
  applySubscriptionLapse,
  applySubscriptionRestore,
};
