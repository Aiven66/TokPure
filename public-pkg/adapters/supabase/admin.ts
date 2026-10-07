/**
 * 默认 Admin 适配器 —— 通过服务端端点校验管理员身份。
 *
 * 用法：
 *   const config = createDefaultConfig({ brand: { name: 'Acme' } });
 *   const admin = createSupabaseAdminAdapter(config);
 *   const ok = await admin.verifyAdmin(token); // POST config.admin.verifyEndpoint
 *
 * 说明：不直接依赖 Supabase 客户端，校验委托给宿主后端的
 * `config.admin.verifyEndpoint`（返回 `{ isAdmin: boolean }`）。任何异常/非 2xx 均返回 false。
 */

import type { AdminAdapter, ResolvedConfig } from '../../config/types';

export function createSupabaseAdminAdapter(config: ResolvedConfig): AdminAdapter {
  return {
    async verifyAdmin(token: string): Promise<boolean> {
      if (!token) return false;
      try {
        const res = await fetch(config.admin.verifyEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          cache: 'no-store',
        });
        if (!res.ok) return false;
        const data = await res.json();
        return !!data?.isAdmin;
      } catch {
        return false;
      }
    },
  };
}