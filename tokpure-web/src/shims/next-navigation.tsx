'use client';

/**
 * `next/navigation` 兼容 shim。
 *
 * public-pkg 的 6 个组件依赖 Next 的 useRouter / useSearchParams / usePathname，
 * 官网是 Vite 多页应用，这里提供等价能力：
 * - 维护一个「当前地址」store，push/replace 走 History API 并通知订阅者；
 * - shim 站点是多页（.html），导航默认整页跳转（location.assign），
 *   保证跨页面（login.html / pricing.html / blog.html …）行为正确。
 */

import { useEffect, useMemo, useState } from 'react';

type Listener = () => void;

const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((fn) => fn());
}

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function currentPathname(): string {
  return typeof window === 'undefined' ? '/' : window.location.pathname;
}

function currentSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search;
}

if (typeof window !== 'undefined') {
  // 浏览器前进/后退时同步订阅者。
  window.addEventListener('popstate', notify);
}

export interface AppRouter {
  push: (href: string) => void;
  replace: (href: string) => void;
  back: () => void;
  forward: () => void;
  refresh: () => void;
  prefetch: (href?: string) => void;
}

export function useRouter(): AppRouter {
  return useMemo<AppRouter>(
    () => ({
      push: (href) => {
        if (typeof window === 'undefined') return;
        window.location.assign(href);
      },
      replace: (href) => {
        if (typeof window === 'undefined') return;
        window.location.replace(href);
      },
      back: () => window.history.back(),
      forward: () => window.history.forward(),
      refresh: () => {
        if (typeof window === 'undefined') return;
        window.location.reload();
      },
      prefetch: () => {},
    }),
    [],
  );
}

/** 读取地址栏查询参数；popstate 时自动更新。 */
export function useSearchParams(): URLSearchParams {
  const [search, setSearch] = useState<string>(currentSearch);
  useEffect(() => {
    setSearch(currentSearch());
    return subscribe(() => setSearch(currentSearch()));
  }, []);
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function usePathname(): string {
  const [pathname, setPathname] = useState<string>(currentPathname);
  useEffect(() => {
    setPathname(currentPathname());
    return subscribe(() => setPathname(currentPathname()));
  }, []);
  return pathname;
}

/** 非 hook 场景下读取当前地址（供工具函数使用）。 */
export function getCurrentHref(): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.pathname}${window.location.search}`;
}