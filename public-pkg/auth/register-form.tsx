'use client';

/**
 * RegisterForm —— 注册表单。
 *
 * 用法（App Router 页面）：
 *   <Suspense>
 *     <RegisterForm onSuccess={() => router.replace('/dashboard')} />
 *   </Suspense>
 *
 * 由 `config.auth.requireVerification` 门控两种流程：
 * - true：三步「填写信息 → 邮箱验证码 → 完成」，验证码走
 *   `config.auth.endpoints.checkEmail / sendVerificationCode`。
 * - false：单步直接 `signUp`（不验证）。
 *
 * 需要 `<Suspense>` 包裹（内部使用 `useSearchParams`）。条款/隐私链接取自
 * `config.brand.termsHref / privacyHref`；跳转目标取自 `config.auth.afterRegisterHref`。
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AlertCircle, CheckCircle, KeyRound, Loader2, Lock, Mail, Monitor, User, Video } from 'lucide-react';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
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
  readStoredTokens,
  rememberDesktopCallback,
} from './session-storage';

export interface RegisterFormProps {
  className?: string;
  onSuccess?: (result: AuthSignInResult) => void;
}

type Step = 'info' | 'verify' | 'done';

export function RegisterForm({ className, onSuccess }: RegisterFormProps) {
  const config = usePkgConfig();
  const t = useT();
  const { signUp, user, accessToken } = useAuth();
  const router = useRouter();
  const sp = useSearchParams();

  const [step, setStep] = useState<Step>('info');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const isDesktopFlow = isDesktopAuthRequest(config, sp);
  const savedCallbackUrl = getDesktopCallback(config, sp);

  // 桌面流程：把 loopback 回调地址持久化到 sessionStorage。
  // buildDesktopReturnUrl 只从 sessionStorage 读取回调地址（不接受 searchParams），
  // 缺少这一步会让「自动回跳」与「返回应用」按钮都静默失效。
  useEffect(() => {
    if (isDesktopFlow) rememberDesktopCallback(config, sp.get('callback'));
  }, [isDesktopFlow, config, sp]);

  const validate = (): string | null => {
    if (!name.trim()) return t('register.errorNameRequired');
    if (!email.trim()) return t('register.errorEmailRequired');
    if (password.length < 6) return t('register.errorPasswordLength');
    if (password !== confirmPassword) return t('register.errorPasswordMismatch');
    if (!agreedToTerms) return t('register.errorAgreeTerms');
    return null;
  };

  const finish = (result: AuthSignInResult) => {
    if (isDesktopFlow) {
      setStep('done');
      return;
    }
    if (onSuccess) onSuccess(result);
    else {
      router.push(config.auth.afterRegisterHref);
      router.refresh();
    }
  };

  // 桌面流程：注册成功后自动回跳 loopback 地址，免去用户手动点击（与客户端提示一致）。
  useEffect(() => {
    if (!isDesktopFlow || step !== 'done') return;
    const url = buildDesktopReturnUrl(config, {
      token: accessToken,
      refreshToken: readStoredTokens(config).refresh,
      email: user?.email || email,
      userId: user?.id || '',
      name: user?.name || name,
    });
    if (!url) return;
    const timer = setTimeout(() => {
      window.location.href = url;
    }, 1000);
    return () => clearTimeout(timer);
  }, [isDesktopFlow, step, accessToken, config, user, email, name]);

  const startCountdown = () => {
    setCountdown(60);
    const id = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(id);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  // 需要邮箱验证：校验邮箱 → 发送验证码 → 进入验证步骤。
  const handleSendCode = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSendingCode(true);
    setError('');
    try {
      const checkRes = await fetch(config.auth.endpoints.checkEmail, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const checkData = await checkRes.json().catch(() => ({}));
      if (checkData?.exists) {
        setError(t('register.errorEmailExists'));
        return;
      }

      const res = await fetch(config.auth.endpoints.sendVerificationCode, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || t('register.errorSendCode'));
        return;
      }
      setStep('verify');
      startCountdown();
    } catch {
      setError(t('register.errorNetwork'));
    } finally {
      setSendingCode(false);
    }
  };

  const handleVerify = async () => {
    if (code.length !== 6) {
      setError(t('register.errorCodeLength'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const verifyRes = await fetch(config.auth.endpoints.sendVerificationCode, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      const verifyData = await verifyRes.json().catch(() => ({}));
      if (!verifyRes.ok) {
        setError(verifyData?.error || t('register.errorInvalidCode'));
        return;
      }
      const result = await signUp(email, password, name);
      if (result.error) {
        setError(result.error);
        return;
      }
      finish(result);
    } catch {
      setError(t('register.errorNetwork'));
    } finally {
      setLoading(false);
    }
  };

  // 不需要邮箱验证：单步直接注册。
  const handleDirectSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setLoading(true);
    setError('');
    setInfo('');
    try {
      const result = await signUp(email, password, name);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.needsVerification) {
        setInfo(t('register.confirmEmailSent'));
        return;
      }
      finish(result);
    } finally {
      setLoading(false);
    }
  };

  if (step === 'done') {
    const shownEmail = user?.email || email;
    return (
      <Card className={className ? `w-full max-w-md ${className}` : 'w-full max-w-md'}>
        <CardHeader className="text-center">
          <div className="flex items-center justify-center gap-2 font-bold text-2xl mb-4">
            <Video className="h-7 w-7 text-primary" />
            <span>{config.brand.name}</span>
          </div>
          <CardTitle className="text-xl">{t('register.successTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-col items-center gap-4">
            <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
              <CheckCircle className="h-10 w-10 text-green-500" />
            </div>
            <p className="text-center text-muted-foreground">
              {t('register.successMessage')} <strong>{shownEmail}</strong>
            </p>
          </div>
          <Button
            className="w-full h-12 text-lg"
            onClick={() => {
              const url = buildDesktopReturnUrl(config, {
                token: accessToken,
                refreshToken: readStoredTokens(config).refresh,
                email: user?.email || email,
                userId: user?.id || '',
                name: user?.name || name,
              });
              if (url) window.location.href = url;
            }}
          >
            <Monitor className="w-5 h-5 mr-2" />
            {t('register.returnToDesktop')}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            {t('register.desktopNotOpened')}
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
        <CardTitle className="text-2xl">{t('register.title')}</CardTitle>
        <CardDescription>{t('register.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && (
          <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-center gap-2 border border-destructive/20">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}
        {info && (
          <div className="p-3 rounded-lg bg-primary/10 text-primary text-sm border border-primary/20">
            {info}
          </div>
        )}

        {step === 'info' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (config.auth.requireVerification) handleSendCode();
              else handleDirectSubmit(e);
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="register-name" className="text-sm font-medium">
                {t('register.nameLabel')}
              </Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="register-name"
                  type="text"
                  placeholder={t('register.namePlaceholder')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="pl-10 h-11"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="register-email" className="text-sm font-medium">
                {t('register.emailLabel')}
              </Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="register-email"
                  type="email"
                  placeholder={t('register.emailPlaceholder')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="pl-10 h-11"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="register-password" className="text-sm font-medium">
                {t('register.passwordLabel')}
              </Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="register-password"
                  type="password"
                  placeholder={t('register.passwordPlaceholder')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="pl-10 h-11"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="register-confirm" className="text-sm font-medium">
                {t('register.confirmPasswordLabel')}
              </Label>
              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="register-confirm"
                  type="password"
                  placeholder={t('register.confirmPasswordPlaceholder')}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  className="pl-10 h-11"
                />
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border p-3 bg-muted/30">
              <Checkbox
                id="agree-terms"
                checked={agreedToTerms}
                onCheckedChange={(checked) => setAgreedToTerms(!!checked)}
                className="mt-0.5"
              />
              <label
                htmlFor="agree-terms"
                className="text-sm text-muted-foreground leading-relaxed cursor-pointer"
              >
                {t('register.agreePrefix')}{' '}
                <Link href={config.brand.termsHref} className="text-primary hover:underline font-medium">
                  {t('register.termsLink')}
                </Link>
                {t('register.agreeAnd')}
                <Link href={config.brand.privacyHref} className="text-primary hover:underline font-medium">
                  {t('register.privacyLink')}
                </Link>
              </label>
            </div>
            <Button type="submit" className="w-full h-11 text-base" disabled={sendingCode || loading}>
              {sendingCode || loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('register.sendingCode')}
                </>
              ) : config.auth.requireVerification ? (
                t('register.sendCodeButton')
              ) : (
                t('register.verifyButton')
              )}
            </Button>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleVerify();
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="register-code" className="text-sm font-medium">
                {t('register.codeLabel')}
              </Label>
              <Input
                id="register-code"
                type="text"
                placeholder={t('register.codePlaceholder')}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                maxLength={6}
                required
                className="h-11 text-center text-xl tracking-widest"
              />
            </div>
            <Button type="submit" className="w-full h-11 text-base" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('common.loading')}
                </>
              ) : (
                t('register.verifyButton')
              )}
            </Button>
            <div className="text-center text-sm text-muted-foreground">
              {t('register.codeNotReceived')}{' '}
              <button
                type="button"
                className="text-primary hover:underline font-medium"
                disabled={countdown > 0 || sendingCode}
                onClick={() => {
                  setStep('info');
                  setCountdown(0);
                }}
              >
                {countdown > 0 ? `${t('register.resendIn')} ${countdown}s` : t('register.resendButton')}
              </button>
            </div>
            <Button
              type="button"
              variant="outline"
              className="w-full h-11"
              onClick={() => setStep('info')}
              disabled={loading}
            >
              {t('register.backButton')}
            </Button>
          </form>
        )}

        {config.auth.googleEnabled && (
          <>
            <Separator />
            <GoogleButton />
          </>
        )}

        <div className="text-center text-sm pt-1">
          {t('register.alreadyHaveAccount')}{' '}
          <Link
            href={
              isDesktopFlow
                ? `${config.brand.loginHref}?from=desktop${
                    savedCallbackUrl ? `&callback=${encodeURIComponent(savedCallbackUrl)}` : ''
                  }`
                : config.brand.loginHref
            }
            className="text-primary font-medium hover:underline"
          >
            {t('register.signIn')}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}