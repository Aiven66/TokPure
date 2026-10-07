/**
 * 收银台跳转（pricing.onSubscribe / onBuyPack 的实际动作）。
 *
 * public-pkg 的 <Pricing /> 不内置任何支付 SDK，点击 CTA 只回调宿主这里。
 * 支付地址是可配置的：在 .env / Vercel 设置
 *   VITE_CHECKOUT_URL=https://your-checkout.example.com/pay
 * 未配置时给出手势提示（“支付即将开放”），绝不静默失败。
 */

import { showToast } from './toast';

export interface CheckoutItem {
  id: string;
  kind: 'plan' | 'pack';
  name?: string;
}

const CHECKOUT_URL = (import.meta.env.VITE_CHECKOUT_URL as string | undefined) || '';

export function openCheckout(item: CheckoutItem): void {
  if (!CHECKOUT_URL) {
    showToast('支付即将开放，敬请期待');
    return;
  }
  try {
    const url = new URL(CHECKOUT_URL, window.location.origin);
    url.searchParams.set('item', item.id);
    url.searchParams.set('kind', item.kind);
    if (item.name) url.searchParams.set('name', item.name);
    // 支付完成后回到定价页（收银台可通过 next 参数带回）
    url.searchParams.set('next', `${window.location.origin}/pricing.html`);
    window.open(url.toString(), '_blank', 'noopener');
  } catch {
    showToast('收银台地址配置有误，请检查 VITE_CHECKOUT_URL');
  }
}