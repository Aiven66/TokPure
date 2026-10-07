/**
 * public-pkg —— 可复用前端组件包
 * ============================================================
 * 从 VidShoter AI 平台抽离的 4 个模块，供其他平台直接复用：
 *   1. auth    —— 注册/登录（邮件注册登录、Google 一键登录，全部可配置化）
 *   2. admin   —— 管理后台（AdminGate 强制服务端校验管理员身份后才显示）
 *   3. blog    —— 博客（前台展示 + 后台发布）
 *   4. pricing —— 定价页（套餐/积分包/支付动作全部可注入）
 *
 * 设计约定
 * ------------------------------------------------------------
 * - **自包含源码目录**：包内全部为 .tsx/.ts 源码，一律使用**相对导入**，
 *   不依赖宿主的 `@/` 路径别名，可直接复制或作为子目录引用，无需构建发布。
 * - **配置驱动**：所有可变项（品牌、路由、接口端点、存储键、文案、套餐）都通过
 *   `PublicPkgConfig` 注入，不硬编码任何平台专有信息。
 * - **数据层适配器化**：数据读写通过 `adapters` 注入；内置 Supabase 默认实现，
 *   其它后端只需实现 `AuthAdapter` / `AdminAdapter` / `BlogAdapter` 接口即可替换。
 * - **语言**：内置 en / zh / zh-Hant 词典，缺失键自动回落英文；可通过
 *   `i18n.dictionary` 覆盖或新增语言。
 *
 * 宿主依赖（需自行安装）
 * ------------------------------------------------------------
 *   react, react-dom, next, lucide-react, @supabase/supabase-js,
 *   clsx, tailwind-merge, @radix-ui/*（随包内 ui 基元按需）
 *
 * 最小用法
 * ------------------------------------------------------------
 * ```tsx
 * // 1) 定义配置
 * import { PublicPkgProvider, AuthProvider, createDefaultConfig } from 'public-pkg';
 *
 * const config = createDefaultConfig({
 *   brand: { name: 'My App' },
 *   auth: { googleEnabled: true, requireVerification: true },
 *   admin: { adminEmails: ['admin@my.app'] },
 * });
 *
 * // 2) 在根布局包裹（顺序：PublicPkgProvider 必须在 AuthProvider 外层）
 * <PublicPkgProvider config={config}>
 *   <AuthProvider>{children}</AuthProvider>
 * </PublicPkgProvider>
 * ```
 * ```tsx
 * // 3) 页面里直接使用
 * import { LoginForm, RegisterForm, Pricing, AdminGate, AdminShell, BlogList } from 'public-pkg';
 *
 * export default function LoginPage() {
 *   // useSearchParams 需要 Suspense
 *   return <Suspense><LoginForm /></Suspense>;
 * }
 *
 * // 管理后台（未通过服务端管理员校验不会渲染 children）
 * <AdminGate>
 *   <AdminShell currentPage="stats" onPageChange={setPage}>{page}</AdminShell>
 * </AdminGate>
 * ```
 * ```tsx
 * // 4) 自定义数据层（可选）：不注入则使用内置 Supabase 实现
 * import { createSupabaseAuthAdapter, createSupabaseBlogAdapter } from 'public-pkg';
 * adapters: { auth: myAuthAdapter, blog: myBlogAdapter }
 * ```
 *
 * 说明：包内不含 README，用法以本文件与各模块文件顶部的 JSDoc 为准。
 */

// ────────────────────────────────────────────────────────────
// 基础能力
// ────────────────────────────────────────────────────────────
export { cn } from './lib/utils';
export {
  LOCALES,
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  DICTIONARIES,
  interpolate,
  createTranslator,
  isLocale,
} from './lib/i18n';
export type { Locale, Dictionary, Translator } from './lib/i18n';

// ────────────────────────────────────────────────────────────
// 配置
// ────────────────────────────────────────────────────────────
export { PublicPkgProvider, usePublicPkg, useT, usePkgConfig } from './config/provider';
export type { PublicPkgContextValue, PublicPkgProviderProps } from './config/provider';
export {
  createDefaultConfig,
  resolveSupabaseCredentials,
  DEFAULT_ADMIN_NAV,
  DEFAULT_PLANS,
  DEFAULT_CREDIT_PACKS,
} from './config/defaults';
export type * from './config/types';

// ────────────────────────────────────────────────────────────
// Auth（注册 / 登录 / Google / 回调）
// ────────────────────────────────────────────────────────────
export { AuthProvider, useAuth, normalizeAuthInput } from './auth/auth-context';
export type { AuthContextType } from './auth/auth-context';
export { LoginForm } from './auth/login-form';
export type { LoginFormProps } from './auth/login-form';
export { RegisterForm } from './auth/register-form';
export type { RegisterFormProps } from './auth/register-form';
export { GoogleButton } from './auth/google-button';
export type { GoogleButtonProps } from './auth/google-button';
export { AuthCallback } from './auth/auth-callback';
export {
  decodeJwtPayload,
  isDemoToken,
  createUserFromJwt,
  generateDemoToken,
  readStoredTokens,
  setAuthCookies,
  clearAuthCookies,
  persistSession,
  clearAuthStorage,
  getRegisteredUsers,
  saveRegisteredUser,
  findRegisteredUser,
  getDemoUser,
  saveDemoUser,
  clearDemoUser,
  isDesktopAuthRequest,
  normalizeDesktopCallbackUrl,
  rememberDesktopCallback,
  getDesktopCallback,
  buildDesktopReturnUrl,
} from './auth/session-storage';
export type { StoredTokens, DemoRegisteredUser, DesktopAuthPayload } from './auth/session-storage';

// ────────────────────────────────────────────────────────────
// Admin（后台门控 + 布局外壳）
// ────────────────────────────────────────────────────────────
export { AdminGate, isAdminUser } from './admin/admin-gate';
export type { AdminGateProps } from './admin/admin-gate';
export { AdminShell } from './admin/admin-shell';
export type { AdminShellProps } from './admin/admin-shell';

// ────────────────────────────────────────────────────────────
// Blog（前台展示 + 后台发布）
// ────────────────────────────────────────────────────────────
export { BlogList } from './blog/blog-list';
export { BlogDetail } from './blog/blog-detail';
export type { BlogDetailProps } from './blog/blog-detail';
export { BlogEditor } from './blog/blog-editor';
export {
  normalizeLocale,
  stripHtml,
  slugifyTitle,
  isUuid,
  extractShortIdFromSlug,
  buildBlogUrl,
  formatBlogDate,
  normalizeBlogRow,
  groupRowsByLocale,
  groupPostsByLocale,
  resolveBlogCover,
} from './blog/blog-model';
export { buildBlogMetadata, buildBlogPostingJsonLd, buildBreadcrumbJsonLd } from './blog/blog-seo';
export type { BlogSeoCtx, BlogMetadata } from './blog/blog-seo';

// ────────────────────────────────────────────────────────────
// Pricing（套餐 / 积分包 / FAQ）
// ────────────────────────────────────────────────────────────
export { Pricing, PricingPage } from './pricing/pricing';
export type { PricingProps } from './pricing/pricing';

// ────────────────────────────────────────────────────────────
// Supabase 默认适配器
// ────────────────────────────────────────────────────────────
export { createSupabaseAuthAdapter } from './adapters/supabase/auth';
export { createSupabaseAdminAdapter } from './adapters/supabase/admin';
export { createSupabaseBlogAdapter } from './adapters/supabase/blog';
export { getSupabaseClient, isSupabaseConfigured } from './adapters/supabase/client';
export type { SupabaseCredentials } from './adapters/supabase/client';

// ────────────────────────────────────────────────────────────
// UI 基元（shadcn/ui，已改为相对导入，可直接复用）
// ────────────────────────────────────────────────────────────
export * from './ui/alert';
export * from './ui/avatar';
export * from './ui/badge';
export * from './ui/button';
export * from './ui/card';
export * from './ui/checkbox';
export * from './ui/dialog';
export * from './ui/dropdown-menu';
export * from './ui/input';
export * from './ui/label';
export * from './ui/pagination';
export * from './ui/progress';
export * from './ui/radio-group';
export * from './ui/select';
export * from './ui/separator';
export * from './ui/skeleton';
export * from './ui/switch';
export * from './ui/table';
export * from './ui/tabs';
export * from './ui/textarea';