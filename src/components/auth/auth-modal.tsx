'use client'

import { useState, useEffect } from 'react'
import { Loader2, X, KeyRound, Mail, CheckCircle2, Shield, ArrowLeft } from 'lucide-react'
import { LogoMark } from '@/components/ui/logo'
import { toast } from 'sonner'
import { useAuthStore } from '@/store/auth-store'
import { useTranslations } from 'next-intl'
import { LanguageSwitcher } from '@/components/ui/language-switcher'
import type { AuthMode } from '@/store/app-store'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@/components/ui/input-otp'

interface AuthModalProps {
  mode: AuthMode
  onModeChange: (mode: AuthMode) => void
  onClose: () => void
  /** Token from a password-reset email link; pre-fills (and hides) the token field. */
  initialResetToken?: string
}

export function AuthModal({ mode, onModeChange, onClose, initialResetToken }: AuthModalProps) {
  const { login, register, completeTwoFactorLogin, loginWithBackupCode } = useAuthStore()
  const t = useTranslations('auth')
  const [isLoading, setIsLoading] = useState(false)

  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')

  // ── 2FA state ─────────────────────────────────────────────────────────
  // When login() returns requiresTwoFactor we transition into the
  // 'two-factor' mode (local UI mode, not the global app-store one) and
  // prompt for the 6-digit code. `tempToken` is the short-lived JWT
  // returned by /api/auth/login.
  const [twoFactorTempToken, setTwoFactorTempToken] = useState('')
  const [twoFactorCode, setTwoFactorCode] = useState('')
  const [twoFactorEmail, setTwoFactorEmail] = useState('')
  const [backupCode, setBackupCode] = useState('')
  const [showBackupInput, setShowBackupInput] = useState(false)

  const [registerName, setRegisterName] = useState('')
  const [registerEmail, setRegisterEmail] = useState('')
  const [registerPassword, setRegisterPassword] = useState('')
  const [registerConfirmPassword, setRegisterConfirmPassword] = useState('')
  const [registerSuccess, setRegisterSuccess] = useState(false)

  const [forgotEmail, setForgotEmail] = useState('')
  const [forgotToken, setForgotToken] = useState('')
  const [forgotSuccess, setForgotSuccess] = useState(false)

  const [resetToken, setResetToken] = useState(initialResetToken ?? '')
  const tokenFromLink = !!initialResetToken && resetToken === initialResetToken
  // The modal can already be open (panel host) when the link's token arrives.
  useEffect(() => {
    if (initialResetToken) setResetToken(initialResetToken)
  }, [initialResetToken])
  const [resetPassword, setResetPassword] = useState('')
  const [resetConfirmPassword, setResetConfirmPassword] = useState('')

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!loginEmail || !loginPassword) {
      toast.error(t('fillAll'))
      return
    }
    setIsLoading(true)
    try {
      const result = await login(loginEmail, loginPassword)
      if (result.requiresTwoFactor) {
        // Stash the temp token + email so the second-factor form can use
        // them, and flip the modal into 2FA mode.
        setTwoFactorTempToken(result.tempToken)
        setTwoFactorEmail(loginEmail)
        setTwoFactorCode('')
        setBackupCode('')
        setShowBackupInput(false)
        onModeChange('two-factor')
        return
      }
      toast.success(t('welcome'))
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setIsLoading(false)
    }
  }

  const handleTwoFactorVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    if (twoFactorCode.length !== 6) {
      toast.error('Please enter the 6-digit code from your authenticator app')
      return
    }
    setIsLoading(true)
    try {
      await completeTwoFactorLogin(twoFactorTempToken, twoFactorCode)
      toast.success(t('welcome'))
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Verification failed')
    } finally {
      setIsLoading(false)
    }
  }

  const handleBackupCodeVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!backupCode.trim()) {
      toast.error('Please enter a backup code')
      return
    }
    setIsLoading(true)
    try {
      // The tempToken proves the password step; the backup code replaces
      // only the 6-digit code.
      await loginWithBackupCode(twoFactorTempToken, backupCode.trim())
      toast.success(t('welcome'))
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Backup code verification failed')
    } finally {
      setIsLoading(false)
    }
  }

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!registerName || !registerEmail || !registerPassword || !registerConfirmPassword) {
      toast.error(t('fillAll'))
      return
    }
    if (registerPassword !== registerConfirmPassword) {
      toast.error(t('mismatch'))
      return
    }
    // Same rule as the server (api/auth/register).
    if (registerPassword.length < 8) {
      toast.error(t('tooShort'))
      return
    }
    setIsLoading(true)
    try {
      await register(registerName, registerEmail, registerPassword)
      // Registration now requires email verification - do NOT auto-login.
      // Show a 'check your email' success state instead of closing the modal.
      setRegisterSuccess(true)
      toast.success(t('created'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Registration failed')
    } finally {
      setIsLoading(false)
    }
  }

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!forgotEmail) {
      toast.error('Please enter your email')
      return
    }
    setIsLoading(true)
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Failed to send reset email')
      }
      // Security: API no longer returns the reset token in the response.
      // Always show the generic 'check your email' message.
      setForgotToken('')
      setForgotSuccess(true)
      toast.success(
        data.message ||
          'If an account with that email exists, a reset link has been sent.'
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send reset email')
    } finally {
      setIsLoading(false)
    }
  }

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!resetToken || !resetPassword || !resetConfirmPassword) {
      toast.error('Please fill in all fields')
      return
    }
    if (resetPassword !== resetConfirmPassword) {
      toast.error('Passwords do not match')
      return
    }
    if (resetPassword.length < 8) {
      toast.error('Password must be at least 8 characters')
      return
    }
    setIsLoading(true)
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, newPassword: resetPassword }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Failed to reset password')
      }
      toast.success('Password reset successfully! You can now sign in.')
      // Reset form state and switch back to login
      setResetToken('')
      setResetPassword('')
      setResetConfirmPassword('')
      setForgotEmail('')
      setForgotToken('')
      setForgotSuccess(false)
      onModeChange('login')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reset password')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative w-full max-w-md bg-card rounded-2xl shadow-2xl border overflow-hidden">
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          className="absolute top-4 end-4 size-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <X className="size-4" />
        </button>

        <LanguageSwitcher compact className="absolute top-3.5 start-3" />

        {/* Header */}
        <div className="text-center pt-8 pb-4 px-6">
          <div className="mx-auto mb-3 flex items-center justify-center gap-2">
            <LogoMark className="size-11" />
          </div>
          <h2 className="text-xl font-bold tracking-tight">{t('brand')}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {mode === 'login'
              ? t('subLogin')
              : mode === 'register'
                ? t('subRegister')
                : mode === 'forgot-password'
                  ? t('subForgot')
                  : mode === 'two-factor'
                    ? t('subTwoFactor')
                    : tokenFromLink
                      ? t('subResetLink')
                      : t('subResetToken')}
          </p>
        </div>

        {/* Form */}
        <div className="px-6 pb-8">
          {mode === 'login' && (
            <form onSubmit={handleLogin} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="login-email">{t('email')}</Label>
                <Input
                  id="login-email"
                  type="email"
                  placeholder="you@example.com"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  autoComplete="email"
                  disabled={isLoading}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="login-password">{t('password')}</Label>
                <Input
                  id="login-password"
                  type="password"
                  placeholder={t('passwordPlaceholder')}
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  autoComplete="current-password"
                  disabled={isLoading}
                />
              </div>
              <Button
                type="submit"
                className="mt-2 w-full bg-indigo-500 hover:bg-indigo-600 text-white"
                disabled={isLoading}
              >
                {isLoading ? (
                  <>
                    <Loader2 className="size-4 animate-spin me-2" />
                    {t('signingIn')}
                  </>
                ) : (
                  t('signIn')
                )}
              </Button>
              <div className="flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setForgotSuccess(false)
                    setForgotToken('')
                    onModeChange('forgot-password')
                  }}
                  className="text-sm font-medium text-indigo-600 hover:text-indigo-700 hover:underline"
                  disabled={isLoading}
                >
                  {t('forgot')}
                </button>
                <p className="text-sm text-muted-foreground">
                  {t('noAccount')}{' '}
                  <button
                    type="button"
                    onClick={() => onModeChange('register')}
                    className="font-medium text-indigo-600 hover:text-indigo-700 hover:underline"
                    disabled={isLoading}
                  >
                    {t('signUp')}
                  </button>
                </p>
              </div>
            </form>
          )}

          {mode === 'two-factor' && (
            <div className="flex flex-col gap-4">
              {/* Shield icon */}
              <div className="flex justify-center">
                <div className="flex size-12 items-center justify-center rounded-full bg-indigo-500/10">
                  <Shield className="size-6 text-indigo-600" />
                </div>
              </div>

              {!showBackupInput ? (
                <form onSubmit={handleTwoFactorVerify} className="flex flex-col gap-4">
                  <div className="text-center space-y-1">
                    <p className="text-sm font-medium">Two-Factor Authentication</p>
                    <p className="text-xs text-muted-foreground">
                      Open your authenticator app (Google Authenticator, Authy, 1Password, etc.) and enter the 6-digit code for {twoFactorEmail || 'your account'}.
                    </p>
                  </div>

                  <div className="flex flex-col items-center gap-2">
                    <InputOTP
                      maxLength={6}
                      value={twoFactorCode}
                      onChange={(value) => setTwoFactorCode(value)}
                      disabled={isLoading}
                      autoFocus
                    >
                      <InputOTPGroup>
                        <InputOTPSlot index={0} />
                        <InputOTPSlot index={1} />
                        <InputOTPSlot index={2} />
                        <InputOTPSlot index={3} />
                        <InputOTPSlot index={4} />
                        <InputOTPSlot index={5} />
                      </InputOTPGroup>
                    </InputOTP>
                  </div>

                  <Button
                    type="submit"
                    className="mt-2 w-full bg-indigo-500 hover:bg-indigo-600 text-white"
                    disabled={isLoading || twoFactorCode.length !== 6}
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="size-4 animate-spin me-2" />
                        Verifying...
                      </>
                    ) : (
                      'Verify & Sign In'
                    )}
                  </Button>

                  <div className="flex flex-col items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setShowBackupInput(true)}
                      className="text-sm font-medium text-indigo-600 hover:text-indigo-700 hover:underline"
                      disabled={isLoading}
                    >
                      Use a backup code instead
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTwoFactorTempToken('')
                        setTwoFactorCode('')
                        setTwoFactorEmail('')
                        setBackupCode('')
                        setShowBackupInput(false)
                        onModeChange('login')
                      }}
                      className="text-sm font-medium text-muted-foreground hover:text-foreground hover:underline inline-flex items-center gap-1"
                      disabled={isLoading}
                    >
                      <ArrowLeft className="size-3" />
                      Back to sign in
                    </button>
                  </div>
                </form>
              ) : (
                <form onSubmit={handleBackupCodeVerify} className="flex flex-col gap-4">
                  <div className="text-center space-y-1">
                    <p className="text-sm font-medium">Use Backup Code</p>
                    <p className="text-xs text-muted-foreground">
                      Enter one of the 10 single-use backup codes you saved when enabling 2FA. Each code can only be used once.
                    </p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="backup-code">Backup Code</Label>
                    <Input
                      id="backup-code"
                      type="text"
                      placeholder="AB12-CD34"
                      value={backupCode}
                      onChange={(e) => setBackupCode(e.target.value)}
                      autoComplete="one-time-code"
                      disabled={isLoading}
                      className="font-mono text-center text-lg tracking-wider"
                      autoFocus
                    />
                  </div>

                  <Button
                    type="submit"
                    className="mt-2 w-full bg-indigo-500 hover:bg-indigo-600 text-white"
                    disabled={isLoading || !backupCode.trim()}
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="size-4 animate-spin me-2" />
                        Verifying...
                      </>
                    ) : (
                      'Sign In with Backup Code'
                    )}
                  </Button>

                  <div className="flex justify-center pt-1">
                    <button
                      type="button"
                      onClick={() => setShowBackupInput(false)}
                      className="text-sm font-medium text-muted-foreground hover:text-foreground hover:underline inline-flex items-center gap-1"
                      disabled={isLoading}
                    >
                      <ArrowLeft className="size-3" />
                      Use authenticator app
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {mode === 'register' && (
            registerSuccess ? (
              <div className="flex flex-col gap-4">
                <div className="flex justify-center">
                  <div className="flex size-12 items-center justify-center rounded-full bg-indigo-500/10">
                    <CheckCircle2 className="size-6 text-indigo-600" />
                  </div>
                </div>
                <div className="rounded-lg border bg-indigo-500/5 border-indigo-500/20 p-4 space-y-2 text-center">
                  <p className="text-sm font-medium text-indigo-700 dark:text-indigo-400">
                    Check your email for verification
                  </p>
                  <p className="text-xs text-muted-foreground">
                    We sent a verification link to{' '}
                    <span className="font-medium text-foreground">{registerEmail}</span>.
                    Click the link in the email to activate your account, then sign in.
                  </p>
                </div>
                <Button
                  type="button"
                  className="w-full bg-indigo-500 hover:bg-indigo-600 text-white"
                  onClick={() => {
                    setRegisterSuccess(false)
                    setRegisterName('')
                    setRegisterEmail('')
                    setRegisterPassword('')
                    setRegisterConfirmPassword('')
                    onModeChange('login')
                  }}
                >
                  Continue to sign in
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  Didn&apos;t get the email? Check your spam folder, or{' '}
                  <button
                    type="button"
                    onClick={() => setRegisterSuccess(false)}
                    className="font-medium text-indigo-600 hover:text-indigo-700 hover:underline"
                  >
                    try a different email
                  </button>
                  .
                </p>
              </div>
            ) : (
              <form onSubmit={handleRegister} className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="register-name">{t('fullName')}</Label>
                  <Input
                    id="register-name"
                    type="text"
                    placeholder={t('namePlaceholder')}
                    value={registerName}
                    onChange={(e) => setRegisterName(e.target.value)}
                    autoComplete="name"
                    disabled={isLoading}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="register-email">{t('email')}</Label>
                  <Input
                    id="register-email"
                    type="email"
                    placeholder="you@example.com"
                    value={registerEmail}
                    onChange={(e) => setRegisterEmail(e.target.value)}
                    autoComplete="email"
                    disabled={isLoading}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="register-password">{t('password')}</Label>
                  <Input
                    id="register-password"
                    type="password"
                    placeholder={t('newPasswordPlaceholder')}
                    value={registerPassword}
                    onChange={(e) => setRegisterPassword(e.target.value)}
                    autoComplete="new-password"
                    disabled={isLoading}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="register-confirm-password">{t('confirmPassword')}</Label>
                  <Input
                    id="register-confirm-password"
                    type="password"
                    placeholder={t('repeatPassword')}
                    value={registerConfirmPassword}
                    onChange={(e) => setRegisterConfirmPassword(e.target.value)}
                    autoComplete="new-password"
                    disabled={isLoading}
                  />
                </div>
                <Button
                  type="submit"
                  className="mt-2 w-full bg-indigo-500 hover:bg-indigo-600 text-white"
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="size-4 animate-spin me-2" />
                      {t('creatingAccount')}
                    </>
                  ) : (
                    t('createAccount')
                  )}
                </Button>
                <p className="text-center text-sm text-muted-foreground">
                  {t('haveAccount')}{' '}
                  <button
                    type="button"
                    onClick={() => onModeChange('login')}
                    className="font-medium text-indigo-600 hover:text-indigo-700 hover:underline"
                    disabled={isLoading}
                  >
                    {t('signInLink')}
                  </button>
                </p>
              </form>
            )
          )}

          {mode === 'forgot-password' && (
            <form onSubmit={handleForgotPassword} className="flex flex-col gap-4">
              <div className="flex justify-center">
                <div className="flex size-12 items-center justify-center rounded-full bg-indigo-500/10">
                  <Mail className="size-6 text-indigo-600" />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="forgot-email">Email</Label>
                <Input
                  id="forgot-email"
                  type="email"
                  placeholder="you@example.com"
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  autoComplete="email"
                  disabled={isLoading}
                />
              </div>
              {forgotSuccess && (
                <div className="rounded-lg border bg-indigo-500/5 border-indigo-500/20 p-4 space-y-2 text-center">
                  <p className="text-sm font-medium text-indigo-700 dark:text-indigo-400">
                    Check your email
                  </p>
                  <p className="text-xs text-muted-foreground">
                    If an account with{' '}
                    <span className="font-medium text-foreground">{forgotEmail}</span>{' '}
                    exists, a password reset link has been sent. Click the link in the email to choose a new password.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full mt-2"
                    onClick={() => onModeChange('reset-password')}
                  >
                    I have my token - reset password
                  </Button>
                </div>
              )}
              {!forgotSuccess && (
                <Button
                  type="submit"
                  className="mt-2 w-full bg-indigo-500 hover:bg-indigo-600 text-white"
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="size-4 animate-spin me-2" />
                      Sending reset link...
                    </>
                  ) : (
                    'Send Reset Link'
                  )}
                </Button>
              )}
              <p className="text-center text-sm text-muted-foreground">
                <button
                  type="button"
                  onClick={() => {
                    setForgotSuccess(false)
                    setForgotToken('')
                    onModeChange('login')
                  }}
                  className="font-medium text-indigo-600 hover:text-indigo-700 hover:underline"
                  disabled={isLoading}
                >
                  Back to sign in
                </button>
              </p>
            </form>
          )}

          {mode === 'reset-password' && (
            <form onSubmit={handleResetPassword} className="flex flex-col gap-4">
              <div className="flex justify-center">
                <div className="flex size-12 items-center justify-center rounded-full bg-indigo-500/10">
                  <KeyRound className="size-6 text-indigo-600" />
                </div>
              </div>
              {tokenFromLink ? (
                <p className="text-center text-sm text-muted-foreground">
                  Choose a new password. This link works once and expires an hour after it was sent.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="reset-token">Reset Token</Label>
                  <Input
                    id="reset-token"
                    type="text"
                    placeholder="Paste the token from your reset email"
                    value={resetToken}
                    onChange={(e) => setResetToken(e.target.value)}
                    disabled={isLoading}
                  />
                </div>
              )}
              <div className="flex flex-col gap-2">
                <Label htmlFor="reset-password">New Password</Label>
                <Input
                  id="reset-password"
                  type="password"
                  placeholder="At least 8 characters"
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  autoComplete="new-password"
                  disabled={isLoading}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="reset-confirm-password">Confirm New Password</Label>
                <Input
                  id="reset-confirm-password"
                  type="password"
                  placeholder="Repeat your new password"
                  value={resetConfirmPassword}
                  onChange={(e) => setResetConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  disabled={isLoading}
                />
              </div>
              <Button
                type="submit"
                className="mt-2 w-full bg-indigo-500 hover:bg-indigo-600 text-white"
                disabled={isLoading}
              >
                {isLoading ? (
                  <>
                    <Loader2 className="size-4 animate-spin me-2" />
                    Resetting password...
                  </>
                ) : (
                  'Reset Password'
                )}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                <button
                  type="button"
                  onClick={() => {
                    setResetToken('')
                    setResetPassword('')
                    setResetConfirmPassword('')
                    onModeChange('login')
                  }}
                  className="font-medium text-indigo-600 hover:text-indigo-700 hover:underline"
                  disabled={isLoading}
                >
                  Back to sign in
                </button>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
