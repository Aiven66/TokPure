'use client';

/**
 * 登录 / 注册页岛屿（login.html）。
 *
 * - `?mode=register` 渲染 <RegisterForm>，否则 <LoginForm>；
 * - 已登录时展示账号面板（含「进入管理后台」入口，仅管理员可见）；
 * - 桌面端 deep-link 流程由 <LoginForm> 内部处理（显示「返回 App」成功页）；
 * - Google 一键登录由 config.auth.googleEnabled 门控。
 */

import { Suspense } from 'react';
import { isAdminUser, LoginForm, RegisterForm, useAuth } from '@pkg';
import { PkgRoot } from '@/components/PkgRoot';
import { mount, readSiteLocale } from '@/lib/mount';
import { pkgConfig } from '@/lib/pkg-config';

function AccountPanel() {
  const { user, signOut } = useAuth();
  const isAdmin = isAdminUser(user, pkgConfig.admin.adminEmails);

  return (
    <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-2xl">
      <p className="text-sm text-muted-foreground">当前登录账号</p>
      <p className="mt-1 text-lg font-semibold text-foreground">{user?.email}</p>
      {user?.name && <p className="mt-1 text-sm text-muted-foreground">{user.name}</p>}

      <div className="mt-6 flex flex-col gap-3">
        {isAdmin && (
          <a
            href={pkgConfig.brand.adminPath}
            className="rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            进入管理后台
          </a>
        )}
        <a
          href={pkgConfig.brand.homeHref}
          className="rounded-xl border border-border px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          返回首页
        </a>
        <button
          type="button"
          onClick={() => void signOut()}
          className="rounded-xl px-4 py-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          退出登录
        </button>
      </div>
    </div>
  );
}

function AuthIsland() {
  const { user, loading } = useAuth();
  const mode = new URLSearchParams(window.location.search).get('mode');

  const handleSuccess = () => {
    window.location.assign(pkgConfig.auth.afterLoginHref);
  };

  if (loading) {
    return (
      <div className="w-full max-w-md py-12 text-center text-sm text-muted-foreground">
        正在校验登录状态…
      </div>
    );
  }

  if (user) return <AccountPanel />;

  return mode === 'register' ? (
    <RegisterForm onSuccess={handleSuccess} />
  ) : (
    <LoginForm onSuccess={handleSuccess} />
  );
}

function AuthRoot() {
  return (
    <PkgRoot initialLocale={readSiteLocale()}>
      <Suspense fallback={null}>
        <AuthIsland />
      </Suspense>
    </PkgRoot>
  );
}

mount('auth-root', <AuthRoot />);