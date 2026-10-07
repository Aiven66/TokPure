'use client';

/**
 * <AdminGate> —— 管理后台内容门控（客户端）。
 *
 * 用法（需包裹在 <PublicPkgProvider> 与 public-pkg auth 的 <AuthProvider> 内）：
 *   <AdminGate>{children}</AdminGate>
 *
 * 行为：
 * - 当前路径为后台登录页（config.admin.loginPath / config.brand.adminLoginPath）时直接放行；
 * - 未登录 / 无 token / 既非 admin 也未命中 config.admin.adminEmails 白名单 → 重定向到登录页；
 * - 校验中显示居中 spinner + t('admin.verifying')；
 * - **必须**通过服务端校验（adapters.admin.verifyAdmin，未注入则回落到内置 fetch
 *   config.admin.verifyEndpoint）后才渲染 children；白名单只作为「是否值得发起校验」的前置信号，
 *   不能单独放行。校验通过后用 ref 缓存，避免重复请求。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { usePublicPkg } from '../config/provider';
import { useAuth } from '../auth/auth-context';

/**
 * 纯前端判断：`role === 'admin'` 或命中邮箱白名单。
 * **仅用于 UI 显隐提示**，不得作为后台内容的唯一门控（门控请用 <AdminGate>）。
 *
 * 注：白名单来自 config.admin.adminEmails，由调用方传入（组件内可传
 * `usePublicPkg().config.admin.adminEmails`）。
 */
export function isAdminUser(
  u: { email?: string | null; role?: string | null } | null,
  adminEmails: string[] = [],
): boolean {
  if (!u) return false;
  if (u.role === 'admin') return true;
  const email = u.email?.trim().toLowerCase();
  if (!email) return false;
  return adminEmails.some((e) => e.trim().toLowerCase() === email);
}

export interface AdminGateProps {
  children: ReactNode;
}

export function AdminGate({ children }: AdminGateProps) {
  const { config, t } = usePublicPkg();
  const { user, accessToken } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const loginPath = config.admin.loginPath || config.brand.adminLoginPath;
  const isOnLoginPage =
    pathname === config.admin.loginPath || pathname === config.brand.adminLoginPath;

  const [state, setState] = useState<'checking' | 'authenticated' | 'unauthorized'>('checking');
  const verifiedRef = useRef(false);

  const verify = useCallback(
    async (token: string): Promise<boolean> => {
      const adapter = config.adapters?.admin;
      if (adapter?.verifyAdmin) {
        try {
          return !!(await adapter.verifyAdmin(token));
        } catch {
          return false;
        }
      }
      try {
        const res = await fetch(config.admin.verifyEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          cache: 'no-store',
        });
        if (!res.ok) return false;
        const data = await res.json();
        return !!data?.isAdmin;
      } catch {
        return false;
      }
    },
    [config.adapters?.admin, config.admin.verifyEndpoint],
  );

  const check = useCallback(async () => {
    if (isOnLoginPage) {
      setState('unauthorized');
      return;
    }

    if (!accessToken || !user) {
      setState('unauthorized');
      router.replace(loginPath);
      return;
    }

    const hasAdminClaim = user.role === 'admin';
    const hasAdminEmail = isAdminUser(user, config.admin.adminEmails);

    if (!hasAdminClaim && !hasAdminEmail) {
      setState('unauthorized');
      router.replace(loginPath);
      return;
    }

    if (verifiedRef.current) {
      setState('authenticated');
      return;
    }

    const verified = await verify(accessToken);
    if (verified) {
      verifiedRef.current = true;
      setState('authenticated');
    } else {
      setState('unauthorized');
      router.replace(loginPath);
    }
  }, [isOnLoginPage, accessToken, user, config.admin.adminEmails, loginPath, router, verify]);

  useEffect(() => {
    check();
  }, [check]);

  if (isOnLoginPage) {
    return <>{children}</>;
  }

  if (state === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="mb-4 inline-block h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-muted-foreground">{t('admin.verifying')}</p>
        </div>
      </div>
    );
  }

  if (state === 'unauthorized') {
    return null;
  }

  return <>{children}</>;
}