'use client'

import { useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Mail, X, Loader2, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'

interface EmailVerificationBannerProps {
  email: string
  onVerified?: () => void
}

export function EmailVerificationBanner({ email, onVerified }: EmailVerificationBannerProps) {
  const [dismissed, setDismissed] = useState(false)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  if (dismissed) return null

  const handleResend = async () => {
    setSending(true)
    try {
      await apiFetch('/auth/resend-verification', { method: 'POST' })
      setSent(true)
      toast.success('Verification email sent!', {
        description: `Check your inbox at ${email}`,
      })
      setTimeout(() => setSent(false), 5000)
    } catch (error) {
      toast.error('Failed to send verification email', {
        description: error instanceof Error ? error.message : 'Please try again',
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <Alert className="border-amber-500/50 bg-amber-500/10 text-amber-200 dark:text-amber-200 mb-4 relative">
      <Mail className="h-4 w-4 text-amber-500" />
      <AlertTitle className="text-amber-300 font-semibold">Verify your email</AlertTitle>
      <AlertDescription className="text-amber-200/80 mt-1">
        <p className="text-sm">
          Please verify your email address ({email}) to access all features.
        </p>
        <div className="flex items-center gap-2 mt-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 border-amber-500/50 text-amber-200 hover:bg-amber-500/20 hover:text-amber-100 text-xs"
            onClick={handleResend}
            disabled={sending || sent}
          >
            {sending ? (
              <>
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                Sending...
              </>
            ) : sent ? (
              <>
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Email Sent!
              </>
            ) : (
              'Resend Email'
            )}
          </Button>
        </div>
      </AlertDescription>
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 h-6 w-6 text-amber-400 hover:text-amber-200 hover:bg-amber-500/20"
        onClick={() => setDismissed(true)}
      >
        <X className="h-3 w-3" />
      </Button>
    </Alert>
  )
}
