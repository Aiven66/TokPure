'use client';

/**
 * pricing.html 的「行为桥接」岛。
 *
 * 页面视觉完全保留既有高度定制的营销设计，本岛只接管付费档 CTA 的点击行为：
 * 带 `data-checkout` 的按钮 → 公共组件配置的 pricing.onSubscribe → 宿主收银台；
 * 未登录且 requireAuthToSubscribe !== false 时，先跳 brand.registerHref
 * （带上 next=pricing.html?plan=xxx，注册完自动回到价格页继续购买）。
 */

import { useEffect } from 'react';
import { useAuth } from '@pkg';
import type { PlanConfig } from '@pkg';
import { PkgRoot } from '@/components/PkgRoot';
import { PaymentModal } from '@/components/PaymentModal';
import { mount, readSiteLocale } from '@/lib/mount';
import { pkgConfig } from '@/lib/pkg-config';

/** [data-checkout] 取值 → 收银台套餐标识（与页面档位一一对应）。 */
const CHECKOUT_PLANS: Record<string, { id: string; name: string; priceUsd: number }> = {
  pro: { id: 'tokpure-pro', name: 'TokPure 专业创作者版', priceUsd: 9.9 },
  studio: { id: 'tokpure-studio', name: 'TokPure 团队与工作室版', priceUsd: 29 },
};

/** 支付成功回跳时不要重复拉起收银台。 */
const params = new URLSearchParams(window.location.search);
const PAID_RETURN = params.get('payment') === 'success';

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
        // 记住想买的档位，登录 / 注册后回到价格页继续，不让购买意图丢失
        const next = `/pricing.html?plan=${el.dataset.checkout}`;
        window.location.href = `${pkgConfig.brand.registerHref}&next=${encodeURIComponent(next)}`;
        return;
      }
      // 只用到 id / name / price，其余 PlanConfig 字段由宿主收银台自行解析
      const planConfig = {
        id: plan.id,
        name: plan.name,
        price: { cn: plan.priceUsd, intl: plan.priceUsd },
      } as PlanConfig;
      void pkgConfig.pricing.onSubscribe?.(planConfig);
    };

    buttons.forEach((btn) => btn.addEventListener('click', onClick));
    return () => buttons.forEach((btn) => btn.removeEventListener('click', onClick));
  }, [user, loading]);

  // 从登录 / 注册页带 ?plan=pro 回来时，自动续上刚才的选择
  useEffect(() => {
    if (loading || !user || PAID_RETURN) return;
    const wanted = params.get('plan');
    const plan = wanted ? CHECKOUT_PLANS[wanted] : null;
    if (!plan) return;
    const planConfig = {
      id: plan.id,
      name: plan.name,
      price: { cn: plan.priceUsd, intl: plan.priceUsd },
    } as PlanConfig;
    void pkgConfig.pricing.onSubscribe?.(planConfig);
    // 只消费一次，避免刷新后再次弹出
    const url = new URL(window.location.href);
    url.searchParams.delete('plan');
    window.history.replaceState({}, '', url.pathname + url.search);
  }, [user, loading]);

  return null;
}

mount(
  'pricing-bridge',
  <PkgRoot initialLocale={readSiteLocale()}>
    <CheckoutBridge />
    <PaymentModal />
  </PkgRoot>,
);