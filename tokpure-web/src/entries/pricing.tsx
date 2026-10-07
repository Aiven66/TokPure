'use client';

/**
 * pricing.html 的「行为桥接」岛。
 *
 * 页面视觉完全保留既有高度定制的营销设计，本岛只接管付费档 CTA 的点击行为：
 * 带 `data-checkout` 的按钮 → 公共组件配置的 pricing.onSubscribe → 宿主收银台；
 * 未登录且 requireAuthToSubscribe !== false 时，先跳 brand.registerHref。
 */

import { useEffect } from 'react';
import { useAuth } from '@pkg';
import type { PlanConfig } from '@pkg';
import { PkgRoot } from '@/components/PkgRoot';
import { mount, readSiteLocale } from '@/lib/mount';
import { pkgConfig } from '@/lib/pkg-config';

/** [data-checkout] 取值 → 收银台套餐标识（与页面档位一一对应）。 */
const CHECKOUT_PLANS: Record<string, { id: string; name: string }> = {
  pro: { id: 'tokpure-pro', name: 'TokPure 专业创作者版' },
  studio: { id: 'tokpure-studio', name: 'TokPure 团队与工作室版' },
};

function CheckoutBridge() {
  const { user, loading } = useAuth();

  useEffect(() => {
    const buttons = Array.from(document.querySelectorAll<HTMLElement>('[data-checkout]'));
    if (buttons.length === 0) return;

    const onClick = (event: Event) => {
      const el = event.currentTarget as HTMLElement;
      const plan = CHECKOUT_PLANS[el.dataset.checkout ?? ''];
      if (!plan) return;
      // 会话恢复中暂不接管，避免把已登录用户误判为未登录
      if (loading) return;

      event.preventDefault();
      if (pkgConfig.pricing.requireAuthToSubscribe !== false && !user) {
        window.location.href = pkgConfig.brand.registerHref;
        return;
      }
      // 只用到 id / name，其余 PlanConfig 字段由宿主收银台自行解析
      const planConfig = { id: plan.id, name: plan.name } as PlanConfig;
      void pkgConfig.pricing.onSubscribe?.(planConfig);
    };

    buttons.forEach((btn) => btn.addEventListener('click', onClick));
    return () => buttons.forEach((btn) => btn.removeEventListener('click', onClick));
  }, [user, loading]);

  return null;
}

mount(
  'pricing-bridge',
  <PkgRoot initialLocale={readSiteLocale()}>
    <CheckoutBridge />
  </PkgRoot>,
);