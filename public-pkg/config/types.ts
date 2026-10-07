/**
 * public-pkg 配置契约（唯一真源）。
 *
 * 四个可复用模块（auth / admin / blog / pricing）都通过 `PublicPkgConfig` 注入配置，
 * 数据层通过 `adapters` 注入（默认提供 Supabase 实现，见 `../adapters/supabase/*`）。
 *
 * 用法概览见 `../index.ts` 顶部注释。
 */

import type { Locale, Dictionary } from '../lib/i18n';

// ────────────────────────────────────────────────────────────
// 用户
// ────────────────────────────────────────────────────────────

export interface PkgUser {
  id: string;
  email: string;
  name: string | null;
  /** 'admin' 表示管理员；其它值（含 'user'）为普通用户。 */
  role: string;
  avatarUrl: string | null;
}

// ────────────────────────────────────────────────────────────
// 品牌 / 路由
// ────────────────────────────────────────────────────────────

export interface BrandConfig {
  /** 品牌名，展示在登录/注册卡片与后台侧栏。 */
  name: string;
  /** 可选品牌短标签（如 'AI'），仅用于视觉点缀。 */
  tagline?: string;
  homeHref?: string;
  loginHref?: string;
  registerHref?: string;
  dashboardHref?: string;
  /** OAuth 回调路径，需与后端 OAuth redirect 配置一致。 */
  callbackPath?: string;
  forgotPasswordHref?: string;
  termsHref?: string;
  privacyHref?: string;
  adminPath?: string;
  adminLoginPath?: string;
}

// ────────────────────────────────────────────────────────────
// Auth
// ────────────────────────────────────────────────────────────

export interface AuthEndpoints {
  /** 服务端幂等补建用户档案（users/credits/subscriptions）。 */
  ensureProfile?: string;
  /** 注册前校验邮箱是否已存在。 */
  checkEmail?: string;
  /** 发送邮箱验证码。 */
  sendVerificationCode?: string;
  /** 邀请奖励。 */
  referralReward?: string;
}

export interface AuthStorageKeys {
  accessToken?: string;
  refreshToken?: string;
  /** 写入 cookie 的键名（Path=/; SameSite=Lax），供同源请求携带。 */
  cookieAccess?: string;
  cookieRefresh?: string;
  /** 未配置 Supabase 时的本地演示账号存储。 */
  demoUser?: string;
  registeredUsers?: string;
  /** 邀请人 id 的 localStorage 键。 */
  referral?: string;
}

export interface AuthConfig {
  /** 是否展示「Google 一键登录」。 */
  googleEnabled?: boolean;
  /** 注册是否需要邮箱验证码（三步：info → verify → done）。 */
  requireVerification?: boolean;
  /** 是否启用桌面端 deep-link 登录流程（Web 登录后跳回客户端）。 */
  desktopAuth?: boolean;
  /** 新用户初始积分（注册建档时写入 credits 表）。 */
  initialCredits?: number;
  /** 演示管理员账号（仅当未配置 Supabase 时生效）。 */
  demoAdmins?: Record<string, { password: string; name: string; email: string }>;
  endpoints?: AuthEndpoints;
  storageKeys?: AuthStorageKeys;
  /** 登录/注册成功后的默认跳转路径（非桌面流程）。 */
  afterLoginHref?: string;
  afterRegisterHref?: string;
}

// ────────────────────────────────────────────────────────────
// Admin
// ────────────────────────────────────────────────────────────

export interface AdminNavItem {
  id: string;
  label: { en: string; zh: string };
  /** lucide-react 图标名（可选，默认渲染无图标）。 */
  icon?: string;
}

export interface AdminConfig {
  /** 服务端管理员校验端点，返回 { isAdmin: boolean }。 */
  verifyEndpoint?: string;
  /**
   * 可选的「邮箱白名单」。命中白名单的账号即使 `users.role` 不是 admin 也可进入后台，
   * 但仍必须通过 `verifyEndpoint` 服务端校验（防止前端伪造）。
   */
  adminEmails?: string[];
  /** 侧栏导航项。 */
  navItems?: AdminNavItem[];
  /** 后台界面语言，默认 'zh'。 */
  locale?: 'en' | 'zh';
  /** 后台语言偏好本地存储键。 */
  localeStorageKey?: string;
  /** 未登录/非管理员时的重定向路径，默认取 brand.adminLoginPath。 */
  loginPath?: string;
}

// ────────────────────────────────────────────────────────────
// Blog
// ────────────────────────────────────────────────────────────

export type BlogLocale = Locale;

export interface BlogPost {
  id: string;
  slug?: string;
  title: string;
  content: string;
  summary?: string;
  category: string;
  coverImage: string;
  author?: string;
  publishedAt: string;
  viewCount?: number;
  isPublished?: boolean;
  locale: BlogLocale;
  parentId?: string | null;
  translationGroup?: string;
}

/** 数据库行 → 领域模型的归一化输入（字段名兼容 snake_case / camelCase）。 */
export interface BlogRow {
  id?: string | number | null;
  slug?: string | null;
  title?: string | null;
  content?: string | null;
  summary?: string | null;
  category?: string | null;
  cover_image?: string | null;
  coverImage?: string | null;
  author?: string | null;
  published_at?: string | null;
  publishedAt?: string | null;
  created_at?: string | null;
  view_count?: number | null;
  views?: number | null;
  is_published?: boolean | null;
  locale?: string | null;
  parent_id?: string | null;
  parentId?: string | null;
  translation_group?: string | null;
}

export interface BlogEndpoints {
  /** POST/PATCH 保存文章（服务端需校验管理员）。 */
  posts?: string;
  uploadCover?: string;
  autoCategorize?: string;
  translate?: string;
}

export interface BlogConfig {
  /** 前台列表/详情路由前缀，默认 '/blog'。 */
  basePath?: string;
  /** 列表每页条数，默认 10。 */
  pageSize?: number;
  /** 分类筛选下拉项；不传则从文章数据自动聚合。 */
  categories?: string[];
  defaultCategory?: string;
  defaultAuthor?: string;
  /** 分类 → 默认封面图 URL。 */
  defaultCoverFor?: (category: string) => string;
  /** 详情页是否渲染 JSON-LD（BlogPosting / BreadcrumbList）。 */
  jsonLd?: boolean;
  editor?: {
    /** 是否启用后台编辑器组件。 */
    enabled?: boolean;
    endpoints?: BlogEndpoints;
  };
}

// ────────────────────────────────────────────────────────────
// Pricing
// ────────────────────────────────────────────────────────────

export interface PlanPrice {
  cn: number;
  intl: number;
}

export interface PlanConfig {
  id: string;
  name: string;
  titleKey: string;
  priceKey: string;
  periodKey: string;
  descKey: string;
  features: string[];
  ctaKey: string;
  popular: boolean;
  price: PlanPrice;
  period: string;
}

export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  price: PlanPrice;
  badge?: string;
}

export interface PaymentMethodBadge {
  id: string;
  label: string;
  /** 展示用的短标识（如 'PP' / 'CR'）。 */
  mark: string;
  className?: string;
}

export interface PricingConfig {
  plans?: PlanConfig[];
  creditPacks?: CreditPack[];
  /** FAQ 键后缀，默认 ['q1'..'q5']。 */
  faqKeys?: string[];
  showCreditPacks?: boolean;
  paymentMethods?: PaymentMethodBadge[];
  /** 点击订阅 CTA。未登录时组件会先跳 brand.registerHref（除非 requireAuthToSubscribe=false）。 */
  onSubscribe?: (plan: PlanConfig) => void | Promise<void>;
  /** 点击积分包购买。 */
  onBuyPack?: (pack: CreditPack) => void | Promise<void>;
  requireAuthToSubscribe?: boolean;
  /** 免费档 CTA 的跳转（登录 → dashboardHref，未登录 → registerHref）。 */
  freeCtaHref?: string;
  /** 覆盖任意文案键（如 pricing.title）。 */
  contentOverrides?: Partial<Dictionary>;
}

// ────────────────────────────────────────────────────────────
// i18n
// ────────────────────────────────────────────────────────────

export interface I18nConfig {
  locale?: Locale;
  /** 合并进内置词典的覆盖项（可新增键或覆盖 en/zh/zh-Hant）。 */
  dictionary?: Partial<Dictionary>;
  /** 语言偏好本地存储键，默认 'locale'。 */
  storageKey?: string;
}

// ────────────────────────────────────────────────────────────
// 适配器（数据层注入）
// ────────────────────────────────────────────────────────────

export interface AuthSignInResult {
  error: string | null;
  token?: string | null;
  refreshToken?: string | null;
  email?: string;
  /** 注册时是否需要邮箱验证。 */
  needsVerification?: boolean;
}

/**
 * Auth 适配器：把「会话与身份来源」抽象出来，便于替换 Supabase / Firebase / 自建后端。
 * 未提供时使用内置 Supabase 实现。
 */
export interface AuthAdapter {
  /** 读取当前会话用户。 */
  getCurrentUser: () => Promise<PkgUser | null>;
  /** 订阅会话变更，返回取消订阅函数。 */
  onAuthStateChange?: (cb: (user: PkgUser | null) => void) => () => void;
  signIn: (email: string, password: string) => Promise<AuthSignInResult>;
  signUp: (email: string, password: string, name: string) => Promise<AuthSignInResult>;
  signInWithGoogle?: () => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<string | null>;
  getAccessToken: () => string | null;
}

/** Admin 适配器：服务端校验管理员身份。 */
export interface AdminAdapter {
  verifyAdmin: (token: string) => Promise<boolean>;
}

/** Blog 适配器：前台读取 + 后台 CRUD。 */
export interface BlogAdapter {
  listPublished: (opts: { limit: number; category?: string }) => Promise<BlogPost[]>;
  getById?: (id: string) => Promise<BlogPost | null>;
  /** 后台：列出全部（含草稿）。 */
  listAll?: () => Promise<BlogPost[]>;
  save?: (post: Partial<BlogPost> & { id?: string }) => Promise<{ error: string | null; post?: BlogPost }>;
  remove?: (id: string) => Promise<{ error: string | null }>;
}

/** Payment 适配器（可选）：宿主自行接入支付 SDK。 */
export interface PaymentAdapter {
  startCheckout: (opts: { planId: string; kind: 'plan' | 'pack' }) => Promise<{ error?: string }>;
}

export interface PublicPkgAdapters {
  auth?: AuthAdapter;
  admin?: AdminAdapter;
  blog?: BlogAdapter;
  payment?: PaymentAdapter;
}

// ────────────────────────────────────────────────────────────
// 根配置
// ────────────────────────────────────────────────────────────

export interface PublicPkgConfig {
  brand: BrandConfig;
  auth?: AuthConfig;
  admin?: AdminConfig;
  blog?: BlogConfig;
  pricing?: PricingConfig;
  i18n?: I18nConfig;
  adapters?: PublicPkgAdapters;
  /** Supabase 连接信息；不传则从环境变量读取（见 defaults.ts）。 */
  supabase?: { url: string; anonKey: string };
}

/** 供组件内部使用的「已填默认值」配置。 */
export interface ResolvedConfig extends PublicPkgConfig {
  brand: Required<Pick<BrandConfig, 'homeHref' | 'loginHref' | 'registerHref' | 'dashboardHref' | 'callbackPath' | 'forgotPasswordHref' | 'termsHref' | 'privacyHref' | 'adminPath' | 'adminLoginPath'>> & BrandConfig;
  auth: Required<Pick<AuthConfig, 'googleEnabled' | 'requireVerification' | 'desktopAuth' | 'initialCredits' | 'afterLoginHref' | 'afterRegisterHref'>> & AuthConfig & {
    endpoints: Required<AuthEndpoints>;
    storageKeys: Required<AuthStorageKeys>;
  };
  admin: Required<Pick<AdminConfig, 'verifyEndpoint' | 'adminEmails' | 'locale' | 'localeStorageKey' | 'loginPath'>> & AdminConfig;
  blog: Required<Pick<BlogConfig, 'basePath' | 'pageSize' | 'jsonLd'>> & BlogConfig;
  pricing: Required<Pick<PricingConfig, 'showCreditPacks' | 'requireAuthToSubscribe'>> & PricingConfig;
  i18n: Required<Pick<I18nConfig, 'locale' | 'storageKey'>> & I18nConfig;
}