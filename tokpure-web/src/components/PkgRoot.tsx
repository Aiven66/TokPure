'use client';

/**
 * PkgRoot —— 官网所有 React 岛屿的统一根。
 *
 * 顺序必须为 PublicPkgProvider（外层）→ LocaleBridge → AuthProvider（内层），
 * 与 public-pkg 的设计约定一致（AuthProvider 内部依赖 usePkgConfig）。
 *
 * LocaleBridge 负责把岛屿语言与站点切换器（assets/js/i18n.js，localStorage
 * 键 `tokpure.lang`）双向对齐：
 * - 挂载时立刻按站点当前语言校正一次（自愈 public-pkg 自己的旧 `locale` 存储）；
 * - 监听 `tokpure:langchange` 事件，用户在页面里切换语言时岛屿实时跟随，
 *   无需刷新（修复「切到 English 后登录按钮/登录页仍是中文」）。
 */

import { useEffect, type ReactNode } from 'react';
import { AuthProvider, PublicPkgProvider, usePublicPkg } from '@pkg';
import type { Locale } from '@pkg';
import { pkgConfig } from '@/lib/pkg-config';
import { readSiteLocale, siteLangToPkg } from '@/lib/mount';

function LocaleBridge() {
  const { locale, setLocale } = usePublicPkg();

  // 挂载校正：以站点语言为准（readSiteLocale 的唯一真源是 tokpure.lang）
  useEffect(() => {
    const site = readSiteLocale();
    if (site !== locale) setLocale(site);
    // 仅在挂载时校正一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 运行时跟随站点切换器
  useEffect(() => {
    const onLangChange = (event: Event) => {
      const lang = (event as CustomEvent<{ lang?: string }>).detail?.lang;
      if (lang) setLocale(siteLangToPkg(lang));
    };
    window.addEventListener('tokpure:langchange', onLangChange);
    return () => window.removeEventListener('tokpure:langchange', onLangChange);
  }, [setLocale]);

  return null;
}

export interface PkgRootProps {
  children: ReactNode;
  /** 与官网既有语言（assets/js/i18n.js）对齐，避免首屏语言闪动。 */
  initialLocale?: Locale;
}

export function PkgRoot({ children, initialLocale }: PkgRootProps) {
  return (
    <PublicPkgProvider config={pkgConfig} initialLocale={initialLocale}>
      <LocaleBridge />
      <AuthProvider>{children}</AuthProvider>
    </PublicPkgProvider>
  );
}

export { pkgConfig };
