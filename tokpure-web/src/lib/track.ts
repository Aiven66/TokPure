/**
 * 站点 GA4 埋点的 React 侧封装（静态脚本见 assets/js/ga4.js）。
 *
 * 页面可能在没有加载 GA 脚本时运行（广告拦截），这里全部做可选调用，
 * 任何情况下都不能影响购买流程。
 */

declare global {
  interface Window {
    tpTrack?: (name: string, params?: Record<string, unknown>) => void;
    tpGaClientId?: () => string;
  }
}

export function track(name: string, params?: Record<string, unknown>): void {
  try {
    window.tpTrack?.(name, params);
  } catch {
    /* 忽略 */
  }
}

/** _ga cookie 里的 client_id；服务端 webhook 用它把 purchase 归因回这次会话。 */
export function gaClientId(): string {
  try {
    return window.tpGaClientId?.() || '';
  } catch {
    return '';
  }
}
