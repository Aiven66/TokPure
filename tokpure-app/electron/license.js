'use strict';

/**
 * 桌面端商业授权（3.9.38）。
 *
 * 目标：让 Pro 专属功能只对付费账号开放，同时不破坏「全离线」的定位。
 *
 * 判定来源只有一个：官网 `/api/entitlement`（服务端用 service role 读 subscriptions，
 * 客户端无法伪造）。本地只做**缓存 + 短期宽限**：
 *   - 每次刷新成功都落盘 plan/paid/checkedAt；
 *   - 后续离线启动时直接读缓存，付费用户在 7 天宽限期内仍可用（断网/出差不受影响）；
 *   - 超过宽限期且无法联网校验 → 回落到 free，并提示「需要联网校验授权」。
 * 这样既不会出现「断网就锁死付费功能」，也不会让本地改一个 json 就永久解锁。
 */

const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');
const auth = require('./auth');

/** 付费功能归属的套餐；free 之外的都算付费。 */
const PAID_PLANS = ['pro', 'studio'];
/** 联网校验失败时，付费权益的最长离线宽限期。 */
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** 正常情况下的自动刷新间隔。 */
const REFRESH_MS = 6 * 60 * 60 * 1000;
/** 单次请求超时。 */
const TIMEOUT_MS = 8000;

let cache = null;
let filePath = null;
let timer = null;
let inflight = null;
const handlers = [];

function ensurePath() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'license.json');
  return filePath;
}

function freeState(reason) {
  return {
    paid: false,
    plan: 'free',
    status: 'none',
    currentPeriodEnd: null,
    email: '',
    checkedAt: 0,
    reason: reason || 'anonymous',
  };
}

function readDisk() {
  if (cache) return cache;
  ensurePath();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    cache = {
      paid: Boolean(raw.paid),
      plan: typeof raw.plan === 'string' ? raw.plan : 'free',
      status: typeof raw.status === 'string' ? raw.status : 'none',
      currentPeriodEnd: raw.currentPeriodEnd || null,
      email: raw.email || '',
      checkedAt: Number(raw.checkedAt) || 0,
      reason: raw.reason || 'cache',
    };
  } catch (_) {
    cache = freeState('no_cache');
  }
  return cache;
}

function writeDisk(state) {
  cache = state;
  ensurePath();
  try {
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (_) {
    /* 落盘失败只影响下次启动，内存态仍然正确 */
  }
}

/** 对外状态：把「离线宽限期」算进 paid，避免断网瞬间掉权限。 */
function effective(state) {
  if (!state) return freeState('empty');
  if (!state.paid) return { ...state, paid: false, plan: 'free' };
  const last = state.checkedAt || 0;
  if (Date.now() - last > GRACE_MS) {
    return { ...state, paid: false, plan: 'free', reason: 'grace_expired' };
  }
  return state;
}

function emit() {
  const state = effective(readDisk());
  handlers.forEach((fn) => {
    try {
      fn(state);
    } catch (_) {
      /* 单个订阅者异常不影响其它 */
    }
  });
  return state;
}

function get() {
  return effective(readDisk());
}

function apiBase() {
  return `${auth.WEB_BASE}/api/entitlement`;
}

async function query(token) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(apiBase(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      return {
        ok: true,
        paid: Boolean(data.paid),
        plan: typeof data.plan === 'string' ? data.plan : 'free',
        status: typeof data.status === 'string' ? data.status : 'none',
        currentPeriodEnd: data.currentPeriodEnd || null,
        email: data.email || '',
      };
    }
    if (res.status === 401) return { ok: true, paid: false, plan: 'free', status: 'unauthorized' };
    return { ok: false, status: `http_${res.status}` };
  } catch (_) {
    return { ok: false, status: 'network' };
  } finally {
    clearTimeout(t);
  }
}

/**
 * 联网刷新授权。返回最新状态。
 * 网络失败时**不改动** paid，只把 reason 标成 offline，交给宽限期兜底。
 */
function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    const session = auth.getSession();
    if (!session || !session.token) {
      writeDisk(freeState('anonymous'));
      return emit();
    }
    const r = await query(session.token);
    const prev = readDisk();
    if (r.ok) {
      writeDisk({
        paid: r.paid && PAID_PLANS.includes(r.plan),
        plan: r.plan,
        status: r.status,
        currentPeriodEnd: r.currentPeriodEnd,
        email: r.email || session.email || '',
        checkedAt: Date.now(),
        reason: 'server',
      });
    } else {
      writeDisk({
        ...prev,
        email: session.email || prev.email || '',
        reason: prev.paid ? 'offline' : 'offline_free',
      });
    }
    return emit();
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

function start() {
  auth.onSessionChange((session) => {
    if (!session) {
      writeDisk(freeState('logged_out'));
      emit();
      return;
    }
    void refresh();
  });
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (auth.getSession()) void refresh();
  }, REFRESH_MS);
  if (timer.unref) timer.unref();
  if (auth.getSession()) void refresh();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 打开官网价格页（带桌面端来源标记，便于埋点与回跳）。 */
function openUpgrade(plan) {
  const p = plan === 'studio' ? 'studio' : 'pro';
  return shell.openExternal(`${auth.WEB_BASE}/pricing.html?from=desktop&plan=${p}`);
}

function onChange(fn) {
  handlers.push(fn);
}

/** 付费功能清单（与 pricing.html 的「Pro 专属」一一对应）。 */
const PRO_FEATURES = ['localize', 'oralcast', 'translate', 'clips', 'enhance'];

module.exports = {
  PRO_FEATURES,
  PAID_PLANS,
  GRACE_MS,
  start,
  stop,
  get,
  refresh,
  onChange,
  openUpgrade,
};
