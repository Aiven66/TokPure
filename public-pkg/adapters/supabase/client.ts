/**
 * Supabase 客户端工厂（适配器共用）。
 *
 * 与宿主项目 `src/storage/database/supabase-client.ts` 行为一致，区别是
 * **连接信息由参数注入**（来自 `PublicPkgConfig.supabase`），不直接读 env，
 * 便于同一份代码服务多个平台。未配置时返回占位客户端，调用方无需判空。
 *
 * 宿主需自行安装 `@supabase/supabase-js`。
 */

import { createClient } from '@supabase/supabase-js';

export interface SupabaseCredentials {
  url: string;
  anonKey: string;
}

let cachedClient: any = null;

export function isSupabaseConfigured(creds: SupabaseCredentials): boolean {
  const { url, anonKey } = creds;
  if (!url || !anonKey) return false;
  // 浏览器端只要非空即可；Node 端做一次 hostname 白名单校验，避免误配。
  if (typeof window !== 'undefined') return true;
  try {
    const parsed = new URL(url);
    const ok =
      parsed.hostname.includes('supabase.co') ||
      parsed.hostname.includes('supabase.net') ||
      parsed.hostname.includes('supabase.in');
    if (!ok) return false;
  } catch {
    return false;
  }
  return anonKey.split('.').length === 3;
}

function createPlaceholderClient(): any {
  return {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      getUser: async () => ({ data: { user: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signInWithPassword: async () => ({ data: { session: null }, error: new Error('Supabase not configured') }),
      signUp: async () => ({ data: { session: null }, error: new Error('Supabase not configured') }),
      signInWithOAuth: async () => ({ data: { url: null }, error: new Error('Supabase not configured') }),
      refreshSession: async () => ({ data: { session: null }, error: new Error('Supabase not configured') }),
      signOut: async () => ({}),
      setSession: async () => ({ data: { session: null }, error: null }),
    },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }), order: () => ({ limit: async () => ({ data: [] }) }) }) }),
      insert: async () => ({ error: null }),
    }),
  };
}

export function getSupabaseClient(creds: SupabaseCredentials, token?: string): any {
  const { url, anonKey } = creds;
  if (!url || !anonKey) return createPlaceholderClient();

  if (token) {
    // 带用户 token 的一次性客户端：不持久化会话，仅用于按 RLS 读取/写入。
    return createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      db: { timeout: 60000 },
      auth: {
        autoRefreshToken: true,
        persistSession: false,
        detectSessionInUrl: false,
        flowType: 'implicit',
      },
    });
  }

  if (!cachedClient) {
    cachedClient = createClient(url, anonKey, {
      db: { timeout: 60000 },
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
        flowType: 'implicit',
      },
    });
  }
  return cachedClient;
}