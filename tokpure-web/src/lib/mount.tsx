'use client';

/**
 * 把 React 岛屿挂载到既有静态页的容器上。
 * 每页一个入口（src/entries/*.tsx），HTML 里只需一个空容器 + 一个 module script。
 */

import { StrictMode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Locale } from '@pkg';

/** 读取官网既有语言偏好（与 assets/js/i18n.js 使用同一套键）。 */
export function readSiteLocale(): Locale {
  try {
    const fromCookie = document.cookie.match(/(?:^|;\s*)locale=([^;]+)/)?.[1];
    const raw = (fromCookie || localStorage.getItem('locale') || '').trim();
    if (raw) {
      if (raw === 'zh' || raw === 'zh-CN') return 'zh';
      if (raw === 'zh-TW' || raw === 'zh-Hant') return 'zh-Hant';
      return 'en';
    }
  } catch {
    /* 存储不可用时继续按 <html lang> 判断 */
  }
  // 回落到页面语言（login.html 默认 lang="zh-CN"）
  const htmlLang = typeof document !== 'undefined' ? document.documentElement.lang : '';
  if (htmlLang.startsWith('zh-Hant') || htmlLang === 'zh-TW') return 'zh-Hant';
  if (htmlLang.startsWith('zh')) return 'zh';
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