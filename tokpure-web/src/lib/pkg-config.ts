/**
 * public-pkg 宿主配置（TokPure 官网 + 桌面端共用同一套账号体系）。
 *
 * 唯一真源：品牌名、路由、管理员、博客、定价、i18n 全部在这里注入，
 * public-pkg 内部不硬编码任何 TokPure 专有信息。
 *
 * Supabase 连接信息来自构建期环境变量（Vercel / 本地 .env）：
 *   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
 * 未配置时 public-pkg 会自动回落到 `auth.demoAdmins` 本地演示账号，
 * 此时管理员 admin@126.com / admin@666666 依然可以登录后台。
 */

import {
  createDefaultConfig,
  createUserFromJwt,
  isAdminUser,
  isDemoToken,
} from '@pkg';
import type { AdminAdapter, AdminNavItem } from '@pkg';
import { showToast } from './toast';
import { openCheckout } from './checkout';

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || '';
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || '';

/** 服务端管理员校验端点（Supabase 模式）。 */
const ADMIN_VERIFY_ENDPOINT = '/api/admin/verify';

/** 是否已接入 Supabase（未接入则走本地 demo 账号）。 */
export const SUPABASE_READY = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/** 管理员邮箱白名单（仍必须通过服务端 /api/admin/verify 校验）。 */
export const ADMIN_EMAILS = ['admin@126.com'];

/**
 * 管理员校验适配器。
 *
 * - 已接入 Supabase：委托服务端 `/api/admin/verify`（防止前端伪造 token）；
 * - 未接入 Supabase（本地演示）：只接受 public-pkg 生成的 demo token，
 *   且其邮箱必须命中 {@link ADMIN_EMAILS}——不是无条件放行。
 */
const adminAdapter: AdminAdapter = {
  async verifyAdmin(token: string): Promise<boolean> {
    if (!token) return false;

    if (SUPABASE_READY) {
      try {
        const res = await fetch(ADMIN_VERIFY_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          cache: 'no-store',
        });
        if (!res.ok) return false;
        const data = await res.json().catch(() => ({}));
        return !!data?.isAdmin;
      } catch {
        return false;
      }
    }

    if (!isDemoToken(token)) return false;
    return isAdminUser(createUserFromJwt(token), ADMIN_EMAILS);
  },
};

/** 后台侧栏导航（图标名需存在于 public-pkg admin-shell 的 ICONS 映射中）。 */
const ADMIN_NAV: AdminNavItem[] = [
  { id: 'stats', label: { zh: '数据统计', en: 'Statistics' }, icon: 'BarChart3' },
  { id: 'users', label: { zh: '用户管理', en: 'Users' }, icon: 'Users' },
  { id: 'payments', label: { zh: '付费管理', en: 'Payments' }, icon: 'CreditCard' },
  { id: 'blog', label: { zh: '博客管理', en: 'Blog' }, icon: 'FileText' },
];

export const pkgConfig = createDefaultConfig({
  brand: {
    name: 'TokPure',
    tagline: 'AI',
    // 官网是多页静态站（*.html），路由需指向真实文件，避免 404
    homeHref: '/index.html',
    loginHref: '/login.html',
    registerHref: '/login.html?mode=register',
    dashboardHref: '/index.html',
    callbackPath: '/auth-callback.html',
    forgotPasswordHref: '/login.html',
    termsHref: '/about.html',
    privacyHref: '/about.html',
    adminPath: '/admin.html',
    adminLoginPath: '/login.html',
  },
  supabase: { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY },
  adapters: { admin: adminAdapter },
  auth: {
    googleEnabled: true,
    requireVerification: false,
    // 桌面端 deep-link 登录：?from=desktop&callback=http://127.0.0.1:<port>
    desktopAuth: true,
    initialCredits: 60,
    afterLoginHref: '/index.html',
    afterRegisterHref: '/index.html',
    // 未配置 Supabase 时的本地演示管理员（配置了 Supabase 则走真实账号）
    demoAdmins: {
      'admin@126.com': {
        password: 'admin@666666',
        name: 'TokPure Admin',
        email: 'admin@126.com',
      },
    },
  },
  admin: {
    adminEmails: ADMIN_EMAILS,
    verifyEndpoint: ADMIN_VERIFY_ENDPOINT,
    locale: 'zh',
    localeStorageKey: 'admin_locale',
    loginPath: '/login.html',
    navItems: ADMIN_NAV,
  },
  blog: {
    basePath: '/blog',
    pageSize: 6,
    jsonLd: true,
    defaultCategory: 'General',
    defaultAuthor: 'TokPure',
    editor: {
      enabled: true,
      endpoints: {
        posts: '/api/blog/posts',
        autoCategorize: '/api/blog/auto-categorize',
      },
    },
  },
  pricing: {
    // 点击订阅 / 购买积分 → 打开 Creem / Waffo 二选一收银台
    onSubscribe: (plan) =>
      openCheckout({
        id: plan.id,
        kind: 'plan',
        name: plan.name,
        priceUsd: plan.price?.intl || plan.price?.cn,
      }),
    onBuyPack: (pack) =>
      openCheckout({
        id: pack.id,
        kind: 'pack',
        name: pack.name,
        priceUsd: pack.price?.intl || pack.price?.cn,
      }),
    requireAuthToSubscribe: true,
    showCreditPacks: true,
    contentOverrides: {
      'pricing.title': '选择适合你的方案',
      'pricing.subtitle': '本地 AI 引擎，一次授权，长期使用',
    },
  },
  i18n: {
    locale: 'zh',
    storageKey: 'locale',
  },
});

export type { AdminNavItem };

/** 供页面自行提示用（例如后台门控失败）。 */
export function notify(message: string): void {
  showToast(message);
}