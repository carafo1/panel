'use client'

import { useState } from 'react'
import { LifeBuoy, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/store/auth-store'

/**
 * Shown on every page while a super admin is using support access ("Log in as
 * customer"). It cannot be dismissed: anyone looking at the screen must be
 * able to tell they are not seeing their own account.
 */
export function SupportSessionBanner() {
  const user = useAuthStore((s) => s.user)
  const [busy, setBusy] = useState(false)
  if (!user?.supportSession) return null

  const endSupport = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/auth/support/end', { method: 'POST', credentials: 'same-origin' })
      const data = (await res.json().catch(() => ({}))) as { returnedToAdmin?: boolean; error?: string }
      if (!res.ok) throw new Error(data.error || 'Could not end support access')
      toast.success(data.returnedToAdmin ? 'Back in your admin account' : 'Support access ended — please sign in again')
      // Reload so every panel re-reads data as the restored user.
      window.location.assign('/')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not end support access')
      setBusy(false)
    }
  }

  return (
    <div
      role="status"
      className="flex flex-col gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
    >
      <span className="flex items-start gap-2">
        <LifeBuoy className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          <strong>Support access:</strong> you are viewing the panel as <strong>{user.email}</strong>
          {user.supportSession.adminEmail ? <> (signed in as {user.supportSession.adminEmail})</> : null}. Everything you do
          is logged against your admin account. This session ends after 1 hour.
        </span>
      </span>
      <Button size="sm" variant="outline" onClick={endSupport} disabled={busy} className="shrink-0 border-amber-400 bg-white/60 dark:bg-transparent">
        {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
        Return to admin
      </Button>
    </div>
  )
}
