'use client';

/**
 * GoogleButton —— Google 一键登录按钮。
 *
 * 用法：
 *   <GoogleButton />            // 默认尺寸
 *   <GoogleButton size="lg" className="mt-2" />
 *   <GoogleButton onClick={() => signInWithGoogle()} />  // 自定义行为（可选）
 *
 * 由 `config.auth.googleEnabled` 门控：关闭时渲染 `null`。默认调用
 * `useAuth().signInWithGoogle()`，OAuth 成功后由 Supabase 重定向到
 * `config.brand.callbackPath`。
 */

import { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import { usePkgConfig, useT } from '../config/provider';
import { useAuth } from './auth-context';

export interface GoogleButtonProps {
  className?: string;
  size?: 'default' | 'sm' | 'lg';
  /** 覆盖默认行为；返回 `{ error }`。不传则走 `useAuth().signInWithGoogle()`。 */
  onClick?: () => Promise<{ error: string | null }>;
}

function GoogleIcon() {
  return (
    <svg className="h-5 w-5 mr-2" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

export function GoogleButton({ className, size = 'default', onClick }: GoogleButtonProps) {
  const config = usePkgConfig();
  const t = useT();
  const { signInWithGoogle, error, clearError } = useAuth();
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (error) setLocalError(error);
  }, [error]);

  if (!config.auth.googleEnabled) return null;

  const handleClick = async () => {
    setLoading(true);
    setLocalError(null);
    clearError();
    try {
      const result = onClick ? await onClick() : await signInWithGoogle();
      if (result?.error) setLocalError(result.error);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size={size}
        onClick={handleClick}
        disabled={loading}
        className={className ? `w-full ${className}` : 'w-full'}
      >
        {loading ? (
          <>
            <svg
              className="animate-spin -ml-1 mr-2 h-5 w-5 text-muted-foreground"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            {t('login.googleButton')}...
          </>
        ) : (
          <>
            <GoogleIcon />
            {t('login.googleButton')}
          </>
        )}
      </Button>

      {localError && (
        <div className="text-destructive text-sm text-center p-2 bg-destructive/10 rounded border border-destructive/20">
          {localError}
          <button
            type="button"
            onClick={() => {
              setLocalError(null);
              clearError();
            }}
            className="ml-2 text-primary hover:underline"
          >
            {t('common.cancel')}
          </button>
        </div>
      )}
    </div>
  );
}