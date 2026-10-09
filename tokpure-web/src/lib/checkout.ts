/**
 * 收银台请求总线。
 *
 * public-pkg 的 `<Pricing />` 与 pricing.html 的 `[data-checkout]` 点击后统一走到这里，
 * 由页面挂载的 `<PaymentModal />` 订阅请求并完成实际支付（Creem / Waffo 二选一）。
 * 没有订阅者时给出提示，绝不静默失败。
 */

import { showToast } from './toast';

export interface CheckoutItem {
  /** 套餐标识，与 /api/payment 的套餐目录一一对应（如 tokpure-pro）。 */
  id: string;
  kind: 'plan' | 'pack';
  name?: string;
  /** 展示用价格（美元/月）。真实金额以收银台为准。 */
  priceUsd?: number;
}

type Listener = (item: CheckoutItem) => void;

const listeners = new Set<Listener>();

/** 订阅收银台请求；返回取消订阅函数。 */
export function onCheckoutRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 打开收银台（由 `<PaymentModal />` 承接）。 */
export function openCheckout(item: CheckoutItem): void {
  if (listeners.size === 0) {
    showToast('支付功能尚未就绪，请刷新页面后重试');
    return;
  }
  listeners.forEach((listener) => listener(item));
}
