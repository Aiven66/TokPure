'use client';

/**
 * AuthProvider / useAuth —— 可配置的「注册/登录」状态容器。
 *
 * 用法：
 *   <PublicPkgProvider config={pkgConfig}>
 *     <AuthProvider>{children}</AuthProvider>
 *   </PublicPkgProvider>
 *
 * 架构：会话/身份来源由 `config.adapters.auth` 注入，缺省使用 Supabase 适配器
 * `createSupabaseAuthAdapter(config)`（见 `../adapters/supabase/auth`）。本文件只
 * 负责 React 状态、浏览器端 token/cookie 持久化、本地 demo 登录与桌面 deep-link。
 *
 * 保留的历史修复：
 * - `normalizeAuthInput` 全角→半角归一化（此处 re-export 自 `./session-storage`）。
 * - token 持久化包在 try/catch；写入 cookie 用 `config.auth.storageKeys.cookieAccess /
 *   cookieRefresh`（Path=/; SameSite=Lax），见 `./session-storage`。
 * - 会话恢复三阶段：refresh → 校验 stored token → 清理脏状态（`checkAuthState`）。
 * - 订阅 `adapter.onAuthStateChange` 同步用户状态（含刷新后的 token）。
 * - `refreshSession()` 成功返回新 access token，失败返回 null。
 * - 本地 demo 登录仅当 `config.auth.demoAdmins` 有值时启用。
 * - Google 登录由 `config.auth.googleEnabled` 门控。
 *
 * 桌面 deep-link：由 `config.auth.desktopAuth`（默认 false）门控。本模块**未**移植
 * `src/lib/desktop-auth.ts` 的完整原生桥接 / Android deep link / 本地回调服务器逻辑，
 * 仅提供基于 `?from=desktop` 与 `?callback=` 的轻量返回地址；`desktopAuth=false` 时
 * 所有桌面分支完全旁路，Web 登录/注册路径不受影响。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthAdapter, AuthSignInResult, PkgUser } from '../config/types';
import { usePkgConfig } from '../config/provider';
import { createSupabaseAuthAdapter } from '../adapters/supabase/auth';
import { isSupabaseConfigured } from '../adapters/supabase/client';
import {
  clearAuthStorage,
  clearDemoUser,
  findRegisteredUser,
  generateDemoToken,
  getDemoUser,
  getRegisteredUsers,
  normalizeAuthInput,
  persistSession,
  readStoredTokens,
  rememberDesktopCallback,
  saveDemoUser,
  saveRegisteredUser,
} from './session-storage';

export { normalizeAuthInput } from './session-storage';

export interface AuthContextType {
  user: PkgUser | null;
  accessToken: string | null;
  loading: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<AuthSignInResult>;
  signUp: (email: string, password: string, name: string) => Promise<AuthSignInResult>;
  signInWithGoogle: () => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  clearError: () => void;
  /** 用 refresh token 刷新会话；成功返回新 access token，失败返回 null。 */
  refreshSession: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function demoAdminsEnabled(config: ReturnType<typeof usePkgConfig>): boolean {
  return Object.keys(config.auth.demoAdmins ?? {}).length > 0;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const config = usePkgConfig();
  const [user, setUser] = useState<PkgUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [useDemo, setUseDemo] = useState(false);

  const adapter = useMemo<AuthAdapter>(
    () => config.adapters?.auth ?? createSupabaseAuthAdapter(config),
    [config],
  );

  const applyDemoLogin = useCallback(
    (demoUser: PkgUser, token: string) => {
      setUser(demoUser);
      saveDemoUser(config, demoUser);
      setUseDemo(true);
      setAccessToken(token);
      persistSession(config, token, null);
    },
    [config],
  );

  // 会话恢复三阶段：refresh → 校验 stored token → 清理脏状态。
  const checkAuthState = useCallback(async () => {
    try {
      const supabaseReady = isSupabaseConfigured(config.supabase ?? { url: '', anonKey: '' });
      if (!supabaseReady) {
        const demoUser = getDemoUser(config);
        const { access } = readStoredTokens(config);
        if (demoUser) {
          setUser(demoUser);
          setUseDemo(true);
          if (access) setAccessToken(access);
        }
        return;
      }

      // 阶段 1：refresh token 换新会话。
      const token = await adapter.refreshSession().catch(() => null);
      if (token) {
        const refreshed = await adapter.getCurrentUser().catch(() => null);
        if (refreshed) {
          setUser(refreshed);
          setAccessToken(token);
          return;
        }
      }

      // 阶段 2：校验 localStorage 中备份的 stored token 是否仍有效。
      const current = await adapter.getCurrentUser().catch(() => null);
      if (current) {
        setUser(current);
        setAccessToken(adapter.getAccessToken());
        return;
      }

      // 阶段 3：会话确实过期，清理脏状态，避免"假登录"继续发送过期 token。
      clearAuthStorage(config);
      setUser(null);
      setAccessToken(null);
    } catch {
      // 异常路径（如网络瞬断）：保留 token 供后续请求验证，但不把残留 demo 用户设为 user。
      const { access } = readStoredTokens(config);
      if (access) setAccessToken(access);
    } finally {
      setLoading(false);
    }
  }, [adapter, config]);

  useEffect(() => {
    const unsubscribe = adapter.onAuthStateChange?.((next: PkgUser | null) => {
      if (next) {
        setUser(next);
        setUseDemo(false);
        const token = adapter.getAccessToken();
        if (token) setAccessToken(token);
      } else {
        setUser(null);
        setAccessToken(null);
      }
    });
    checkAuthState();
    return () => {
      unsubscribe?.();
    };
  }, [adapter, checkAuthState]);

  const signIn = useCallback(
    async (emailRaw: string, passwordRaw: string): Promise<AuthSignInResult> => {
      setError(null);
      const email = normalizeAuthInput(emailRaw).toLowerCase();
      const password = normalizeAuthInput(passwordRaw);
      const supabaseReady = isSupabaseConfigured(config.supabase ?? { url: '', anonKey: '' });

      // 本地 demo 路径：仅在未配置 Supabase（或已处于 demo 态）且配置了 demoAdmins 时启用。
      if ((!supabaseReady || useDemo) && demoAdminsEnabled(config)) {
        const admin = config.auth.demoAdmins![email];
        if (admin && admin.password === password) {
          const adminUser: PkgUser = {
            id: 'demo-admin-id',
            email: admin.email || email,
            name: admin.name || 'Admin',
            role: 'admin',
            avatarUrl: null,
          };
          const token = generateDemoToken(adminUser);
          applyDemoLogin(adminUser, token);
          return { error: null, token, email: adminUser.email };
        }
        const registered = findRegisteredUser(config, email, password);
        if (registered) {
          const demoUser: PkgUser = {
            id: registered.id,
            email: registered.email,
            name: registered.name,
            role: 'user',
            avatarUrl: null,
          };
          const token = generateDemoToken(demoUser);
          applyDemoLogin(demoUser, token);
          return { error: null, token, email: demoUser.email };
        }
        return {
          error: 'Invalid email or password. Please register an account first.',
          token: null,
        };
      }

      if (!supabaseReady) {
        const msg = 'Authentication service is not configured.';
        setError(msg);
        return { error: msg, token: null };
      }

      const result = await adapter.signIn(email, password);
      if (result.error) {
        setError(result.error);
        return result;
      }
      if (result.token) {
        setAccessToken(result.token);
        persistSession(config, result.token, result.refreshToken ?? null);
      }
      const current = await adapter.getCurrentUser().catch(() => null);
      if (current) {
        setUser(current);
        setUseDemo(false);
      }
      return result;
    },
    [adapter, applyDemoLogin, config, useDemo],
  );

  const signUp = useCallback(
    async (emailRaw: string, passwordRaw: string, name: string): Promise<AuthSignInResult> => {
      setError(null);
      const email = normalizeAuthInput(emailRaw).toLowerCase();
      const password = normalizeAuthInput(passwordRaw);
      const supabaseReady = isSupabaseConfigured(config.supabase ?? { url: '', anonKey: '' });

      if ((!supabaseReady || useDemo) && demoAdminsEnabled(config)) {
        const existing = getRegisteredUsers(config).find(
          (u) => u.email.toLowerCase() === email,
        );
        if (existing) return { error: 'This email is already registered. Please sign in.' };

        const userId = `demo-${Date.now()}`;
        const demoUser: PkgUser = { id: userId, email, name, role: 'user', avatarUrl: null };
        const token = generateDemoToken(demoUser);
        saveRegisteredUser(config, { id: userId, email, password, name });
        applyDemoLogin(demoUser, token);
        return { error: null, token, email: demoUser.email };
      }

      if (!supabaseReady) {
        const msg = 'Authentication service is not configured.';
        setError(msg);
        return { error: msg, token: null };
      }

      const result = await adapter.signUp(email, password, name);
      if (result.error) {
        setError(result.error);
        return result;
      }
      if (result.token) {
        setAccessToken(result.token);
        persistSession(config, result.token, result.refreshToken ?? null);
      }
      const current = await adapter.getCurrentUser().catch(() => null);
      if (current) {
        setUser(current);
        setUseDemo(false);
      }
      return result;
    },
    [adapter, applyDemoLogin, config, useDemo],
  );

  const signInWithGoogle = useCallback(async (): Promise<{ error: string | null }> => {
    setError(null);
    if (!config.auth.googleEnabled) {
      const msg = 'Google sign-in is not enabled.';
      setError(msg);
      return { error: msg };
    }
    if (config.auth.desktopAuth && typeof window !== 'undefined') {
      rememberDesktopCallback(config, new URLSearchParams(window.location.search).get('callback'));
    }
    const result = (await adapter.signInWithGoogle?.()) ?? {
      error: 'Google sign-in is not available.',
    };
    if (result.error) setError(result.error);
    return result;
  }, [adapter, config]);

  const signOut = useCallback(async () => {
    clearAuthStorage(config);
    clearDemoUser(config);
    setUseDemo(false);
    setUser(null);
    setAccessToken(null);
    setLoading(false);
    await adapter.signOut().catch(() => {});
  }, [adapter, config]);

  const refreshSession = useCallback(async (): Promise<string | null> => {
    const token = await adapter.refreshSession();
    if (token) {
      setAccessToken(token);
      persistSession(config, token, readStoredTokens(config).refresh);
      const current = await adapter.getCurrentUser().catch(() => null);
      if (current) setUser(current);
    }
    return token;
  }, [adapter, config]);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<AuthContextType>(
    () => ({
      user,
      accessToken,
      loading,
      error,
      signIn,
      signUp,
      signInWithGoogle,
      signOut,
      clearError,
      refreshSession,
    }),
    [user, accessToken, loading, error, signIn, signUp, signInWithGoogle, signOut, clearError, refreshSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}