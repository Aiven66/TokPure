'use client';

/**
 * 把 React 岛屿挂载到既有静态页的容器上。
 * 每页一个入口（src/entries/*.tsx），HTML 里只需一个空容器 + 一个 module script。
 */

import { StrictMode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Locale } from '@pkg';

/** 站点语言代码（assets/js/i18n.js 的 8 种）→ public-pkg 语言（3 种）映射。 */
export function siteLangToPkg(code: string): Locale {
  if (code === 'zh-CN') return 'zh';
  if (code === 'zh-TW' || code === 'zh-Hant') return 'zh-Hant';
  return 'en';
}

/** 站点支持的语言代码（与 assets/js/i18n.js 的 LANGS 一致）。 */
export const SITE_LANGS = ['en', 'zh-CN', 'zh-TW', 'es', 'pt', 'fr', 'de', 'ja'] as const;

/**
 * 读取官网当前语言代码（8 种之一）。
 *
 * 唯一真源是 assets/js/i18n.js 写入的 localStorage `tokpure.lang`，且必须带
 * `tokpure.lang.manual=1` 标记才算「用户主动选择」；否则按站点默认英文处理
 * （与 i18n.js 的 detect() 完全同一套规则）。
 */
export function readSiteLang(): string {
  try {
    const manual = localStorage.getItem('tokpure.lang.manual');
    const saved = (localStorage.getItem('tokpure.lang') || '').trim();
    if (manual === '1' && (SITE_LANGS as readonly string[]).includes(saved)) return saved;
  } catch {
    /* 存储不可用时按站点默认（en）处理 */
  }
  return 'en';
}

/** 读取官网当前语言，映射为 public-pkg 的 3 值语言（岛屿文案只有 en/zh/zh-Hant）。 */
export function readSiteLocale(): Locale {
  return siteLangToPkg(readSiteLang());
}

/**
 * 把 <html lang> 校正为站点语言。
 *
 * public-pkg 的 `setLocale()` 会写 `document.documentElement.lang`，但它只认
 * en / zh / zh-Hant 三种语言：切到日本語时 `siteLangToPkg('ja')` 得到 `'en'`，
 * 于是岛屿更新语言后会把 i18n.js 写好的 `lang="ja"` 覆盖成 `lang="en"`
 * （无障碍朗读与搜索引擎语言判定都因此出错）。岛屿改语言后必须调一次本函数。
 */
export function syncHtmlLang(): void {
  const lang = readSiteLang();
  const d = document.documentElement;
  if (d.getAttribute('lang') !== lang) d.setAttribute('lang', lang);
  if (d.getAttribute('data-lang') !== lang) d.setAttribute('data-lang', lang);
}

export function mount(rootId: string, node: ReactElement): void {
  const el = document.getElementById(rootId);
  if (!el) {
    console.warn(`[tokpure] 未找到挂载容器 #${rootId}`);
    return;
  }
  createRoot(el).render(<StrictMode>{node}</StrictMode>);
}

/** 隐藏既有静态页里的占位区块（被 React 岛屿替换的旧内容）。 */
export function hide(selector: string): void {
  document.querySelectorAll<HTMLElement>(selector).forEach((el) => {
    el.style.display = 'none';
  });
}