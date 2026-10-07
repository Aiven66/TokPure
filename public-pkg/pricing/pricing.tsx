'use client';

/**
 * <Pricing /> —— 可配置、自包含的定价页组件（public-pkg/pricing）。
 *
 * 用法：
 *   <PublicPkgProvider config={pkgConfig}>
 *     <Pricing user={user} />     // user 可来自宿主 `useAuth().user`
 *   </PublicPkgProvider>
 *
 * 配置来源：`config.pricing`（plans / creditPacks / paymentMethods / faqKeys /
 * onSubscribe / onBuyPack / freeCtaHref / requireAuthToSubscribe / showCreditPacks /
 * contentOverrides）。默认套餐与积分包见 `../config/defaults`（也可从 './plans' 引用）。
 *
 * 登录态：本组件**不**直接 import auth-context（避免循环依赖），而是通过可选 prop
 * `user` 注入；`undefined` / `null` 一律视为未登录。宿主可传 `useAuth().user`。
 *
 * 支付：包内**不**引入任何支付 SDK 或 payment-modal。点击 CTA 时交给宿主回调
 * `onSubscribe(plan)` / `onBuyPack(pack)` 处理（宿主可自行弹窗、埋点等）。
 * 埋点在本组件内一律省略。
 */

import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, Coins, Sparkles, Zap } from 'lucide-react';

import { createTranslator } from '../lib/i18n';
import { cn } from '../lib/utils';
import { usePublicPkg } from '../config/provider';
import type { CreditPack, PlanConfig, PkgUser } from '../config/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';

export interface PricingProps {
  /** 当前登录用户；`undefined` / `null` 视为未登录。宿主可传 `useAuth().user`。 */
  user?: PkgUser | null;
  /** 额外容器类名。 */
  className?: string;
}

/** 免费档判定：价格全为 0 的套餐即免费档（避免硬编码 `plan.id === 'free'`）。 */
function isFreePlan(plan: PlanConfig): boolean {
  return plan.price.cn === 0 && plan.price.intl === 0;
}

export function Pricing({ user, className }: PricingProps) {
  const { config, locale } = usePublicPkg();
  const router = useRouter();
  const pricing = config.pricing;

  // 局部翻译器：合并「全局 i18n 词典」+「pricing.contentOverrides」。
  // 只作用于本组件，不污染全局词典。
  const t = useMemo(
    () =>
      createTranslator(locale, {
        ...config.i18n.dictionary,
        ...pricing.contentOverrides,
      }),
    [locale, config.i18n.dictionary, pricing.contentOverrides],
  );

  const isAuthed = user != null;
  const requireAuth = pricing.requireAuthToSubscribe !== false;
  const showCreditPacks = pricing.showCreditPacks !== false;

  const plans = pricing.plans ?? [];
  const creditPacks = pricing.creditPacks ?? [];
  const faqKeys = pricing.faqKeys ?? [];
  const paymentMethods = pricing.paymentMethods ?? [];

  // 免费档 CTA 目标：已登录 → freeCtaHref || dashboardHref；未登录 → registerHref。
  const freeHref = isAuthed
    ? pricing.freeCtaHref || config.brand.dashboardHref
    : config.brand.registerHref;

  const handleSubscribe = (plan: PlanConfig) => {
    if (requireAuth && !isAuthed) {
      router.push(config.brand.registerHref);
      return;
    }
    void pricing.onSubscribe?.(plan);
  };

  const handleBuyPack = (pack: CreditPack) => {
    if (requireAuth && !isAuthed) {
      router.push(config.brand.registerHref);
      return;
    }
    void pricing.onBuyPack?.(pack);
  };

  return (
    <div className={cn('min-h-screen bg-muted/30', className)}>
      <div className="container mx-auto px-4 py-16">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h1 className="text-4xl font-bold mb-4">{t('pricing.title')}</h1>
          <p className="text-xl text-muted-foreground">{t('pricing.subtitle')}</p>
          <p className="text-sm text-muted-foreground mt-2">{t('pricing.paymentNote')}</p>
        </div>

        {/* 套餐区 */}
        <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {plans.map((plan) => {
            const free = isFreePlan(plan);
            return (
              <Card
                key={plan.id}
                className={cn(
                  'relative overflow-hidden',
                  plan.popular && 'border-primary shadow-xl scale-105',
                )}
              >
                {plan.popular && (
                  <Badge className="absolute top-4 right-4">{t('pricing.mostPopular')}</Badge>
                )}
                <CardHeader className="text-center pb-8">
                  <CardTitle className="text-2xl">{t(plan.titleKey)}</CardTitle>
                  <div className="mt-4">
                    <span className="text-5xl font-bold">{t(plan.priceKey)}</span>
                    <span className="text-muted-foreground">{t(plan.periodKey)}</span>
                  </div>
                  {!free && plan.price.cn > 0 && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {`¥${plan.price.cn} · $${plan.price.intl}`}
                    </p>
                  )}
                  <CardDescription className="mt-2">{t(plan.descKey)}</CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-3 mb-8">
                    {plan.features.map((feature, index) => (
                      <li key={index} className="flex items-center gap-3">
                        <div className="h-5 w-5 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                          <Check className="h-3 w-3 text-primary" />
                        </div>
                        <span className="text-sm">{t(feature)}</span>
                      </li>
                    ))}
                  </ul>
                  {free ? (
                    <Button className="w-full" variant="outline" asChild>
                      <Link href={freeHref}>{t(plan.ctaKey)}</Link>
                    </Button>
                  ) : (
                    <Button
                      className="w-full"
                      variant={plan.popular ? 'default' : 'outline'}
                      onClick={() => handleSubscribe(plan)}
                    >
                      {t(plan.ctaKey)}
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* 一次性积分包 */}
        {showCreditPacks && creditPacks.length > 0 && (
          <div className="max-w-4xl mx-auto mt-20">
            <div className="text-center mb-8">
              <div className="flex items-center justify-center gap-2 text-2xl font-bold">
                <Coins className="h-7 w-7 text-amber-500" />
                <h2>{t('pricing.buyCredits')}</h2>
              </div>
              <p className="text-muted-foreground mt-2">{t('pricing.buyCreditsDesc')}</p>
            </div>
            <div className="grid md:grid-cols-3 gap-6">
              {creditPacks.map((pack) => (
                <Card
                  key={pack.id}
                  className={cn(
                    'relative overflow-hidden hover:border-primary/50 transition-colors',
                    pack.badge && 'border-primary shadow-xl scale-105',
                  )}
                >
                  {pack.badge && (
                    <Badge className="absolute top-4 right-4 bg-amber-500 hover:bg-amber-600 text-white">
                      <Zap className="h-3 w-3 mr-1" />
                      {pack.badge}
                    </Badge>
                  )}
                  <CardHeader className="text-center pb-4">
                    <CardTitle className="text-2xl flex items-center justify-center gap-2">
                      <Coins className="h-6 w-6 text-amber-500" />
                      {t('pricing.creditsLabel', { count: pack.credits })}
                    </CardTitle>
                    <CardDescription className="mt-1">{pack.name}</CardDescription>
                    <div className="mt-3">
                      <span className="text-4xl font-bold">${pack.price.intl}</span>
                      {pack.price.cn > 0 && (
                        <span className="text-muted-foreground text-sm"> / ¥{pack.price.cn}</span>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">
                        {t('pricing.approxPerCredit', {
                          price: `$${(pack.price.intl / pack.credits).toFixed(2)}`,
                        })}
                      </p>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <Button
                      className="w-full"
                      variant={pack.badge ? 'default' : 'outline'}
                      onClick={() => handleBuyPack(pack)}
                    >
                      <Sparkles className="h-4 w-4 mr-2" />
                      {t('pricing.buyNow')}
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* 支付方式标识 */}
        {(paymentMethods.length > 0) && (
          <div className="flex flex-wrap items-center justify-center gap-6 mt-12 text-sm text-muted-foreground">
            {paymentMethods.map((method) => (
              <div key={method.id} className="flex items-center gap-2">
                <div
                  className={cn(
                    'w-8 h-5 rounded flex items-center justify-center',
                    method.className,
                  )}
                >
                  <span className="text-white text-[8px] font-bold">{method.mark}</span>
                </div>
                <span>{method.label}</span>
              </div>
            ))}
            <div className="flex items-center gap-2 text-xs">
              <span>🔒 {t('pricing.secureNote')}</span>
            </div>
          </div>
        )}

        {/* FAQ */}
        {faqKeys.length > 0 && (
          <div className="max-w-3xl mx-auto mt-20">
            <h2 className="text-2xl font-bold text-center mb-8">{t('pricing.faqTitle')}</h2>
            <div className="grid gap-6">
              {faqKeys.map((key) => (
                <Card key={key}>
                  <CardHeader>
                    <CardTitle className="text-lg">{t(`pricing.faq.${key}`)}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground">
                      {t(`pricing.faq.a${key.slice(1)}`)}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 语义化别名，宿主可按需使用 `<PricingPage />`。 */
export const PricingPage = Pricing;