'use client';

/**
 * PaymentModal —— 收银台弹窗（Creem / Waffo 二选一）。
 *
 * 由 pricing 岛挂载在 `<PkgRoot>` 内以取得登录态；订阅 checkout 总线的请求。
 * 流程：选渠道 → POST /api/payment/{channel} → 打开渠道收银台 → 轮询订单状态 → 成功。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@pkg';
import { onCheckoutRequest, type CheckoutItem } from '@/lib/checkout';

type Channel = 'creem' | 'waffo';
type Phase = 'select' | 'pending' | 'success' | 'error';

interface ChannelOption {
  id: Channel;
  label: string;
  desc: string;
  mark: string;
  markClass: string;
}

const CHANNELS: ChannelOption[] = [
  {
    id: 'creem',
    label: 'Creem',
    desc: '信用卡 · Apple Pay · Google Pay',
    mark: 'CR',
    markClass: 'bg-gradient-to-r from-violet-600 to-indigo-600',
  },
  {
    id: 'waffo',
    label: 'Waffo',
    desc: '全球本地化支付方式',
    mark: 'WF',
    markClass: 'bg-surface-container-highest',
  },
];

const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 60;

function formatPrice(priceUsd?: number): string {
  if (typeof priceUsd !== 'number' || priceUsd <= 0) return '';
  return `$${priceUsd}`;
}

export function PaymentModal() {
  const { user, accessToken } = useAuth();

  const [item, setItem] = useState<CheckoutItem | null>(null);
  const [phase, setPhase] = useState<Phase>('select');
  const [channel, setChannel] = useState<Channel>('creem');
  const [error, setError] = useState('');
  const [checkoutUrl, setCheckoutUrl] = useState('');
  const [pollUrl, setPollUrl] = useState('');
  const [manualChecking, setManualChecking] = useState(false);

  const closeRef = useRef<() => void>(() => {});

  const close = useCallback(() => {
    setItem(null);
    setPhase('select');
    setError('');
    setCheckoutUrl('');
    setPollUrl('');
    setManualChecking(false);
  }, []);
  closeRef.current = close;

  // 订阅 checkout 总线
  useEffect(
    () =>
      onCheckoutRequest((next) => {
        setItem(next);
        setPhase('select');
        setError('');
        setCheckoutUrl('');
        setPollUrl('');
        setManualChecking(false);
      }),
    [],
  );

  // Esc 关闭
  useEffect(() => {
    if (!item) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item]);

  const verifyOnce = useCallback(async (): Promise<boolean> => {
    if (!pollUrl) return false;
    try {
      const res = await fetch(pollUrl, {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      return Boolean(data && data.paid);
    } catch {
      return false;
    }
  }, [pollUrl, accessToken]);

  // 支付成功后轮询订单状态
  useEffect(() => {
    if (phase !== 'pending' || !pollUrl) return undefined;
    let cancelled = false;
    let attempts = 0;
    const timer = window.setInterval(async () => {
      attempts += 1;
      if (attempts > MAX_POLLS) {
        window.clearInterval(timer);
        return;
      }
      const paid = await verifyOnce();
      if (!cancelled && paid) {
        window.clearInterval(timer);
        setPhase('success');
      }
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, pollUrl, verifyOnce]);

  const startPayment = useCallback(
    async (ch: Channel) => {
      if (!item) return;
      if (!user || !accessToken) {
        setError('请先登录后再购买');
        setPhase('error');
        return;
      }

      setChannel(ch);
      setPhase('pending');
      setError('');

      // 同步预开窗口，避免 await 之后被浏览器拦截
      const win = window.open('about:blank', '_blank');
      if (win) {
        try {
          win.opener = null;
        } catch {
          /* 跨域限制时忽略 */
        }
      }

      try {
        const res = await fetch(`/api/payment/${ch}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ planId: item.id, origin: window.location.origin }),
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok || data.error) {
          if (win) win.close();
          setError(data.error || `请求失败（HTTP ${res.status}）`);
          setPhase('error');
          return;
        }

        const url: string = data.checkoutUrl || '';
        if (!url) {
          if (win) win.close();
          setError('收银台地址为空，请稍后重试');
          setPhase('error');
          return;
        }

        setCheckoutUrl(url);
        setPollUrl(
          ch === 'creem'
            ? `/api/payment/creem?session_id=${encodeURIComponent(data.sessionId || '')}`
            : `/api/payment/waffo?user_id=${encodeURIComponent(user.id)}`,
        );

        if (win) win.location.href = url;
        else window.open(url, '_blank', 'noopener,noreferrer');
      } catch {
        if (win) win.close();
        setError('网络异常，请稍后重试');
        setPhase('error');
      }
    },
    [item, user, accessToken],
  );

  const handleManualCheck = useCallback(async () => {
    setManualChecking(true);
    setError('');
    const paid = await verifyOnce();
    if (paid) setPhase('success');
    else setError('尚未检测到支付完成，请先在新窗口完成付款后再试。');
    setManualChecking(false);
  }, [verifyOnce]);

  if (!item) return null;

  const price = formatPrice(item.priceUsd);
  const active = CHANNELS.find((c) => c.id === channel) || CHANNELS[0];

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex: 2147483000, background: 'rgba(6,7,10,0.72)' }}
      onClick={close}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-xl bg-surface-container p-6 shadow-2xl"
        style={{ border: '1px solid #333539' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="支付"
      >
        {/* 头部 */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-headline-lg text-headline-lg text-on-surface font-bold">
              {phase === 'success' ? '支付成功' : item.name || '升级套餐'}
            </h2>
            <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">
              {item.kind === 'pack' ? '一次性付费，永久有效' : '按月订阅，可随时取消'}
              {price ? ` · ${price}${item.kind === 'pack' ? '' : ' / 月'}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="关闭"
            className="shrink-0 w-8 h-8 rounded-lg bg-surface-container-high text-on-surface-variant hover:text-on-surface transition-colors"
          >
            ✕
          </button>
        </div>

        {/* 选择渠道 */}
        {phase === 'select' && (
          <div className="mt-6 space-y-3">
            {CHANNELS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => startPayment(c.id)}
                className="w-full flex items-center gap-3 p-3.5 rounded-lg bg-surface-container-low hover:bg-surface-container-high transition-colors text-left"
                style={{ border: '1px solid #333539' }}
              >
                <span
                  className={`w-10 h-10 rounded-lg flex items-center justify-center font-bold text-on-surface text-sm ${c.markClass}`}
                >
                  {c.mark}
                </span>
                <span className="flex-1">
                  <span className="block font-headline-sm text-headline-sm text-on-surface">{c.label}</span>
                  <span className="block font-body-sm text-body-sm text-on-surface-variant">{c.desc}</span>
                </span>
                <span className="text-on-surface-variant">›</span>
              </button>
            ))}
            <p className="font-label-sm text-label-sm text-on-surface-variant text-center pt-1">
              🔒 256 位 SSL 加密 · 支付完成后权益立即生效
            </p>
          </div>
        )}

        {/* 等待支付 */}
        {phase === 'pending' && (
          <div className="mt-6">
            <div className="flex items-center gap-3 p-4 rounded-lg bg-surface-container-low">
              <span
                className="w-5 h-5 rounded-full border-2 border-on-surface-variant shrink-0 animate-spin"
                style={{ borderTopColor: 'transparent' }}
              />
              <div className="font-body-sm text-body-sm text-on-surface-variant">
                已在新窗口打开 <span className="text-on-surface">{active.label}</span> 收银台，正在等待支付结果…
              </div>
            </div>
            {error && <p className="font-body-sm text-body-sm mt-3 text-primary">{error}</p>}
            <div className="flex flex-col gap-2 mt-5">
              <button
                type="button"
                onClick={handleManualCheck}
                disabled={manualChecking}
                className="w-full py-3 rounded-lg bg-primary-container text-on-primary-container font-headline-sm text-headline-sm font-bold hover:brightness-110 transition-all disabled:opacity-60"
              >
                {manualChecking ? '检测中…' : '我已完成支付'}
              </button>
              {checkoutUrl && (
                <button
                  type="button"
                  onClick={() => window.open(checkoutUrl, '_blank', 'noopener,noreferrer')}
                  className="w-full py-3 rounded-lg bg-surface-container-high text-on-surface font-headline-sm text-headline-sm hover:bg-surface-container-highest transition-colors"
                >
                  重新打开收银台
                </button>
              )}
            </div>
          </div>
        )}

        {/* 成功 */}
        {phase === 'success' && (
          <div className="mt-6">
            <div className="flex items-center gap-3 p-4 rounded-lg bg-tertiary-container/30">
              <span className="w-8 h-8 rounded-full bg-tertiary text-on-tertiary flex items-center justify-center font-bold">
                ✓
              </span>
              <div className="font-body-sm text-body-sm text-on-surface">
                {item.name || '套餐'}已开通，权益已同步到你的账号。
              </div>
            </div>
            <button
              type="button"
              onClick={close}
              className="w-full mt-5 py-3 rounded-lg bg-primary-container text-on-primary-container font-headline-sm text-headline-sm font-bold hover:brightness-110 transition-all"
            >
              完成
            </button>
          </div>
        )}

        {/* 失败 */}
        {phase === 'error' && (
          <div className="mt-6">
            <div className="p-4 rounded-lg bg-surface-container-low font-body-sm text-body-sm text-on-surface-variant">
              {error || '支付未能完成，请重试。'}
            </div>
            <div className="flex flex-col gap-2 mt-5">
              <button
                type="button"
                onClick={() => startPayment(channel)}
                className="w-full py-3 rounded-lg bg-primary-container text-on-primary-container font-headline-sm text-headline-sm font-bold hover:brightness-110 transition-all"
              >
                重试
              </button>
              <button
                type="button"
                onClick={() => {
                  setPhase('select');
                  setError('');
                }}
                className="w-full py-3 rounded-lg bg-surface-container-high text-on-surface font-headline-sm text-headline-sm hover:bg-surface-container-highest transition-colors"
              >
                换个支付方式
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default PaymentModal;
