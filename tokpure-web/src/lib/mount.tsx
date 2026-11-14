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

/** 把任意 BCP-47 语言标签归一到站点 8 种语言；认不出返回空串。 */
function normalizeSiteLang(tag?: string | null): string {
  const t = String(tag || '').toLowerCase();
  if (!t) return '';
  if (t === 'zh' || t === 'zh-hans' || t === 'zh-cn' || t === 'zh-sg') return 'zh-CN';
  if (t === 'zh-tw' || t === 'zh-hk' || t === 'zh-mo' || t === 'zh-hant') return 'zh-TW';
  const base = t.split('-')[0];
  return (SITE_LANGS as readonly string[]).includes(base) ? base : '';
}

/**
 * 读取官网当前语言代码（8 种之一）。
 *
 * 规则与 assets/js/i18n.js 的 detect() 保持一致，否则岛屿挂载后会调用
 * syncHtmlLang() 把 i18n.js 写好的 lang 覆盖掉：
 *   ?lang= 显式指定 > 用户手动切换过的偏好 > 浏览器语言 > 英文兜底。
 */
export function readSiteLang(): string {
  try {
    const byQuery = normalizeSiteLang(new URLSearchParams(window.location.search).get('lang'));
    if (byQuery) return byQuery;
  } catch {
    /* URL 解析失败时继续往后判断 */
  }
  try {
    const manual = localStorage.getItem('tokpure.lang.manual');
    const saved = normalizeSiteLang(localStorage.getItem('tokpure.lang'));
    if (manual === '1' && saved) return saved;
  } catch {
    /* 存储不可用：走浏览器语言 */
  }
  const list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
  for (const tag of list) {
    const hit = normalizeSiteLang(tag);
    if (hit) return hit;
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

/**
 * 移除静态兜底标题（`[data-tp-fallback]`）。
 *
 * 博客列表/详情是纯客户端渲染，静态 HTML 里放了一份 sr-only 的 h1/h2 供不执行 JS 的
 * 爬虫（含 LLM 抓取器）读到标题；岛屿渲染后自己会输出 h1，若不删掉这份兜底就会变成
 * 一个页面两个 h1。这里在挂载完成后由入口主动清理。
 */
export function dropStaticFallback(): void {
  document.querySelectorAll('[data-tp-fallback]').forEach((el) => el.remove());
}