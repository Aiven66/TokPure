'use strict';

/**
 * /api 服务端公共库（Vercel Node Function）。
 *
 * 只使用 service role 直连 Supabase 的 Auth / PostgREST HTTP 接口，
 * 不引入额外依赖；service role key 仅存在于服务端环境变量，绝不下发到前端。
 *
 * 环境变量：SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
 */

/** 管理员邮箱白名单，需与 pkg-config 的 ADMIN_EMAILS、schema.sql 的 is_admin() 保持一致。 */
const ADMIN_EMAILS = ['admin@126.com'];

/** 新用户初始积分，需与 pkg-config 的 auth.initialCredits 一致。 */
const INITIAL_CREDITS = 60;

const BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY || '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/** 是否已配置 Supabase（未配置时端点返回 503，前端会回落到本地演示模式）。 */
function configured() {
  return Boolean(BASE && SERVICE);
}

function bearer(req) {
  const raw = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(raw));
  return m ? m[1].trim() : '';
}

/** 校验 access token 并取回 auth 用户。 */
async function getAuthUser(token) {
  if (!configured() || !token) return null;
  try {
    const res = await fetch(`${BASE}/auth/v1/user`, {
      headers: { apikey: ANON || SERVICE, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** service role 调 PostgREST。返回 { ok, status, data }，不抛错。 */
async function rest(path, init = {}) {
  try {
    const res = await fetch(`${BASE}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: e instanceof Error ? e.message : String(e) };
  }
}

/** 管理员判定：白名单邮箱，或 users.role = 'admin'。 */
async function isAdminUser(user) {
  if (!user?.id) return false;
  const email = String(user.email || '').toLowerCase();
  if (ADMIN_EMAILS.includes(email)) return true;
  const { ok, data } = await rest(`users?select=role&id=eq.${encodeURIComponent(user.id)}&limit=1`);
  return ok && Array.isArray(data) && data[0]?.role === 'admin';
}

/** 守卫：必须有合法 access token，否则写 401 并返回 null。 */
async function requireUser(req, res) {
  const token = bearer(req);
  if (!token) {
    res.status(401).json({ error: 'missing token' });
    return null;
  }
  const user = await getAuthUser(token);
  if (!user?.id) {
    res.status(401).json({ error: 'invalid token' });
    return null;
  }
  return user;
}

/** 守卫：必须是管理员，否则写 401/403 并返回 null。 */
async function requireAdmin(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;
  if (!(await isAdminUser(user))) {
    res.status(403).json({ error: 'forbidden', isAdmin: false });
    return null;
  }
  return user;
}

module.exports = {
  ADMIN_EMAILS,
  INITIAL_CREDITS,
  configured,
  bearer,
  getAuthUser,
  rest,
  isAdminUser,
  requireUser,
  requireAdmin,
};