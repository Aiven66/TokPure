'use client';

/**
 * PublicPkgProvider —— 包裹四个公共模块的最外层 Provider，负责：
 * 1. 把用户传入的 `PublicPkgConfig` 填好默认值（`ResolvedConfig`）；
 * 2. 管理界面语言（cookie + localStorage 持久化，与宿主项目约定一致）；
 * 3. 暴露翻译函数 `t`。
 *
 * 典型用法：
 *   <PublicPkgProvider config={pkgConfig}>
 *     <AuthProvider>      (来自 public-pkg/auth)
 *       {children}
 *     </AuthProvider>
 *   </PublicPkgProvider>
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
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  createTranslator,
  isLocale,
  type Locale,
  type Translator,
} from '../lib/i18n';
import { createDefaultConfig } from './defaults';
import type { PublicPkgConfig, ResolvedConfig } from './types';

export interface PublicPkgContextValue {
  config: ResolvedConfig;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translator;
}

const PublicPkgContext = createContext<PublicPkgContextValue | undefined>(undefined);

export interface PublicPkgProviderProps {
  config: PublicPkgConfig;
  children: ReactNode;
  /** 服务端渲染时可传入已解析的语言，避免首屏闪动。 */
  initialLocale?: Locale;
}

export function PublicPkgProvider({ config, children, initialLocale }: PublicPkgProviderProps) {
  const resolved = useMemo(() => createDefaultConfig(config), [config]);
  const storageKey = resolved.i18n.storageKey || LOCALE_STORAGE_KEY;
  const [locale, setLocaleState] = useState<Locale>(
    initialLocale ?? resolved.i18n.locale ?? DEFAULT_LOCALE,
  );

  // 首次挂载：优先读 cookie（与 SSR 共用），回落 localStorage。
  useEffect(() => {
    try {
      const cookieMatch = document.cookie.match(/(?:^|;\s*)locale=([^;]+)/);
      const saved = cookieMatch?.[1] || localStorage.getItem(storageKey);
      if (saved && isLocale(saved)) setLocaleState(saved);
    } catch {
      /* 存储不可用时保持默认语言 */
    }
  }, [storageKey]);

  const setLocale = useCallback(
    (next: Locale) => {
      if (!isLocale(next)) return;
      setLocaleState(next);
      try {
        localStorage.setItem(storageKey, next);
        document.cookie = `locale=${next}; path=/; max-age=31536000; samesite=lax`;
        document.documentElement.lang = next;
      } catch {
        /* 忽略持久化失败 */
      }
    },
    [storageKey],
  );

  const t = useMemo(
    () => createTranslator(locale, resolved.i18n.dictionary),
    [locale, resolved.i18n.dictionary],
  );

  const value = useMemo<PublicPkgContextValue>(
    () => ({ config: resolved, locale, setLocale, t }),
    [resolved, locale, setLocale, t],
  );

  return <PublicPkgContext.Provider value={value}>{children}</PublicPkgContext.Provider>;
}

export function usePublicPkg(): PublicPkgContextValue {
  const ctx = useContext(PublicPkgContext);
  if (!ctx) {
    throw new Error('usePublicPkg must be used within a <PublicPkgProvider>');
  }
  return ctx;
}

/** 只取翻译函数。 */
export function useT(): Translator {
  return usePublicPkg().t;
}

/** 只取配置。 */
export function usePkgConfig(): ResolvedConfig {
  return usePublicPkg().config;
}