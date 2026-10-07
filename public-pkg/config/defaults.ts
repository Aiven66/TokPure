/**
 * 默认配置 —— 所有可选字段的兜底值，保证「只传 brand 即可跑起来」。
 *
 * Supabase 连接默认从环境变量读取：
 *   NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY
 * 或 COZE_SUPABASE_URL / COZE_SUPABASE_ANON_KEY
 */

import type {
  AdminNavItem,
  CreditPack,
  PlanConfig,
  PublicPkgConfig,
  ResolvedConfig,
} from './types';

export const DEFAULT_ADMIN_NAV: AdminNavItem[] = [
  { id: 'stats', label: { zh: '数据统计', en: 'Statistics' }, icon: 'BarChart3' },
  { id: 'users', label: { zh: '用户管理', en: 'Users' }, icon: 'Users' },
  { id: 'payments', label: { zh: '付费管理', en: 'Payments' }, icon: 'CreditCard' },
  { id: 'blog', label: { zh: '博客管理', en: 'Blog' }, icon: 'FileText' },
  { id: 'events', label: { zh: '行为数据', en: 'Events' }, icon: 'Activity' },
  { id: 'models', label: { zh: '模型配置', en: 'Models' }, icon: 'KeyRound' },
  { id: 'nav', label: { zh: '导航配置', en: 'Navigation' }, icon: 'PanelLeft' },
];

export const DEFAULT_PLANS: PlanConfig[] = [
  {
    id: 'free',
    name: 'Free',
    titleKey: 'pricing.free.title',
    priceKey: 'pricing.free.price',
    periodKey: 'pricing.free.period',
    descKey: 'pricing.free.desc',
    features: [
      'pricing.free.feature1',
      'pricing.free.feature2',
      'pricing.free.feature3',
      'pricing.free.feature4',
    ],
    ctaKey: 'pricing.free.cta',
    popular: false,
    price: { cn: 0, intl: 0 },
    period: 'month',
  },
  {
    id: 'starter',
    name: 'Starter',
    titleKey: 'pricing.starter.title',
    priceKey: 'pricing.starter.price',
    periodKey: 'pricing.starter.period',
    descKey: 'pricing.starter.desc',
    features: [
      'pricing.starter.feature1',
      'pricing.starter.feature2',
      'pricing.starter.feature3',
      'pricing.starter.feature4',
      'pricing.starter.feature5',
      'pricing.starter.feature6',
    ],
    ctaKey: 'pricing.starter.cta',
    popular: true,
    price: { cn: 49, intl: 9.9 },
    period: 'month',
  },
  {
    id: 'pro',
    name: 'Pro',
    titleKey: 'pricing.pro.title',
    priceKey: 'pricing.pro.price',
    periodKey: 'pricing.pro.period',
    descKey: 'pricing.pro.desc',
    features: [
      'pricing.pro.feature1',
      'pricing.pro.feature2',
      'pricing.pro.feature3',
      'pricing.pro.feature4',
      'pricing.pro.feature5',
      'pricing.pro.feature6',
      'pricing.pro.feature7',
    ],
    ctaKey: 'pricing.pro.cta',
    popular: false,
    price: { cn: 99, intl: 19.9 },
    period: 'month',
  },
];

export const DEFAULT_CREDIT_PACKS: CreditPack[] = [
  { id: 'credits_120', name: 'Starter Pack', credits: 120, price: { cn: 19, intl: 2.99 } },
  { id: 'credits_300', name: 'Boost Pack', credits: 300, price: { cn: 49, intl: 6.99 }, badge: 'BEST VALUE' },
  { id: 'credits_900', name: 'Creator Pack', credits: 900, price: { cn: 119, intl: 16.99 } },
];

/** 从环境变量解析 Supabase 连接（服务端/客户端均可）。 */
export function resolveSupabaseCredentials(): { url: string; anonKey: string } {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.COZE_SUPABASE_URL ||
    '';
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.COZE_SUPABASE_ANON_KEY ||
    '';
  return { url, anonKey };
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * 生成完整配置。只需传入 `brand`，其余全部有默认值。
 *
 * 注意：`auth.endpoints` / `auth.storageKeys` 为**整体替换**（不做深合并），
 * 因为它们的键彼此强相关；其余对象做浅合并。
 */
export function createDefaultConfig(overrides: PublicPkgConfig): ResolvedConfig {
  const brand = overrides.brand;
  const auth = overrides.auth ?? {};
  const admin = overrides.admin ?? {};
  const blog = overrides.blog ?? {};
  const pricing = overrides.pricing ?? {};
  const i18n = overrides.i18n ?? {};

  const creds = overrides.supabase ?? resolveSupabaseCredentials();

  return {
    ...overrides,
    supabase: creds,
    brand: {
      homeHref: '/',
      loginHref: '/login',
      registerHref: '/register',
      dashboardHref: '/dashboard',
      callbackPath: '/auth/callback',
      forgotPasswordHref: '/forgot-password',
      termsHref: '/terms',
      privacyHref: '/privacy',
      adminPath: '/ax',
      adminLoginPath: '/ax/login',
      ...brand,
    },
    auth: {
      googleEnabled: true,
      requireVerification: false,
      desktopAuth: false,
      initialCredits: 60,
      afterLoginHref: brand.homeHref ?? '/',
      afterRegisterHref: brand.homeHref ?? '/',
      ...auth,
      endpoints: {
        ensureProfile: '/api/auth/ensure-profile',
        checkEmail: '/api/check-email',
        sendVerificationCode: '/api/send-verification-code',
        referralReward: '/api/referral/reward',
        ...(auth.endpoints ?? {}),
      },
      storageKeys: {
        accessToken: 'pkg_access_token',
        refreshToken: 'pkg_refresh_token',
        cookieAccess: 'pkg_access_token',
        cookieRefresh: 'pkg_refresh_token',
        demoUser: 'pkg_demo_user',
        registeredUsers: 'pkg_registered_users',
        referral: 'pkg_referral_referrer_id',
        ...(auth.storageKeys ?? {}),
      },
    },
    admin: {
      verifyEndpoint: '/api/admin/verify',
      adminEmails: [],
      locale: 'zh',
      localeStorageKey: 'admin_locale',
      loginPath: brand.adminLoginPath ?? '/ax/login',
      navItems: DEFAULT_ADMIN_NAV,
      ...admin,
    },
    blog: {
      basePath: '/blog',
      pageSize: 10,
      jsonLd: true,
      defaultCategory: 'General',
      defaultAuthor: 'Team',
      ...blog,
    },
    pricing: {
      plans: DEFAULT_PLANS,
      creditPacks: DEFAULT_CREDIT_PACKS,
      faqKeys: ['q1', 'q2', 'q3', 'q4', 'q5'],
      showCreditPacks: true,
      requireAuthToSubscribe: true,
      paymentMethods: [
        { id: 'paypal', label: 'PayPal', mark: 'PP', className: 'bg-[#003087]' },
        { id: 'creem', label: 'Creem', mark: 'CR', className: 'bg-gradient-to-r from-violet-600 to-indigo-600' },
      ],
      ...pricing,
    },
    i18n: {
      locale: 'en',
      storageKey: 'locale',
      ...i18n,
    },
  };
}

export type { DeepPartial };