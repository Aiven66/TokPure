'use client';

/**
 * AuthCallback —— OAuth 回调处理组件（挂到 `config.brand.callbackPath` 路由，如 `/auth/callback`）。
 *
 * 用法（App Router 页面）：
 *   <Suspense>
 *     <AuthCallback />
 *   </Suspense>
 *
 * 逻辑：处理 `?code`（PKCE）与 URL hash 中的 `access_token`，换取会话并补建档案，
 * 然后按配置跳转（`config.auth.afterLoginHref` 或安全的 `?next=`）。桌面流程由
 * `config.auth.desktopAuth` 门控，命中时回跳 `?callback=` 指定地址并附带 token。
 *
 * 需要 `<Suspense>` 包裹（内部使用 `useSearchParams`）。
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { usePkgConfig, useT } from '../config/provider';
import { createSupabaseAuthAdapter } from '../adapters/supabase/auth';
import { getSupabaseClient, isSupabaseConfigured } from '../adapters/supabase/client';
import {
  buildDesktopReturnUrl,
  isDesktopAuthRequest,
  persistSession,
  readStoredTokens,
  rememberDesktopCallback,
} from './session-storage';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function safeNext(next: string | null): string {
  const raw = (next || '').trim();
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '';
  return raw;
}

export function AuthCallback() {
  const config = usePkgConfig();
  const t = useT();
  const router = useRouter();
  const sp = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const executedRef = useRef(false);

  useEffect(() => {
    if (executedRef.current) return;
    executedRef.current = true;

    const loginHref = config.brand.loginHref;
    const fail = (msg: string) => {
      setStatus('error');
      setMessage(msg);
      const sep = loginHref.includes('?') ? '&' : '?';
      setTimeout(() => router.replace(`${loginHref}${sep}error=${encodeURIComponent(msg)}`), 2000);
    };

    (async () => {
      try {
        const creds = config.supabase ?? { url: '', anonKey: '' };
        const code = sp.get('code');
        const errorParam = sp.get('error');
        const errorDescription = sp.get('error_description');
        const requestedNext = safeNext(sp.get('next'));
        const isDesktopFlow = isDesktopAuthRequest(config, sp);

        if (isDesktopFlow) rememberDesktopCallback(config, sp.get('callback'));

        if (errorParam) {
          fail(errorDescription || errorParam);
          return;
        }
        if (!isSupabaseConfigured(creds)) {
          fail('Authentication service is not configured.');
          return;
        }

        const hash = typeof window !== 'undefined' ? window.location.hash : '';
        const hasHashToken = hash.includes('access_token') || hash.includes('id_token');
        if (!code && !hasHashToken) {
          fail('No authentication data received. Please try again.');
          return;
        }

        const client = getSupabaseClient(creds);
        let access = '';
        let refresh = '';
        const applySession = (session: any): boolean => {
          if (session?.access_token) {
            access = session.access_token;
            refresh = session.refresh_token || '';
            return true;
          }
          return false;
        };

        // 1) URL hash（implicit flow）
        if (!access && hash) {
          const hashParams = new URLSearchParams(hash.replace(/^#/, ''));
          const hashAccess = hashParams.get('access_token') || '';
          const hashRefresh = hashParams.get('refresh_token') || '';
          if (hashAccess) {
            if (hashRefresh) {
              try {
                const { data } = await client.auth.setSession({
                  access_token: hashAccess,
                  refresh_token: hashRefresh,
                });
                if (!applySession(data?.session)) {
                  access = hashAccess;
                  refresh = hashRefresh;
                }
              } catch {
                access = hashAccess;
                refresh = hashRefresh;
              }
            } else {
              access = hashAccess;
              refresh = hashRefresh;
            }
          }
        }

        // 2) PKCE code 换取会话
        if (!access && code) {
          try {
            const { data } = await client.auth.exchangeCodeForSession(code);
            applySession(data?.session);
          } catch {
            /* 已由 detectSessionInUrl 处理等场景，落到 getSession 重试 */
          }
        }

        // 3) 轮询 getSession（回调解析存在时序）
        if (!access) {
          for (let attempt = 0; attempt < 8; attempt += 1) {
            try {
              const {
                data: { session },
              } = await client.auth.getSession();
              if (applySession(session)) break;
            } catch {
              /* ignore */
            }
            await sleep(150 + attempt * 100);
          }
        }

        // 4) 兜底：localStorage 中备份的 token
        if (!access) {
          const stored = readStoredTokens(config);
          if (stored.access) {
            if (stored.refresh) {
              try {
                const { data } = await client.auth.setSession({
                  access_token: stored.access,
                  refresh_token: stored.refresh,
                });
                if (!applySession(data?.session)) {
                  access = stored.access;
                  refresh = stored.refresh;
                }
              } catch {
                access = stored.access;
                refresh = stored.refresh;
              }
            } else {
              access = stored.access;
              refresh = stored.refresh || '';
            }
          }
        }

        if (!access) {
          fail('Failed to obtain session. Please try again.');
          return;
        }

        persistSession(config, access, refresh || null);
        // 补建档案（服务端兜底 + 客户端回落，见适配器）。
        try {
          await createSupabaseAuthAdapter(config).getCurrentUser();
        } catch {
          /* 建档失败不阻断跳转 */
        }

        setStatus('success');

        if (isDesktopFlow) {
          const returnUrl = buildDesktopReturnUrl(config, {
            token: access,
            refreshToken: refresh || null,
          });
          if (returnUrl) {
            setTimeout(() => {
              window.location.href = returnUrl;
            }, 500);
            return;
          }
        }

        const next = requestedNext || config.auth.afterLoginHref;
        setTimeout(() => router.replace(next), 500);
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Authentication failed.');
      }
    })();
  }, [config, router, sp]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-4">
        {status === 'loading' && (
          <>
            <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
            <p className="text-muted-foreground">{t('auth.callback.verifying')}</p>
          </>
        )}
        {status === 'success' && (
          <p className="text-muted-foreground">{t('auth.callback.success')}</p>
        )}
        {status === 'error' && (
          <>
            <p className="text-destructive">{message}</p>
            <p className="text-sm text-muted-foreground">{t('auth.callback.error')}</p>
          </>
        )}
      </div>
    </div>
  );
}