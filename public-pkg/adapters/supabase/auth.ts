/**
 * Supabase Auth 适配器 —— `AuthAdapter` 的默认实现。
 *
 * 用法（一般无需手动调用，`AuthProvider` 会默认使用它）：
 *   const adapter = createSupabaseAuthAdapter(resolvedConfig);
 *   const { error, token } = await adapter.signIn(email, password);
 *
 * 职责：把「会话与身份来源」的 Supabase 细节隔离在此，便于替换为 Firebase / 自建后端。
 * 连接信息来自 `config.supabase`（不读 env）；未配置时所有方法安全降级、不抛错。
 *
 * 保留的历史修复：
 * - 登录/注册入口 `normalizeAuthInput` 全角→半角归一化。
 * - `ensureServerProfile` 优先调 `config.auth.endpoints.ensureProfile`（service role，
 *   幂等补建 users/credits/subscriptions），失败回落到客户端建档 `createProfileWithClient`；
 *   建档错误用 `console.error` 显式打印，绝不空 catch 静默吞错。
 * - `onAuthStateChange` 内同步持久化刷新后的 token（supabase-js 的 autoRefreshToken
 *   只更新它自己的存储，本模块需同步 localStorage + cookie，避免"看似已登录实则过期"）。
 * - `refreshSession()` 成功返回新 access token，失败返回 null。
 */

import { getSupabaseClient, isSupabaseConfigured, type SupabaseCredentials } from './client';
import type { AuthAdapter, AuthSignInResult, PkgUser, ResolvedConfig } from '../../config/types';
import {
  clearAuthStorage,
  normalizeAuthInput,
  persistSession,
  readStoredTokens,
} from '../../auth/session-storage';

type AuthUserLike = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
  app_metadata?: Record<string, unknown> | null;
};

function resolveCredentials(config: ResolvedConfig): SupabaseCredentials {
  return config.supabase ?? { url: '', anonKey: '' };
}

/** 未命中 `users.role` 时，按 `config.admin.adminEmails` 白名单推断角色。 */
function roleForEmail(config: ResolvedConfig, email: string): string {
  const lower = (email || '').toLowerCase();
  return (config.admin.adminEmails ?? []).some((e) => e.toLowerCase() === lower) ? 'admin' : 'user';
}

function rowToUser(row: Record<string, unknown>): PkgUser {
  return {
    id: String(row.id ?? ''),
    email: String(row.email ?? ''),
    name: (row.name as string | null) ?? null,
    role: (row.role as string) || 'user',
    avatarUrl: (row.avatar_url as string | null) ?? null,
  };
}

function authUserToUser(config: ResolvedConfig, authUser: AuthUserLike): PkgUser {
  const email = authUser.email || '';
  const meta = authUser.user_metadata ?? {};
  return {
    id: authUser.id,
    email,
    name: typeof meta.name === 'string' ? meta.name : null,
    role: roleForEmail(config, email),
    avatarUrl: typeof meta.avatar_url === 'string' ? meta.avatar_url : null,
  };
}

/**
 * 服务端兜底建档：调 `config.auth.endpoints.ensureProfile`，用 service role 幂等补齐
 * public.users / credits / subscriptions。返回 true 表示服务端已确认建档；失败只告警，
 * 绝不阻断登录/注册主流程。
 */
async function ensureServerProfile(config: ResolvedConfig, token?: string | null): Promise<boolean> {
  if (!token) return false;
  const endpoint = config.auth.endpoints.ensureProfile;
  if (!endpoint) return false;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.warn('[auth] ensure-profile 未成功:', res.status);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[auth] ensure-profile 请求异常:', e);
    return false;
  }
}

/**
 * 传统客户端建档路径（anon key）：仅作为服务端兜底不可用时的回落。
 * 历史上因空 catch 静默失败导致用户漏记后台，这里把错误显式打印便于排查。
 */
async function createProfileWithClient(
  config: ResolvedConfig,
  client: any,
  authUser: AuthUserLike,
  fallbackName?: string,
): Promise<void> {
  try {
    const email = (authUser.email || '').trim().toLowerCase();
    if (!email) return;

    const meta = authUser.user_metadata || {};
    const provider =
      typeof authUser.app_metadata?.provider === 'string' ? authUser.app_metadata.provider : 'email';
    const name = (typeof meta.name === 'string' && meta.name) || fallbackName || email.split('@')[0];

    const { error: userError } = await client.from('users').upsert(
      {
        id: authUser.id,
        email,
        name,
        role: 'user',
        google_id: provider === 'google' ? authUser.id : null,
      },
      { onConflict: 'id' },
    );
    if (userError) {
      // users 行失败则不再写 credits/subscriptions，避免产生悬挂引用。
      console.error('[auth] 客户端补建 users 失败:', userError.message);
      return;
    }

    const { error: creditsError } = await client
      .from('credits')
      .insert({ user_id: authUser.id, balance: config.auth.initialCredits });
    if (creditsError && creditsError.code !== '23505') {
      console.error('[auth] 客户端补建 credits 失败:', creditsError.message);
    }

    const { error: subError } = await client
      .from('subscriptions')
      .insert({ user_id: authUser.id, plan_type: 'free', status: 'active' });
    if (subError && subError.code !== '23505') {
      console.error('[auth] 客户端补建 subscriptions 失败:', subError.message);
    }
  } catch (e) {
    console.error('[auth] 客户端补建档案异常:', e);
  }
}

/** 由 Supabase 会话/用户解析出业务用户；档案行缺失时触发兜底建档。 */
async function resolveUser(
  config: ResolvedConfig,
  client: any,
  authUser: AuthUserLike,
  token?: string | null,
): Promise<PkgUser> {
  try {
    const { data } = await client
      .from('users')
      .select('*')
      .eq('id', authUser.id)
      .maybeSingle();
    if (data) return rowToUser(data as Record<string, unknown>);

    const ensured = await ensureServerProfile(config, token);
    if (!ensured) await createProfileWithClient(config, client, authUser);
    return authUserToUser(config, authUser);
  } catch (e) {
    console.error('[auth] 读取用户档案失败:', e);
    return authUserToUser(config, authUser);
  }
}

/** 检测某邮箱此前是否仅用 Google 注册（无密码），用于登录失败时给出准确提示。 */
async function getSignInProviderHint(
  config: ResolvedConfig,
  email: string,
): Promise<'google' | 'password' | null> {
  try {
    const client = getSupabaseClient(resolveCredentials(config));
    const { data } = await client
      .from('users')
      .select('google_id,password_hash')
      .eq('email', email.trim().toLowerCase())
      .maybeSingle();
    if (data?.google_id && !data?.password_hash) return 'google';
    if (data?.password_hash) return 'password';
  } catch {
    /* 查询失败不阻断登录提示 */
  }
  return null;
}

export function createSupabaseAuthAdapter(config: ResolvedConfig): AuthAdapter {
  const creds = resolveCredentials(config);
  const configured = isSupabaseConfigured(creds);
  const client = () => getSupabaseClient(creds);

  async function fetchUserByStoredToken(token: string): Promise<PkgUser | null> {
    try {
      const tokenClient = getSupabaseClient(creds, token);
      const {
        data: { user: authUser },
      } = await tokenClient.auth.getUser(token);
      if (!authUser) return null;
      return await resolveUser(config, tokenClient, authUser as AuthUserLike, token);
    } catch {
      return null;
    }
  }

  return {
    async getCurrentUser(): Promise<PkgUser | null> {
      if (!configured) return null;
      try {
        const c = client();
        const {
          data: { session },
        } = await c.auth.getSession();
        if (session?.user) {
          persistSession(config, session.access_token || null, session.refresh_token);
          return await resolveUser(config, c, session.user as AuthUserLike, session.access_token);
        }
        // Supabase 无活跃会话 → 校验 localStorage 中备份的 stored token。
        const { access } = readStoredTokens(config);
        if (access) return await fetchUserByStoredToken(access);
        return null;
      } catch {
        return null;
      }
    },

    onAuthStateChange(cb: (user: PkgUser | null) => void): () => void {
      if (!configured || typeof window === 'undefined') return () => {};
      let cancelled = false;
      let unsubscribe: () => void = () => {};
      try {
        const c = client();
        const { data } = c.auth.onAuthStateChange((event: string, session: any) => {
          if (cancelled) return;
          if (event === 'SIGNED_OUT') {
            clearAuthStorage(config);
            cb(null);
            return;
          }
          if (
            (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN' || event === 'INITIAL_SESSION') &&
            session?.access_token
          ) {
            // autoRefreshToken 只更新 supabase 自身存储，这里同步 localStorage + cookie。
            persistSession(config, session.access_token, session.refresh_token);
            // onAuthStateChange 回调内直接调用 supabase 方法可能死锁，异步执行。
            setTimeout(() => {
              resolveUser(config, c, session.user as AuthUserLike, session.access_token)
                .then((u) => {
                  if (!cancelled) cb(u);
                })
                .catch(() => {});
            }, 0);
          }
        });
        unsubscribe = () => data?.subscription?.unsubscribe?.();
      } catch {
        /* 占位客户端等异常路径：返回空取消函数 */
      }
      return () => {
        cancelled = true;
        unsubscribe();
      };
    },

    async signIn(email: string, password: string): Promise<AuthSignInResult> {
      if (!configured) {
        return { error: 'Authentication service is not configured.', token: null };
      }
      const normalizedEmail = normalizeAuthInput(email).toLowerCase();
      const normalizedPassword = normalizeAuthInput(password);
      try {
        const c = client();
        const { data, error: authError } = await c.auth.signInWithPassword({
          email: normalizedEmail,
          password: normalizedPassword,
        });

        if (authError) {
          if (authError.message.toLowerCase().includes('invalid login credentials')) {
            const hint = await getSignInProviderHint(config, normalizedEmail);
            if (hint === 'google') {
              return {
                error:
                  'This email is already connected to Google sign-in. Please use Continue with Google.',
                token: null,
              };
            }
            return {
              error:
                'Invalid email or password. Please check your password or register a new account.',
              token: null,
            };
          }
          return { error: authError.message, token: null };
        }

        if (data.session) {
          const token = data.session.access_token || null;
          const refreshToken = data.session.refresh_token || null;
          persistSession(config, token, refreshToken);
          await resolveUser(config, c, data.session.user as AuthUserLike, token);
          return { error: null, token, refreshToken, email: data.session.user?.email };
        }
        return { error: null, token: null };
      } catch {
        return { error: 'Network error. Please try again later.' };
      }
    },

    async signUp(email: string, password: string, name: string): Promise<AuthSignInResult> {
      if (!configured) {
        return { error: 'Authentication service is not configured.', token: null };
      }
      const normalizedEmail = normalizeAuthInput(email).toLowerCase();
      const normalizedPassword = normalizeAuthInput(password);
      try {
        const c = client();
        const { data: authData, error: authError } = await c.auth.signUp({
          email: normalizedEmail,
          password: normalizedPassword,
          options: { data: { name } },
        });

        if (authError) {
          if (
            authError.message.includes('already registered') ||
            authError.message.includes('user already exists') ||
            authError.message.includes('email already in use')
          ) {
            return { error: 'This email is already registered. Please sign in.' };
          }
          return { error: authError.message };
        }

        const {
          data: { session },
        } = await c.auth.getSession();

        if (authData?.user) {
          // 服务端兜底建档优先；拿不到 session（如需邮箱确认）或服务端不可用时回落客户端写入。
          const ensured = await ensureServerProfile(config, session?.access_token);
          if (!ensured) await createProfileWithClient(config, c, authData.user as AuthUserLike, name);
        }

        if (session) {
          const token = session.access_token || null;
          const refreshToken = session.refresh_token || null;
          persistSession(config, token, refreshToken);
          await resolveUser(config, c, session.user as AuthUserLike, token);
          return { error: null, token, refreshToken, email: session.user.email || normalizedEmail };
        }

        const { data: signInData, error: signInError } = await c.auth.signInWithPassword({
          email: normalizedEmail,
          password: normalizedPassword,
        });
        if (!signInError && signInData.session) {
          const token = signInData.session.access_token || null;
          const refreshToken = signInData.session.refresh_token || null;
          persistSession(config, token, refreshToken);
          await resolveUser(config, c, signInData.session.user as AuthUserLike, token);
          return {
            error: null,
            token,
            refreshToken,
            email: signInData.session.user?.email || normalizedEmail,
          };
        }

        // 无 session → 需要邮箱确认（交由上层 UI 提示）。
        return { error: null, token: null, needsVerification: true, email: normalizedEmail };
      } catch {
        return { error: 'Network error. Please try again later.' };
      }
    },

    async signInWithGoogle(): Promise<{ error: string | null }> {
      if (!config.auth.googleEnabled) {
        return { error: 'Google sign-in is not enabled.' };
      }
      if (!configured) {
        return { error: 'Google login is not configured. Please contact the administrator.' };
      }
      try {
        const c = client();
        const redirectTo = `${window.location.origin}${config.brand.callbackPath}`;
        const { data, error: oauthError } = await c.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo,
            skipBrowserRedirect: true,
            scopes: 'email profile',
            queryParams: { access_type: 'offline', prompt: 'consent' },
          },
        });
        if (oauthError) return { error: `Google login failed: ${oauthError.message}` };
        if (data?.url) {
          window.location.href = data.url;
          return { error: null };
        }
        return { error: 'Google login failed. Please try again.' };
      } catch (err) {
        return { error: err instanceof Error ? err.message : 'Google login failed.' };
      }
    },

    async signOut(): Promise<void> {
      clearAuthStorage(config);
      if (!configured) return;
      try {
        await client().auth.signOut();
      } catch {
        /* 忽略登出网络异常，本地状态已清理 */
      }
    },

    // 用 refresh token 刷新会话：API 收到 401 时无感恢复。成功返回新 access token。
    async refreshSession(): Promise<string | null> {
      if (!configured) return null;
      try {
        const c = client();
        let { data: { session }, error } = await c.auth.refreshSession();

        // 存储里没有可刷新的会话时，用 localStorage 备份的 token 引导。
        if (!session) {
          const { access, refresh } = readStoredTokens(config);
          if (!access && !refresh) return null;
          try {
            const result = await c.auth.setSession({
              access_token: access || 'x',
              refresh_token: refresh || 'x',
            });
            session = result.data.session;
            error = result.error ?? null;
          } catch {
            return null;
          }
        }

        if (error || !session?.access_token) return null;

        persistSession(config, session.access_token, session.refresh_token);
        return session.access_token;
      } catch {
        return null;
      }
    },

    getAccessToken(): string | null {
      return readStoredTokens(config).access;
    },
  };
}