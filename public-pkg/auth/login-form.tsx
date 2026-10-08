'use client';

/**
 * LoginForm —— 邮箱/密码 + Google 登录表单。
 *
 * 用法（App Router 页面）：
 *   <Suspense>
 *     <LoginForm onSuccess={() => router.replace('/dashboard')} />
 *   </Suspense>
 *
 * 说明：内部使用 `next/navigation` 的 `useSearchParams`（读取 `?error=` 与桌面
 * `?from=desktop`），因此宿主页面需用 `<Suspense>` 包裹。Google 按钮由
 * `config.auth.googleEnabled` 及 `showGoogle` 共同门控；跳转目标取自
 * `config.brand` / `config.auth.afterLoginHref`。桌面成功页由
 * `config.auth.desktopAuth` 门控。
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle, Lock, Mail, Monitor, Video } from 'lucide-react';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Separator } from '../ui/separator';
import { usePkgConfig, useT } from '../config/provider';
import type { AuthSignInResult } from '../config/types';
import { useAuth } from './auth-context';
import { GoogleButton } from './google-button';
import {
  buildDesktopReturnUrl,
  getDesktopCallback,
  isDesktopAuthRequest,
  normalizeAuthInput,
  readStoredTokens,
  rememberDesktopCallback,
} from './session-storage';

export interface LoginFormProps {
  className?: string;
  onSuccess?: (result: AuthSignInResult) => void;
  /** 是否展示 Google 登录（默认 true；仍受 `config.auth.googleEnabled` 门控）。 */
  showGoogle?: boolean;
}

export function LoginForm({ className, onSuccess, showGoogle = true }: LoginFormProps) {
  const config = usePkgConfig();
  const t = useT();
  const { signIn, user, loading: authLoading, accessToken } = useAuth();
  const router = useRouter();
  const sp = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [desktopResult, setDesktopResult] = useState<{ token: string; email: string } | null>(null);

  const isDesktopFlow = isDesktopAuthRequest(config, sp);
  const savedCallbackUrl = getDesktopCallback(config, sp);

  useEffect(() => {
    const urlError = sp.get('error');
    if (urlError) setError(decodeURIComponent(urlError));
  }, [sp]);

  useEffect(() => {
    if (isDesktopFlow) rememberDesktopCallback(config, sp.get('callback'));
  }, [isDesktopFlow, config, sp]);

  // 桌面流程：若 Provider 已恢复出会话，直接进入成功页。
  useEffect(() => {
    if (isDesktopFlow && !desktopResult && !authLoading && user && accessToken) {
      setDesktopResult({ token: accessToken, email: user.email });
    }
  }, [isDesktopFlow, desktopResult, authLoading, user, accessToken]);

  // 桌面流程：成功后自动回跳 loopback 地址，免去用户手动点击（与客户端提示一致）。
  useEffect(() => {
    if (!desktopResult) return;
    const url = buildDesktopReturnUrl(config, {
      token: desktopResult.token,
      refreshToken: readStoredTokens(config).refresh,
      email: desktopResult.email,
      userId: user?.id || '',
      name: user?.name || '',
    });
    if (!url) return;
    const timer = setTimeout(() => {
      window.location.href = url;
    }, 1000);
    return () => clearTimeout(timer);
  }, [desktopResult, config, user]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const result = await signIn(email, password);
    if (result.error) {
      setError(result.error);
      setLoading(false);
      return;
    }
    if (isDesktopFlow) {
      setDesktopResult({ token: result.token || accessToken || '', email: result.email || email });
      setLoading(false);
      return;
    }
    if (onSuccess) onSuccess(result);
    else {
      router.push(config.auth.afterLoginHref);
      router.refresh();
    }
  };

  const googleEnabled = config.auth.googleEnabled && showGoogle;

  if (desktopResult) {
    return (
      <Card className={className ? `w-full max-w-md ${className}` : 'w-full max-w-md'}>
        <CardHeader className="text-center">
          <div className="flex items-center justify-center gap-2 font-bold text-2xl mb-4">
            <Video className="h-7 w-7 text-primary" />
            <span>{config.brand.name}</span>
          </div>
          <CardTitle className="text-xl">{t('login.successTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-col items-center gap-4">
            <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
              <CheckCircle className="h-10 w-10 text-green-500" />
            </div>
            <p className="text-center text-muted-foreground">
              {t('login.successMessage')} <strong>{desktopResult.email}</strong>
            </p>
          </div>
          <Button
            className="w-full h-12 text-lg"
            onClick={() => {
              const url = buildDesktopReturnUrl(config, {
                token: desktopResult.token,
                refreshToken: readStoredTokens(config).refresh,
                email: desktopResult.email,
                userId: user?.id || '',
                name: user?.name || '',
              });
              if (url) window.location.href = url;
            }}
          >
            <Monitor className="w-5 h-5 mr-2" />
            {t('login.returnToDesktop')}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            {t('login.desktopNotOpened')}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={className ? `w-full max-w-md ${className}` : 'w-full max-w-md'}>
      <CardHeader className="text-center space-y-1">
        <div className="flex items-center justify-center gap-2 font-bold text-2xl mb-2">
          <Video className="h-7 w-7 text-primary" />
          <span>{config.brand.name}</span>
        </div>
        <CardTitle className="text-2xl">{t('login.title')}</CardTitle>
        <CardDescription>{t('login.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && (
          <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm border border-destructive/20">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="login-email" className="text-sm font-medium">
              {t('login.emailLabel')}
            </Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="login-email"
                type="email"
                placeholder={t('login.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(normalizeAuthInput(e.target.value))}
                autoComplete="email"
                required
                className="pl-10 h-11"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="login-password" className="text-sm font-medium">
              {t('login.passwordLabel')}
            </Label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="login-password"
                type="password"
                placeholder={t('login.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                className="pl-10 h-11"
              />
            </div>
          </div>
          <div className="text-right">
            <Link
              href={config.brand.forgotPasswordHref}
              className="text-sm text-primary font-medium hover:underline"
            >
              {t('login.forgotPassword')}
            </Link>
          </div>
          <Button type="submit" className="w-full h-11 text-base" disabled={loading}>
            {loading ? t('common.loading') : t('login.submitButton')}
          </Button>
        </form>

        {googleEnabled && (
          <>
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <Separator className="w-full" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-background px-3 text-muted-foreground">
                  {t('login.orContinueWith')}
                </span>
              </div>
            </div>
            <GoogleButton />
          </>
        )}

        <div className="text-center text-sm pt-1">
          {t('login.dontHaveAccount')}{' '}
          <Link
            href={
              isDesktopFlow
                ? `${config.brand.registerHref}${
                    config.brand.registerHref.includes('?') ? '&' : '?'
                  }from=desktop${
                    savedCallbackUrl ? `&callback=${encodeURIComponent(savedCallbackUrl)}` : ''
                  }`
                : config.brand.registerHref
            }
            className="text-primary font-medium hover:underline"
          >
            {t('login.signUp')}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}