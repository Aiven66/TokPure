'use client';

/**
 * PkgRoot —— 官网所有 React 岛屿的统一根。
 *
 * 顺序必须为 PublicPkgProvider（外层）→ AuthProvider（内层），
 * 与 public-pkg 的设计约定一致（AuthProvider 内部依赖 usePkgConfig）。
 */

import type { ReactNode } from 'react';
import { AuthProvider, PublicPkgProvider } from '@pkg';
import type { Locale } from '@pkg';
import { pkgConfig } from '@/lib/pkg-config';

export interface PkgRootProps {
  children: ReactNode;
  /** 与官网既有语言（assets/js/i18n.js）对齐，避免首屏语言闪动。 */
  initialLocale?: Locale;
}

export function PkgRoot({ children, initialLocale }: PkgRootProps) {
  return (
    <PublicPkgProvider config={pkgConfig} initialLocale={initialLocale}>
      <AuthProvider>{children}</AuthProvider>
    </PublicPkgProvider>
  );
}

export { pkgConfig };