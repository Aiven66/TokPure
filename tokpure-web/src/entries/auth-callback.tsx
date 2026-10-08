'use client';

/**
 * OAuth 回调页岛屿（auth-callback.html）。
 *
 * - 处理 Supabase 的 `?code`（PKCE）与 URL hash 中的 `access_token`；
 * - 桌面端 deep-link 流程命中时，自动回跳 `?callback=` 指定地址并附带 token；
 * - 对应 public-pkg 配置 `brand.callbackPath = '/auth-callback.html'`。
 */

import { Suspense } from 'react';
import { AuthCallback } from '@pkg';
import { PkgRoot } from '@/components/PkgRoot';
import { mount, readSiteLocale } from '@/lib/mount';

function CallbackRoot() {
  return (
    <PkgRoot initialLocale={readSiteLocale()}>
      <Suspense fallback={null}>
        <AuthCallback />
      </Suspense>
    </PkgRoot>
  );
}

mount('auth-callback-root', <CallbackRoot />);