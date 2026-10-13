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

/**
 * 读取官网当前语言。
 *
 * 唯一真源是 assets/js/i18n.js 写入的 localStorage `tokpure.lang`（站点切换器写的就是它）。
 * 早期版本误读 `locale` 键（public-pkg 自己的存储），两套系统永远对不上，
 * 导致站点切到 English 后 React 岛屿（登录按钮、登录页表单）仍渲染中文。
 * 站点默认语言是英文（用户未手动切换过时 i18n.js 也按 en 渲染），这里保持一致。
 */
export function readSiteLocale(): Locale {
  try {
    const site = (localStorage.getItem('tokpure.lang') || '').trim();
    if (site) return siteLangToPkg(site);
  } catch {
    /* 存储不可用时按站点默认（en）处理 */
  }
  return 'en';
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