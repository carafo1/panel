'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuthStore, apiFetch } from '@/store/auth-store'
import { toast } from 'sonner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  User,
  Shield,
  ShieldCheck,
  QrCode,
  Key,
  Download,
  Copy,
  Bell,
  Save,
  Plus,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  Eye,
  EyeOff,
  Loader2,
  KeyRound,
  Server,
  Globe,
  CreditCard,
  Mail,
  History,
} from 'lucide-react'
import AuditLogPanel from '@/components/settings/audit-log-panel'

// ── Types ──────────────────────────────────────────────────────────────────
interface ApiKeyItem {
  id: string
  name: string
  prefix: string
  lastUsed: string | null
  createdAt: string
}

// ── Password Strength ──────────────────────────────────────────────────────
function getPasswordStrength(password: string): { label: string; color: string; percent: number } {
  if (!password) return { label: '', color: '', percent: 0 }
  let score = 0
  if (password.length >= 8) score++
  if (password.length >= 12) score++
  if (/[A-Z]/.test(password)) score++
  if (/[0-9]/.test(password)) score++
  if (/[^A-Za-z0-9]/.test(password)) score++

  if (score <= 1) return { label: 'Weak', color: 'bg-red-500', percent: 20 }
  if (score <= 2) return { label: 'Fair', color: 'bg-orange-500', percent: 40 }
  if (score <= 3) return { label: 'Medium', color: 'bg-yellow-500', percent: 60 }
  if (score <= 4) return { label: 'Strong', color: 'bg-indigo-400', percent: 80 }
  return { label: 'Very Strong', color: 'bg-indigo-600', percent: 100 }
}

// ── Profile Tab ────────────────────────────────────────────────────────────
function ProfileTab() {
  const { user, setAuth } = useAuthStore()
  const [name, setName] = useState(user?.name || '')
  const [email, setEmail] = useState(user?.email || '')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    setSaving(true)
    try {
      const data = await apiFetch('/user/profile', {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim(), email: email.trim() }),
      })
      // Update the auth store with new user data
      if (user) {
        setAuth(data.user, localStorage.getItem('deployhub_token') || '')
      }
      toast.success('Profile updated successfully')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update profile')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Avatar & Basic Info */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="size-5 text-indigo-600" />
            Profile Information
          </CardTitle>
          <CardDescription>
            Update your personal details and email address.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Avatar */}
          <div className="flex items-center gap-4">
            <div className="size-16 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
              <span className="text-2xl font-bold text-indigo-700">
                {name?.charAt(0)?.toUpperCase() || 'U'}
              </span>
            </div>
            <div>
              <p className="font-medium">{user?.name || 'User'}</p>
              <p className="text-sm text-muted-foreground">{user?.email}</p>
              <div className="flex items-center gap-2 mt-1">
                <Badge variant="outline" className="text-[10px] capitalize">{user?.role}</Badge>
                {user?.emailVerified ? (
                  <Badge className="text-[10px] bg-indigo-100 text-indigo-700 hover:bg-indigo-100">
                    <CheckCircle2 className="size-3 mr-1" /> Verified
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300">
                    Not Verified
                  </Badge>
                )}
              </div>
            </div>
          </div>

          <Separator />

          {/* Form fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="profile-name">Full Name</Label>
              <Input
                id="profile-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="profile-email">Email Address</Label>
              <Input
                id="profile-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
              {email !== user?.email && (
                <p className="text-xs text-amber-600 flex items-center gap-1">
                  <AlertTriangle className="size-3" />
                  Changing email will require re-verification
                </p>
              )}
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin mr-2" />
              ) : (
                <Save className="size-4 mr-2" />
              )}
              Save Changes
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ── Two-Factor Authentication Section ──────────────────────────────────────
function TwoFactorSection() {
  const { user } = useAuthStore()
  const [enabled, setEnabled] = useState<boolean>(!!user?.twoFactorEnabled)

  // Refresh from server on mount (the auth-store may have been hydrated
  // before the 2FA field was added).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await apiFetch('/auth/me')
        if (!cancelled && typeof data?.user?.twoFactorEnabled === 'boolean') {
          setEnabled(data.user.twoFactorEnabled)
        }
      } catch {
        // ignore — fall back to the store value
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <TwoFactorCard enabled={enabled} onToggle={setEnabled} />
  )
}

interface TwoFactorCardProps {
  enabled: boolean
  onToggle: (enabled: boolean) => void
}

function TwoFactorCard({ enabled, onToggle }: TwoFactorCardProps) {
  // ── Enable flow state ───────────────────────────────────────────────
  const [enableOpen, setEnableOpen] = useState(false)
  const [setupData, setSetupData] = useState<{
    secret: string
    qrCode: string
    manualEntry: string
  } | null>(null)
  const [verifyToken, setVerifyToken] = useState('')
  const [enabling, setEnabling] = useState(false)
  const [settingUp, setSettingUp] = useState(false)
  // 'qr' = show QR + verify input, 'backup' = show backup codes
  const [enableStep, setEnableStep] = useState<'qr' | 'backup'>('qr')
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [copiedAll, setCopiedAll] = useState(false)

  // ── Disable flow state ──────────────────────────────────────────────
  const [disableOpen, setDisableOpen] = useState(false)
  const [disableToken, setDisableToken] = useState('')
  const [disabling, setDisabling] = useState(false)

  const handleBeginEnable = async () => {
    setEnableOpen(true)
    setEnableStep('qr')
    setVerifyToken('')
    setBackupCodes([])
    setSetupData(null)
    setSettingUp(true)
    try {
      const data = await apiFetch('/auth/2fa/setup', { method: 'POST' })
      setSetupData(data)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start 2FA setup')
      setEnableOpen(false)
    } finally {
      setSettingUp(false)
    }
  }

  const handleVerifyEnable = async () => {
    if (!setupData) return
    if (verifyToken.length !== 6) {
      toast.error('Please enter the 6-digit code')
      return
    }
    setEnabling(true)
    try {
      const data = await apiFetch('/auth/2fa/verify', {
        method: 'POST',
        body: JSON.stringify({ secret: setupData.secret, token: verifyToken }),
      })
      setBackupCodes(data.backupCodes)
      setEnableStep('backup')
      setEnabled(true)
      onToggle(true)
      toast.success('Two-factor authentication enabled!')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Verification failed')
    } finally {
      setEnabling(false)
    }
  }

  const handleCloseEnable = () => {
    setEnableOpen(false)
    setSetupData(null)
    setVerifyToken('')
    setBackupCodes([])
    setEnableStep('qr')
    setCopiedAll(false)
  }

  const handleDownloadBackupCodes = () => {
    if (!backupCodes.length) return
    const text =
      `APSAMO 2FA Backup Codes\n` +
      `Generated: ${new Date().toLocaleString()}\n\n` +
      backupCodes.map((c, i) => `${i + 1}.  ${c}`).join('\n') +
      `\n\nEach code can be used only once. Store them somewhere safe.\n`
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'deployhub-backup-codes.txt'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    toast.success('Backup codes downloaded')
  }

  const handleCopyAllBackupCodes = async () => {
    if (!backupCodes.length) return
    try {
      await navigator.clipboard.writeText(backupCodes.join('\n'))
      setCopiedAll(true)
      toast.success('All backup codes copied')
      setTimeout(() => setCopiedAll(false), 2000)
    } catch {
      toast.error('Failed to copy to clipboard')
    }
  }

  const handleDisable = async () => {
    if (disableToken.length !== 6) {
      toast.error('Please enter your 6-digit verification code')
      return
    }
    setDisabling(true)
    try {
      await apiFetch('/auth/2fa/disable', {
        method: 'POST',
        body: JSON.stringify({ token: disableToken }),
      })
      setEnabled(false)
      onToggle(false)
      setDisableOpen(false)
      setDisableToken('')
      toast.success('Two-factor authentication disabled')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to disable 2FA')
    } finally {
      setDisabling(false)
    }
  }

  const handleCloseDisable = () => {
    setDisableOpen(false)
    setDisableToken('')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-indigo-600" />
          Two-Factor Authentication
        </CardTitle>
        <CardDescription>
          Add an extra layer of security to your account using an authenticator app.
          You&apos;ll need a 6-digit code every time you sign in.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status row */}
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="flex items-start gap-3">
            <div
              className={`size-9 rounded-lg flex items-center justify-center shrink-0 ${
                enabled
                  ? 'bg-indigo-50 text-indigo-600'
                  : 'bg-amber-50 text-amber-600'
              }`}
            >
              {enabled ? <ShieldCheck className="size-4" /> : <Shield className="size-4" />}
            </div>
            <div>
              <p className="text-sm font-medium">
                {enabled ? 'Two-factor authentication is enabled' : 'Two-factor authentication is not enabled'}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {enabled
                  ? 'Your account is protected with an authenticator app.'
                  : 'Enable 2FA to protect your account with a second factor.'}
              </p>
            </div>
          </div>
          <Badge
            className={`shrink-0 ${
              enabled
                ? 'bg-indigo-100 text-indigo-700 hover:bg-indigo-100'
                : 'bg-amber-100 text-amber-700 hover:bg-amber-100'
            }`}
          >
            {enabled ? 'Enabled' : 'Disabled'}
          </Badge>
        </div>

        {/* Action buttons */}
        <div className="flex flex-col sm:flex-row gap-2">
          {!enabled ? (
            <Button
              onClick={handleBeginEnable}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
              disabled={settingUp}
            >
              {settingUp ? (
                <Loader2 className="size-4 animate-spin mr-2" />
              ) : (
                <Shield className="size-4 mr-2" />
              )}
              Enable 2FA
            </Button>
          ) : (
            <Button
              onClick={() => setDisableOpen(true)}
              variant="outline"
              className="text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
            >
              <Shield className="size-4 mr-2" />
              Disable 2FA
            </Button>
          )}
        </div>

        {/* ── Enable dialog ─────────────────────────────────────────── */}
        <Dialog open={enableOpen} onOpenChange={(open) => {
          if (!open) handleCloseEnable()
        }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Shield className="size-5 text-indigo-600" />
                {enableStep === 'qr' ? 'Set Up Two-Factor Authentication' : 'Save Your Backup Codes'}
              </DialogTitle>
              <DialogDescription>
                {enableStep === 'qr'
                  ? 'Scan the QR code with your authenticator app, then enter the 6-digit code it shows.'
                  : 'These codes can be used to sign in if you lose access to your authenticator. Save them now — this is the only time they will be shown.'}
              </DialogDescription>
            </DialogHeader>

            {enableStep === 'qr' && (
              <div className="space-y-4 py-2">
                {settingUp && !setupData ? (
                  <div className="flex flex-col items-center py-8 gap-2">
                    <Loader2 className="size-6 animate-spin text-indigo-600" />
                    <p className="text-sm text-muted-foreground">Generating secret…</p>
                  </div>
                ) : setupData ? (
                  <>
                    {/* QR code */}
                    <div className="flex justify-center">
                      <div className="rounded-lg border bg-white p-3">
                        { }
                        <img
                          src={setupData.qrCode}
                          alt="2FA QR code"
                          className="size-48"
                        />
                      </div>
                    </div>

                    {/* Manual entry */}
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <Key className="size-3.5 text-muted-foreground" />
                        <p className="text-xs font-medium text-muted-foreground">
                          Can&apos;t scan? Enter this code manually:
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 rounded bg-muted px-3 py-2 text-xs font-mono break-all select-all">
                          {setupData.manualEntry}
                        </code>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="shrink-0"
                          onClick={() => {
                            navigator.clipboard.writeText(setupData.manualEntry)
                            toast.success('Secret copied to clipboard')
                          }}
                        >
                          <Copy className="size-4" />
                        </Button>
                      </div>
                    </div>

                    <Separator />

                    {/* Verification token input */}
                    <div className="space-y-2">
                      <Label htmlFor="verify-token">Enter the 6-digit code from your app</Label>
                      <Input
                        id="verify-token"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={6}
                        placeholder="123456"
                        value={verifyToken}
                        onChange={(e) => setVerifyToken(e.target.value.replace(/\D/g, ''))}
                        className="text-center text-lg tracking-[0.5em] font-mono"
                        disabled={enabling}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && verifyToken.length === 6) handleVerifyEnable()
                        }}
                      />
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    Setup failed to start. Please close and try again.
                  </p>
                )}
              </div>
            )}

            {enableStep === 'backup' && (
              <div className="space-y-4 py-2">
                <Alert className="border-indigo-300 bg-indigo-50">
                  <CheckCircle2 className="size-4 text-indigo-600" />
                  <AlertDescription>
                    <p className="font-medium text-indigo-800 mb-2">
                      2FA is now enabled! Save these backup codes.
                    </p>
                    <div className="grid grid-cols-2 gap-1.5 bg-white border rounded p-3">
                      {backupCodes.map((code, i) => (
                        <code
                          key={i}
                          className="text-xs font-mono px-2 py-1 rounded bg-muted text-center"
                        >
                          {code}
                        </code>
                      ))}
                    </div>
                  </AlertDescription>
                </Alert>

                <div className="flex flex-col sm:flex-row gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={handleDownloadBackupCodes}
                  >
                    <Download className="size-4 mr-2" />
                    Download
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={handleCopyAllBackupCodes}
                  >
                    {copiedAll ? (
                      <CheckCircle2 className="size-4 mr-2 text-indigo-600" />
                    ) : (
                      <Copy className="size-4 mr-2" />
                    )}
                    Copy All
                  </Button>
                </div>
              </div>
            )}

            <DialogFooter>
              {enableStep === 'qr' ? (
                <>
                  <Button variant="outline" onClick={handleCloseEnable}>
                    Cancel
                  </Button>
                  <Button
                    onClick={handleVerifyEnable}
                    disabled={enabling || verifyToken.length !== 6 || !setupData}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white"
                  >
                    {enabling ? (
                      <Loader2 className="size-4 animate-spin mr-2" />
                    ) : (
                      <ShieldCheck className="size-4 mr-2" />
                    )}
                    Verify &amp; Enable
                  </Button>
                </>
              ) : (
                <Button
                  onClick={handleCloseEnable}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white"
                >
                  <CheckCircle2 className="size-4 mr-2" />
                  I&apos;ve saved my codes
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ── Disable dialog ────────────────────────────────────────── */}
        <Dialog open={disableOpen} onOpenChange={(open) => {
          if (!open) handleCloseDisable()
        }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Shield className="size-5 text-amber-600" />
                Disable Two-Factor Authentication
              </DialogTitle>
              <DialogDescription>
                Enter a 6-digit code from your authenticator app to confirm.
                Disabling 2FA will also clear your backup codes.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <Alert className="border-amber-300 bg-amber-50">
                <AlertTriangle className="size-4 text-amber-600" />
                <AlertDescription>
                  Your account will be less secure after 2FA is disabled.
                </AlertDescription>
              </Alert>

              <div className="space-y-2">
                <Label htmlFor="disable-token">Verification Code</Label>
                <Input
                  id="disable-token"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  placeholder="123456"
                  value={disableToken}
                  onChange={(e) => setDisableToken(e.target.value.replace(/\D/g, ''))}
                  className="text-center text-lg tracking-[0.5em] font-mono"
                  disabled={disabling}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && disableToken.length === 6) handleDisable()
                  }}
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleCloseDisable}>
                Cancel
              </Button>
              <Button
                onClick={handleDisable}
                disabled={disabling || disableToken.length !== 6}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {disabling ? (
                  <Loader2 className="size-4 animate-spin mr-2" />
                ) : (
                  <Shield className="size-4 mr-2" />
                )}
                Disable 2FA
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}

// ── Security Tab ───────────────────────────────────────────────────────────
function SecurityTab() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [saving, setSaving] = useState(false)

  const strength = getPasswordStrength(newPassword)
  const passwordsMatch = newPassword === confirmPassword
  const canSubmit = currentPassword && newPassword.length >= 8 && passwordsMatch

  const handleUpdatePassword = async () => {
    if (!passwordsMatch) {
      toast.error('Passwords do not match')
      return
    }
    if (newPassword.length < 8) {
      toast.error('Password must be at least 8 characters')
      return
    }
    setSaving(true)
    try {
      await apiFetch('/user/password', {
        method: 'PATCH',
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      toast.success('Password updated successfully')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update password')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="size-5 text-indigo-600" />
            Change Password
          </CardTitle>
          <CardDescription>
            Update your password to keep your account secure.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Current Password */}
          <div className="space-y-2">
            <Label htmlFor="current-password">Current Password</Label>
            <div className="relative">
              <Input
                id="current-password"
                type={showCurrent ? 'text' : 'password'}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Enter current password"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 -translate-y-1/2 size-7"
                onClick={() => setShowCurrent(!showCurrent)}
              >
                {showCurrent ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </Button>
            </div>
          </div>

          <Separator />

          {/* New Password */}
          <div className="space-y-2">
            <Label htmlFor="new-password">New Password</Label>
            <div className="relative">
              <Input
                id="new-password"
                type={showNew ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 -translate-y-1/2 size-7"
                onClick={() => setShowNew(!showNew)}
              >
                {showNew ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </Button>
            </div>
            {/* Password Strength Indicator */}
            {newPassword && (
              <div className="space-y-1.5">
                <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${strength.color}`}
                    style={{ width: `${strength.percent}%` }}
                  />
                </div>
                <p className={`text-xs font-medium ${
                  strength.label === 'Weak' ? 'text-red-500' :
                  strength.label === 'Fair' ? 'text-orange-500' :
                  strength.label === 'Medium' ? 'text-yellow-600' :
                  'text-indigo-600'
                }`}>
                  Password strength: {strength.label}
                </p>
              </div>
            )}
          </div>

          {/* Confirm Password */}
          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm New Password</Label>
            <Input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
            />
            {confirmPassword && !passwordsMatch && (
              <p className="text-xs text-red-500">Passwords do not match</p>
            )}
            {confirmPassword && passwordsMatch && (
              <p className="text-xs text-indigo-600 flex items-center gap-1">
                <CheckCircle2 className="size-3" /> Passwords match
              </p>
            )}
          </div>

          <div className="flex justify-end pt-2">
            <Button
              onClick={handleUpdatePassword}
              disabled={!canSubmit || saving}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin mr-2" />
              ) : (
                <Shield className="size-4 mr-2" />
              )}
              Update Password
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Two-Factor Authentication */}
      <TwoFactorSection />
    </div>
  )
}

// ── API Keys Tab ───────────────────────────────────────────────────────────
function ApiKeysTab() {
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createdKey, setCreatedKey] = useState<{ id: string; name: string; key: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [deleteKey, setDeleteKey] = useState<ApiKeyItem | null>(null)
  const [deleting, setDeleting] = useState(false)

  const loadApiKeys = useCallback(async () => {
    try {
      const data = await apiFetch('/user/api-keys')
      setApiKeys(data.apiKeys || [])
    } catch {
      toast.error('Failed to load API keys')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadApiKeys()
  }, [loadApiKeys])

  const handleCreate = async () => {
    if (!newKeyName.trim()) {
      toast.error('Please enter a name for the API key')
      return
    }
    setCreating(true)
    try {
      const data = await apiFetch('/user/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: newKeyName.trim() }),
      })
      setCreatedKey(data.apiKey)
      setNewKeyName('')
      toast.success('API key created successfully')
      loadApiKeys()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create API key')
    } finally {
      setCreating(false)
    }
  }

  const handleCopy = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key)
      setCopied(true)
      toast.success('API key copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Failed to copy to clipboard')
    }
  }

  const handleDelete = async () => {
    if (!deleteKey) return
    setDeleting(true)
    try {
      await apiFetch(`/user/api-keys/${deleteKey.id}`, {
        method: 'DELETE',
      })
      toast.success('API key deleted')
      setDeleteKey(null)
      loadApiKeys()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete API key')
    } finally {
      setDeleting(false)
    }
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Key className="size-5 text-indigo-600" />
                API Keys
              </CardTitle>
              <CardDescription className="mt-1.5">
                Manage your API keys for programmatic access to APSAMO.
              </CardDescription>
            </div>
            <Dialog open={createOpen} onOpenChange={(open) => {
              setCreateOpen(open)
              if (!open) setNewKeyName('')
            }}>
              <DialogTrigger asChild>
                <Button className="bg-indigo-600 hover:bg-indigo-700 text-white">
                  <Plus className="size-4 mr-2" />
                  Create API Key
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create New API Key</DialogTitle>
                  <DialogDescription>
                    Give your API key a descriptive name to help you identify it later.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-2">
                  <div className="space-y-2">
                    <Label htmlFor="key-name">Key Name</Label>
                    <Input
                      id="key-name"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                      placeholder="e.g., CI/CD Pipeline, Development"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleCreate()
                      }}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setCreateOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={handleCreate}
                    disabled={creating || !newKeyName.trim()}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white"
                  >
                    {creating ? <Loader2 className="size-4 animate-spin mr-2" /> : <KeyRound className="size-4 mr-2" />}
                    Create Key
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          {/* New key alert */}
          {createdKey && (
            <Alert className="mb-4 border-indigo-300 bg-indigo-50">
              <KeyRound className="size-4 text-indigo-600" />
              <AlertDescription className="space-y-2">
                <p className="font-medium text-indigo-800">
                  API key created! Copy it now — it won&apos;t be shown again.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-white border rounded px-3 py-2 text-sm font-mono break-all">
                    {createdKey.key}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleCopy(createdKey.key)}
                    className="shrink-0"
                  >
                    {copied ? <CheckCircle2 className="size-4 text-indigo-600" /> : <Copy className="size-4" />}
                  </Button>
                </div>
                <p className="text-xs text-indigo-700">
                  Key name: {createdKey.name}
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-indigo-700 hover:text-indigo-800"
                  onClick={() => setCreatedKey(null)}
                >
                  Dismiss
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : apiKeys.length === 0 ? (
            <div className="text-center py-12">
              <Key className="size-10 text-muted-foreground mx-auto mb-3" />
              <p className="font-medium text-muted-foreground">No API keys yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Create an API key to access the APSAMO API programmatically.
              </p>
              <Button
                onClick={() => setCreateOpen(true)}
                className="mt-4 bg-indigo-600 hover:bg-indigo-700 text-white"
              >
                <Plus className="size-4 mr-2" />
                Create Your First API Key
              </Button>
            </div>
          ) : (
            <div className="rounded-lg border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead className="hidden sm:table-cell">Created</TableHead>
                    <TableHead className="hidden md:table-cell">Last Used</TableHead>
                    <TableHead className="w-[80px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {apiKeys.map((apiKey) => (
                    <TableRow key={apiKey.id}>
                      <TableCell className="font-medium">{apiKey.name}</TableCell>
                      <TableCell>
                        <code className="text-xs bg-muted px-2 py-1 rounded font-mono">
                          {apiKey.prefix}{'*'.repeat(24)}
                        </code>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">
                        {formatDate(apiKey.createdAt)}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                        {apiKey.lastUsed ? formatDate(apiKey.lastUsed) : 'Never'}
                      </TableCell>
                      <TableCell>
                        <AlertDialog open={deleteKey?.id === apiKey.id} onOpenChange={(open) => {
                          if (!open) setDeleteKey(null)
                        }}>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-muted-foreground hover:text-red-600"
                              onClick={() => setDeleteKey(apiKey)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete API Key</AlertDialogTitle>
                              <AlertDialogDescription>
                                Are you sure you want to delete the API key &quot;{deleteKey?.name}&quot;?
                                Any applications using this key will lose access immediately.
                                This action cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={handleDelete}
                                disabled={deleting}
                                className="bg-red-600 hover:bg-red-700 text-white"
                              >
                                {deleting ? <Loader2 className="size-4 animate-spin mr-2" /> : null}
                                Delete Key
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ── Notifications Tab ──────────────────────────────────────────────────────
interface NotificationPrefs {
  deployment: boolean
  domain: boolean
  billing: boolean
  security: boolean
  emailDigest: boolean
}

const DEFAULT_PREFS: NotificationPrefs = {
  deployment: true,
  domain: true,
  billing: true,
  security: true,
  emailDigest: false,
}

function NotificationsTab() {
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_PREFS)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    try {
      const stored = localStorage.getItem('deployhub_notification_prefs')
      if (stored) {
        setPrefs({ ...DEFAULT_PREFS, ...JSON.parse(stored) })
      }
    } catch {
      // Use defaults
    }
  }, [])

  const handleToggle = (key: keyof NotificationPrefs) => {
    const updated = { ...prefs, [key]: !prefs[key] }
    setPrefs(updated)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      localStorage.setItem('deployhub_notification_prefs', JSON.stringify(prefs))
      // Simulate API delay
      await new Promise((r) => setTimeout(r, 500))
      toast.success('Notification preferences saved')
    } catch {
      toast.error('Failed to save preferences')
    } finally {
      setSaving(false)
    }
  }

  const notificationItems = [
    {
      key: 'deployment' as const,
      icon: Server,
      title: 'Deployment Notifications',
      description: 'Get notified when deployments succeed, fail, or complete.',
    },
    {
      key: 'domain' as const,
      icon: Globe,
      title: 'Domain Notifications',
      description: 'Receive alerts about domain registration, renewal, and DNS changes.',
    },
    {
      key: 'billing' as const,
      icon: CreditCard,
      title: 'Billing Notifications',
      description: 'Get notified about payments, invoices, and subscription changes.',
    },
    {
      key: 'security' as const,
      icon: Shield,
      title: 'Security Alerts',
      description: 'Receive important security alerts about your account and resources.',
    },
    {
      key: 'emailDigest' as const,
      icon: Mail,
      title: 'Email Digest',
      description: 'Receive a weekly email summary of all your activity.',
    },
  ]

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="size-5 text-indigo-600" />
            Notification Preferences
          </CardTitle>
          <CardDescription>
            Choose which notifications you want to receive.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {notificationItems.map((item, index) => {
            const Icon = item.icon
            return (
              <div key={item.key}>
                <div className="flex items-center justify-between py-4">
                  <div className="flex items-start gap-3">
                    <div className="size-9 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0 mt-0.5">
                      <Icon className="size-4 text-indigo-600" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{item.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
                    </div>
                  </div>
                  <Switch
                    checked={prefs[item.key]}
                    onCheckedChange={() => handleToggle(item.key)}
                  />
                </div>
                {index < notificationItems.length - 1 && <Separator />}
              </div>
            )
          })}

          <div className="flex justify-end pt-4">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin mr-2" />
              ) : (
                <Save className="size-4 mr-2" />
              )}
              Save Preferences
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ── Main Settings Panel ────────────────────────────────────────────────────
export default function SettingsPanel() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground mt-1">
          Manage your account, security, and preferences.
        </p>
      </div>

      <Tabs defaultValue="profile" className="space-y-6">
        <TabsList className="w-full sm:w-auto grid grid-cols-3 sm:grid-cols-5 sm:inline-flex">
          <TabsTrigger value="profile" className="gap-1.5">
            <User className="size-3.5" />
            <span className="hidden sm:inline">Profile</span>
          </TabsTrigger>
          <TabsTrigger value="security" className="gap-1.5">
            <Shield className="size-3.5" />
            <span className="hidden sm:inline">Security</span>
          </TabsTrigger>
          <TabsTrigger value="api-keys" className="gap-1.5">
            <Key className="size-3.5" />
            <span className="hidden sm:inline">API Keys</span>
          </TabsTrigger>
          <TabsTrigger value="notifications" className="gap-1.5">
            <Bell className="size-3.5" />
            <span className="hidden sm:inline">Notifications</span>
          </TabsTrigger>
          <TabsTrigger value="audit-logs" className="gap-1.5">
            <History className="size-3.5" />
            <span className="hidden sm:inline">Audit Logs</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <ProfileTab />
        </TabsContent>

        <TabsContent value="security">
          <SecurityTab />
        </TabsContent>

        <TabsContent value="api-keys">
          <ApiKeysTab />
        </TabsContent>

        <TabsContent value="notifications">
          <NotificationsTab />
        </TabsContent>

        <TabsContent value="audit-logs">
          <AuditLogPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}
