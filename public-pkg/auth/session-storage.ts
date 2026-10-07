/**
 * Auth 共享底层工具（无 React 依赖，客户端使用）。
 *
 * 供 `./auth-context` 与 `../adapters/supabase/auth` 复用，集中承载所有
 * 浏览器端持久化与「历史修复」：
 * - `normalizeAuthInput`：中文输入法全角字符 → 半角归一化（邮箱/密码）。
 * - token 持久化一律包在 try/catch 中（Safari 无痕模式下 localStorage 会抛错，
 *   存储不可用时绝不崩溃）。
 * - 写入 cookie 使用 `config.auth.storageKeys.cookieAccess / cookieRefresh`，
 *   属性 `Path=/; SameSite=Lax`（https 时追加 Secure），供同源请求携带。
 * - 本地 demo 账号 / 桌面 deep-link 回调的存储键均由 `config.auth.storageKeys.*`
 *   派生，不硬编码品牌名。
 */

import type { PkgUser, ResolvedConfig } from '../config/types';

// ────────────────────────────────────────────────────────────
// 输入归一化
// ────────────────────────────────────────────────────────────

// 全角字符区间（！-～）与全角空格。
const FULLWIDTH_RE = /[\uFF01-\uFF5E]/g;

/**
 * 全角 → 半角归一化 + 去首尾空白。
 * 中文输入法下 `ａｄｍｉｎ＠１２３` 提交后与真实凭据不匹配会被后端直接拒绝，
 * 所有登录/注册入口统一在边界转换。
 */
export function normalizeAuthInput(input: string): string {
  if (!input) return input;
  return input
    .replace(FULLWIDTH_RE, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ') // 全角空格
    .trim();
}

// ────────────────────────────────────────────────────────────
// JWT（仅解析载荷，用于本地 demo / 桌面 token 快速还原）
// ────────────────────────────────────────────────────────────

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function isDemoToken(token: string): boolean {
  const payload = decodeJwtPayload(token);
  return payload?.demo === true;
}

export function createUserFromJwt(token: string): PkgUser | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  if (!sub) return null;
  const email = typeof payload.email === 'string' ? payload.email : '';
  const meta = (
    payload.user_metadata && typeof payload.user_metadata === 'object'
      ? payload.user_metadata
      : {}
  ) as Record<string, unknown>;
  const metaName = typeof meta.name === 'string' ? meta.name : null;
  const fullName = typeof payload.full_name === 'string' ? payload.full_name : null;
  const role = typeof payload.role === 'string' ? payload.role : 'user';
  const metaAvatar = typeof meta.avatar_url === 'string' ? meta.avatar_url : null;
  const topAvatar = typeof payload.avatar_url === 'string' ? payload.avatar_url : null;
  return {
    id: sub,
    email,
    name: metaName || fullName || email.split('@')[0],
    role,
    avatarUrl: metaAvatar || topAvatar,
  };
}

/** 生成本地 demo token（形态与真实 JWT 一致，仅用于 `demoAdmins` 未接 Supabase 的场景）。 */
export function generateDemoToken(user: PkgUser): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(
    JSON.stringify({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatar_url: user.avatarUrl,
      demo: true,
      exp: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
    }),
  );
  return `${header}.${payload}.demo-signature`;
}

// ────────────────────────────────────────────────────────────
// token 持久化（localStorage + cookie）
// ────────────────────────────────────────────────────────────

export interface StoredTokens {
  access: string | null;
  refresh: string | null;
}

export function readStoredTokens(config: ResolvedConfig): StoredTokens {
  if (typeof window === 'undefined') return { access: null, refresh: null };
  try {
    return {
      access: localStorage.getItem(config.auth.storageKeys.accessToken),
      refresh: localStorage.getItem(config.auth.storageKeys.refreshToken),
    };
  } catch {
    return { access: null, refresh: null };
  }
}

export function setAuthCookies(
  config: ResolvedConfig,
  access: string,
  refresh?: string | null,
): void {
  if (typeof document === 'undefined' || !access) return;
  try {
    const secure =
      typeof window !== 'undefined' && window.location.protocol === 'https:' ? '; Secure' : '';
    const attrs = `; Path=/; Max-Age=604800; SameSite=Lax${secure}`;
    document.cookie = `${config.auth.storageKeys.cookieAccess}=${encodeURIComponent(access)}${attrs}`;
    if (refresh) {
      document.cookie = `${config.auth.storageKeys.cookieRefresh}=${encodeURIComponent(refresh)}${attrs}`;
    }
  } catch {
    /* 存储不可用时忽略 */
  }
}

export function clearAuthCookies(config: ResolvedConfig): void {
  if (typeof document === 'undefined') return;
  try {
    const attrs = '; Path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    document.cookie = `${config.auth.storageKeys.cookieAccess}=${attrs}`;
    document.cookie = `${config.auth.storageKeys.cookieRefresh}=${attrs}`;
  } catch {
    /* ignore */
  }
}

/** 持久化会话 token（localStorage 不可写时不崩溃，仍写 cookie）。 */
export function persistSession(
  config: ResolvedConfig,
  access: string | null,
  refresh?: string | null,
): void {
  if (typeof window === 'undefined' || !access) return;
  try {
    localStorage.setItem(config.auth.storageKeys.accessToken, access);
    if (refresh) localStorage.setItem(config.auth.storageKeys.refreshToken, refresh);
  } catch {
    /* Safari 无痕模式等：忽略 */
  }
  setAuthCookies(config, access, refresh);
}

/** 清理本地认证状态（token + cookie + demo 用户）。 */
export function clearAuthStorage(config: ResolvedConfig): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(config.auth.storageKeys.accessToken);
    localStorage.removeItem(config.auth.storageKeys.refreshToken);
    localStorage.removeItem(config.auth.storageKeys.demoUser);
  } catch {
    /* ignore */
  }
  clearAuthCookies(config);
}

// ────────────────────────────────────────────────────────────
// 本地 demo 账号（仅 `config.auth.demoAdmins` 未接 Supabase 时使用）
// ────────────────────────────────────────────────────────────

export interface DemoRegisteredUser {
  id: string;
  email: string;
  password: string;
  name: string;
}

export function getRegisteredUsers(config: ResolvedConfig): DemoRegisteredUser[] {
  if (typeof window === 'undefined') return [];
  const key = config.auth.storageKeys.registeredUsers;
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return [];
    return JSON.parse(stored) as DemoRegisteredUser[];
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    return [];
  }
}

export function saveRegisteredUser(config: ResolvedConfig, user: DemoRegisteredUser): void {
  if (typeof window === 'undefined') return;
  try {
    const users = getRegisteredUsers(config);
    const idx = users.findIndex((u) => u.email.toLowerCase() === user.email.toLowerCase());
    if (idx >= 0) users[idx] = user;
    else users.push(user);
    localStorage.setItem(config.auth.storageKeys.registeredUsers, JSON.stringify(users));
  } catch {
    /* ignore */
  }
}

export function findRegisteredUser(
  config: ResolvedConfig,
  email: string,
  password: string,
): DemoRegisteredUser | null {
  const users = getRegisteredUsers(config);
  return (
    users.find(
      (u) => u.email.toLowerCase() === email.toLowerCase() && u.password === password,
    ) || null
  );
}

export function getDemoUser(config: ResolvedConfig): PkgUser | null {
  if (typeof window === 'undefined') return null;
  const key = config.auth.storageKeys.demoUser;
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return null;
    return JSON.parse(stored) as PkgUser;
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    return null;
  }
}

export function saveDemoUser(config: ResolvedConfig, user: PkgUser): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(config.auth.storageKeys.demoUser, JSON.stringify(user));
  } catch {
    /* ignore */
  }
}

export function clearDemoUser(config: ResolvedConfig): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(config.auth.storageKeys.demoUser);
  } catch {
    /* ignore */
  }
}

// ────────────────────────────────────────────────────────────
// 桌面 deep-link 辅助（由 config.auth.desktopAuth 门控）
// ────────────────────────────────────────────────────────────

type SearchParamsLike = Pick<URLSearchParams, 'get'>;

// 存储键由 config.auth.storageKeys.accessToken 派生，避免硬编码品牌前缀。
function desktopFlagKey(config: ResolvedConfig): string {
  return `${config.auth.storageKeys.accessToken}__desktop_flow`;
}
function desktopCallbackKey(config: ResolvedConfig): string {
  return `${config.auth.storageKeys.accessToken}__desktop_callback`;
}

export function isDesktopAuthRequest(
  config: ResolvedConfig,
  searchParams?: SearchParamsLike | null,
): boolean {
  if (!config.auth.desktopAuth) return false;
  const fromSearch =
    searchParams?.get('from') === 'desktop' || searchParams?.get('desktop') === '1';
  if (fromSearch) return true;
  if (typeof window === 'undefined') return false;
  try {
    return sessionStorage.getItem(desktopFlagKey(config)) === '1';
  } catch {
    return false;
  }
}

/** 仅接受 http/https 的本地回调地址（去掉路径，保留 origin）。 */
export function normalizeDesktopCallbackUrl(raw?: string | null): string {
  const value = (raw || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

export function rememberDesktopCallback(config: ResolvedConfig, callbackUrl?: string | null): void {
  if (!config.auth.desktopAuth || typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(desktopFlagKey(config), '1');
    const safe = normalizeDesktopCallbackUrl(callbackUrl);
    if (safe) sessionStorage.setItem(desktopCallbackKey(config), safe);
  } catch {
    /* ignore */
  }
}

export function getDesktopCallback(
  config: ResolvedConfig,
  searchParams?: SearchParamsLike | null,
): string {
  if (!config.auth.desktopAuth) return '';
  const fromSearch = normalizeDesktopCallbackUrl(searchParams?.get('callback'));
  if (fromSearch) return fromSearch;
  if (typeof window === 'undefined') return '';
  try {
    return sessionStorage.getItem(desktopCallbackKey(config)) || '';
  } catch {
    return '';
  }
}

export interface DesktopAuthPayload {
  token?: string | null;
  refreshToken?: string | null;
  email?: string | null;
  userId?: string | null;
  name?: string | null;
}

/** 构造回到桌面客户端的 deep-link 返回地址（无回调地址或无 token 时返回 ''）。 */
export function buildDesktopReturnUrl(
  config: ResolvedConfig,
  payload: DesktopAuthPayload,
): string {
  const callback = getDesktopCallback(config);
  if (!callback || !payload.token) return '';
  try {
    const url = new URL(callback);
    url.searchParams.set('token', payload.token);
    if (payload.refreshToken) url.searchParams.set('refreshToken', payload.refreshToken);
    if (payload.email) url.searchParams.set('email', payload.email);
    if (payload.userId) url.searchParams.set('userId', payload.userId);
    if (payload.name) url.searchParams.set('name', payload.name);
    return url.toString();
  } catch {
    return '';
  }
}