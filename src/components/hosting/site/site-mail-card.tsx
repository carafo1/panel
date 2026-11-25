'use client'

/**
 * "Website email" card (Email area): outgoing mail for a WordPress / PHP
 * website, so its contact forms and password resets actually arrive.
 *
 *   GET  /api/hosting/[id]/mail                      status
 *   POST /api/hosting/[id]/mail  { action: 'enable' | 'disable' | 'rotate' | 'test' }
 *
 * Kept in its own file because the endpoint is new and still settling; the
 * card reads its fields defensively. A 404 (the endpoint is not deployed on
 * this panel yet) is shown as a calm "not available yet", not an error.
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, KeyRound, Loader2, MailCheck, Power, Send, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { InlineError, formatDate, jsonHeaders, timeAgo } from './shared'

interface MailStatus {
  supported?: boolean
  enabled: boolean
  address?: string | null
  fromAddress: string | null
  fromName?: string | null
  smtpHost?: string
  smtpPort?: number
  rateLimitPerHour?: number | null
  lastError?: string | null
  lastTest: { at: string; ok: boolean; message: string | null } | null
  appliesOn?: 'immediately' | 'redeploy' | null
}

type Action = 'enable' | 'disable' | 'rotate' | 'test'

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: MailStatus }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }

const CONFIRM: Partial<Record<Action, { title: string; body: string; cta: string }>> = {
  disable: {
    title: 'Turn off website email?',
    body: 'Contact forms, order emails and password resets from this website stop being sent until you turn it on again.',
    cta: 'Turn off',
  },
  rotate: {
    title: 'Replace the mail password?',
    body: 'The website gets a new password for its sending mailbox. Anything else you set up with the old password stops working.',
    cta: 'Replace password',
  },
}

/** Pull a status out of a POST answer ({ status }) or a GET answer (the status itself). */
function readStatus(data: unknown): MailStatus | null {
  const d = data as { status?: unknown } | null
  const s = (d && typeof d.status === 'object' && d.status ? d.status : d) as Partial<MailStatus> | null
  if (!s || typeof s.enabled !== 'boolean') return null
  return { ...s, enabled: s.enabled, fromAddress: s.fromAddress ?? null, lastTest: s.lastTest ?? null }
}

export function SiteMailCard({ projectId }: { projectId: string }) {
  const url = `/api/hosting/${projectId}/mail`
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [busy, setBusy] = useState<Action | null>(null)
  const [confirm, setConfirm] = useState<Action | null>(null)

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const res = await fetch(url, { headers: jsonHeaders(), cache: 'no-store' })
      if (res.status === 404) {
        setState({ kind: 'missing' })
        return
      }
      const data = await res.json().catch(() => null)
      const status = res.ok ? readStatus(data) : null
      if (!status) {
        setState({ kind: 'error', message: data?.error || `The server answered ${res.status}.` })
        return
      }
      setState({ kind: 'ready', status })
    } catch {
      setState({ kind: 'error', message: 'Network error. Check your connection and try again.' })
    }
  }, [url])

  useEffect(() => {
    load()
  }, [load])

  const run = async (action: Action) => {
    setConfirm(null)
    setBusy(action)
    try {
      const res = await fetch(url, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ action }) })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || `The server answered ${res.status}.`)
      const next = readStatus(data)
      if (next) setState({ kind: 'ready', status: next })
      else load()
      if (action === 'test') {
        const t = data?.test as { ok?: boolean; message?: string } | undefined
        if (t && t.ok === false) toast.error(t.message || 'The test email was not sent.')
        else toast.success(t?.message || 'Test email sent. Check your inbox.')
      } else {
        const apply = data?.apply as { ok?: boolean; message?: string } | undefined
        const done = { enable: 'Website email turned on', disable: 'Website email turned off', rotate: 'Mail password replaced' }[action]
        if (apply && apply.ok === false) toast.warning(`${done}, but the website was not updated yet`, { description: apply.message })
        else toast.success(done)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That did not work. Try again.')
    } finally {
      setBusy(null)
    }
  }

  const request = (action: Action) => (CONFIRM[action] ? setConfirm(action) : run(action))

  return (
    <section aria-labelledby="site-mail-heading" className="rounded-xl border bg-card">
      <div className="flex flex-col gap-1 border-b p-4 sm:p-5">
        <h3 id="site-mail-heading" className="flex items-center gap-2 text-base font-semibold">
          <MailCheck className="size-4 text-primary" aria-hidden />
          Website email
        </h3>
        <p className="text-sm text-muted-foreground">
          Lets your website send mail itself: contact forms, order confirmations and password resets.
        </p>
      </div>
      <div className="p-4 sm:p-5">
        {state.kind === 'loading' ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading website email">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : state.kind === 'missing' ? (
          <p role="status" className="rounded-lg border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
            Website email is not available on this panel yet. Your website keeps sending mail the way it does today.
          </p>
        ) : state.kind === 'error' ? (
          <InlineError title="Could not load website email" message={state.message} onRetry={load} />
        ) : state.status.supported === false ? (
          <p role="status" className="rounded-lg border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
            Website email is available for WordPress and PHP websites. This website sends mail with its own settings.
          </p>
        ) : (
          <MailStatusView status={state.status} busy={busy} onAction={request} />
        )}
      </div>

      <AlertDialog open={!!confirm} onOpenChange={(v) => !v && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm && CONFIRM[confirm]?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm && CONFIRM[confirm]?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirm && run(confirm)}>{confirm && CONFIRM[confirm]?.cta}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function MailStatusView({ status, busy, onAction }: { status: MailStatus; busy: Action | null; onAction: (a: Action) => void }) {
  const spinner = (a: Action) => (busy === a ? <Loader2 className="animate-spin" aria-hidden /> : null)
  const from = status.fromAddress || status.address

  if (!status.enabled) {
    return (
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <Badge variant="outline" className="mb-1.5">Off</Badge>
          <p className="text-sm text-muted-foreground">
            Turn it on and the platform creates a sending mailbox for this website and connects it
            {status.appliesOn === 'redeploy' ? ' on the next deploy.' : '.'}
          </p>
          {status.lastError && <p className="mt-1 text-xs text-red-700 dark:text-red-300">Last problem: {status.lastError}</p>}
        </div>
        <Button onClick={() => onAction('enable')} disabled={!!busy} className="shrink-0">
          {spinner('enable') ?? <Power aria-hidden />}
          Turn on
        </Button>
      </div>
    )
  }

  const test = status.lastTest
  return (
    <div className="grid gap-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Status</dt>
          <dd className="mt-0.5">
            <Badge className="bg-emerald-100 text-emerald-900 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-200">On</Badge>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Sends as</dt>
          <dd className="mt-0.5 truncate font-mono text-[13px]">
            {status.fromName ? `${status.fromName} <${from ?? '—'}>` : from ?? '—'}
          </dd>
        </div>
        {status.smtpHost && (
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Mail server</dt>
            <dd className="mt-0.5 truncate font-mono text-[13px]">
              {status.smtpHost}
              {status.smtpPort ? `:${status.smtpPort}` : ''}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-xs text-muted-foreground">Last test</dt>
          <dd className="mt-0.5 flex items-center gap-1.5">
            {test ? (
              <>
                {test.ok ? (
                  <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />
                ) : (
                  <XCircle className="size-4 text-red-600" aria-hidden />
                )}
                <span title={formatDate(test.at)}>
                  {test.ok ? 'Delivered' : 'Failed'} · {timeAgo(test.at)}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">Not tested yet</span>
            )}
          </dd>
        </div>
      </dl>
      {test && !test.ok && test.message && <p className="text-xs text-red-700 dark:text-red-300">{test.message}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onAction('test')} disabled={!!busy}>
          {spinner('test') ?? <Send aria-hidden />}
          Send a test email
        </Button>
        <Button size="sm" variant="outline" onClick={() => onAction('rotate')} disabled={!!busy}>
          {spinner('rotate') ?? <KeyRound aria-hidden />}
          Replace password
        </Button>
        <Button size="sm" variant="outline" className="text-red-700 hover:text-red-800 dark:text-red-300" onClick={() => onAction('disable')} disabled={!!busy}>
          {spinner('disable') ?? <Power aria-hidden />}
          Turn off
        </Button>
      </div>
    </div>
  )
}
