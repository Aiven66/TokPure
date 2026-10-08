'use client';

/**
 * 公开页头部登录态岛（index / download / about / pricing / blog / blog-detail）。
 *
 * 这些页面的头部「登录」入口原本是静态 HTML 硬编码，无论是否已登录都恒显示
 * 未登录状态（Google 一键登录回跳后同样如此）。本岛接管该区域：
 * - 未登录：渲染「登录」入口（样式与静态页一致）；
 * - 已登录：渲染账号头像 + 下拉菜单（管理员含「进入后台」，所有人含「退出登录」）。
 *
 * 采用「桥接岛」渐进增强：静态 HTML 里的登录入口与占位头像保留为无 JS 时的兜底，
 * 岛挂载后将其隐藏，改由 React 渲染。
 */

import { useEffect, useRef, useState } from 'react';
import { isAdminUser, useAuth, useT } from '@pkg';
import { PkgRoot } from '@/components/PkgRoot';
import { hide, mount, readSiteLocale } from '@/lib/mount';
import { pkgConfig } from '@/lib/pkg-config';

/** 与静态页头部登录入口完全一致的样式，避免挂载前后视觉跳动。 */
const LOGIN_LINK_CLASS =
  'hidden sm:inline-block font-headline-sm text-headline-sm text-on-surface-variant hover:text-on-surface transition-colors px-2';

/** 头像回退：取用户名/邮箱首字符。 */
function initial(name: string | null, email: string): string {
  return ((name || email || '?').trim().charAt(0) || '?').toUpperCase();
}

function HeaderAuth() {
  const { user, loading, signOut } = useAuth();
  const t = useT();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 隐藏静态页里的占位入口（无 JS 时仍是兜底）
  useEffect(() => {
    hide('header a[data-path="login"]');
    hide('header [data-header-avatar]');
  }, []);

  // 点击菜单外部或按 Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (loading) return null;

  if (!user) {
    return (
      <a className={LOGIN_LINK_CLASS} href={pkgConfig.brand.loginHref ?? '/login.html'}>
        {t('login.submitButton')}
      </a>
    );
  }

  const isAdmin = isAdminUser(user, pkgConfig.admin.adminEmails);

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-full p-0.5 sm:pr-3 hover:bg-surface-container-high transition-colors"
      >
        <span className="w-8 h-8 rounded-full bg-primary flex items-center justify-center overflow-hidden shrink-0">
          {user.avatarUrl ? (
            <img alt={user.name || user.email} src={user.avatarUrl} className="w-8 h-8 object-cover" />
          ) : (
            <span className="font-headline-sm text-headline-sm text-on-primary">
              {initial(user.name, user.email)}
            </span>
          )}
        </span>
        <span className="hidden sm:inline-block max-w-[140px] truncate font-headline-sm text-headline-sm text-on-surface">
          {user.name || user.email}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-2 w-64 rounded-xl border border-outline-variant/40 bg-surface-container shadow-[0_16px_48px_rgba(0,0,0,0.55)] overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-outline-variant/30">
            <p className="font-headline-sm text-headline-sm text-on-surface truncate">
              {user.name || user.email}
            </p>
            {user.name && (
              <p className="mt-0.5 font-body-sm text-body-sm text-on-surface-variant truncate">
                {user.email}
              </p>
            )}
          </div>
          <div className="p-1.5">
            {isAdmin && (
              <a
                role="menuitem"
                href={pkgConfig.brand.adminPath ?? '/admin.html'}
                className="block rounded-lg px-3 py-2 font-headline-sm text-headline-sm text-on-surface hover:bg-surface-container-high transition-colors"
              >
                {t('admin.dashboard')}
              </a>
            )}
            <button
              role="menuitem"
              type="button"
              onClick={() => void signOut()}
              className="block w-full text-left rounded-lg px-3 py-2 font-headline-sm text-headline-sm text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors"
            >
              {t('admin.logout')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

mount(
  'site-header-auth',
  <PkgRoot initialLocale={readSiteLocale()}>
    <HeaderAuth />
  </PkgRoot>,
);