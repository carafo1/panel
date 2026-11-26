'use client'

/**
 * Website → Overview. Four facts the owner checks most (domain and HTTPS,
 * last deploy, last backup, plan usage), each loaded from its own endpoint
 * with its own inline loading and error state, then shortcuts to the tasks
 * people come here for. No number is shown that the API did not return.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { NO_DOMAIN_LABEL } from '@/lib/site-address'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { AdvancedId, AreaId, SiteKind } from './site-areas'
import { formatDate, jsonHeaders, timeAgo } from './shared'
import type { SiteDeployment, SiteProject, SiteSslInfo } from './site-view'

interface BackupRow {
  id: string
  status: string
  type: string
  createdAt: string
  sizeBytes: number
}

interface ResourceCurrent {
  ramMB: number
  ramUsedMB: number
  storageGB: number
  storageUsedGB: number
}

type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: T }

function useJson<T>(url: string, pick: (json: unknown) => T): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: 'loading' })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(url, { headers: jsonHeaders(), cache: 'no-store' })
        const json = await res.json().catch(() => null)
        if (cancelled) return
        if (!res.ok) setLoad({ state: 'error', message: (json as { error?: string } | null)?.error || `HTTP ${res.status}` })
        else setLoad({ state: 'ready', data: pick(json) })
      } catch {
        if (!cancelled) setLoad({ state: 'error', message: 'Network error' })
      }
    })()
    return () => {
      cancelled = true
    }
    // `pick` is a pure mapper declared inline by callers; the URL decides the request.
  }, [url, nonce])
  const retry = useCallback(() => {
    setLoad({ state: 'loading' })
    setNonce((n) => n + 1)
  }, [])
  return [load, retry]
}

type Tone = 'ok' | 'warn' | 'bad' | 'muted'
const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  bad: 'text-red-700 dark:text-red-400',
  muted: 'text-muted-foreground',
}

function Fact({
  label,
  children,
  action,
}: {
  label: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 bg-card p-4 sm:p-5">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 space-y-1 text-sm">{children}</dd>
      {action && <div className="pt-1">{action}</div>}
    </div>
  )
}

function FactLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-0.5 rounded text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
      <ChevronRight className="size-3.5" aria-hidden />
    </button>
  )
}

function FactError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <p className="text-sm text-red-700 dark:text-red-400" role="alert">
      Could not load ({message}).{' '}
      <button type="button" onClick={onRetry} className="font-medium underline underline-offset-4">
        Retry
      </button>
    </p>
  )
}

function UsageBar({ label, used, total, unit }: { label: string; used: number; total: number; unit: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
  const tone = pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-primary'
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          {used.toFixed(used < 10 ? 1 : 0)} / {total} {unit}
        </span>
      </div>
      <div
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={`${label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

const DEPLOY_WORDS: Record<string, { text: string; tone: Tone }> = {
  live: { text: 'Succeeded', tone: 'ok' },
  failed: { text: 'Failed', tone: 'bad' },
  building: { text: 'In progress', tone: 'warn' },
  deploying: { text: 'In progress', tone: 'warn' },
  queued: { text: 'Queued', tone: 'muted' },
  rolled_back: { text: 'Rolled back', tone: 'warn' },
}

export function SiteOverview({
  project,
  kind,
  primaryDomain,
  sslInfo,
  sslLoading,
  latestDeployment,
  onViewDeployLog,
  onNavigate,
}: {
  project: SiteProject
  kind: SiteKind
  /** The site's real domain, or null when none is connected. */
  primaryDomain: string | null
  liveUrl: string | null
  sslInfo: SiteSslInfo | null
  sslLoading: boolean
  latestDeployment: SiteDeployment | null
  onViewDeployLog: (d: SiteDeployment) => void
  onNavigate: (area: AreaId, advanced?: AdvancedId, section?: string) => void
}) {
  const [backups, retryBackups] = useJson<BackupRow[]>(`/api/hosting/${project.id}/backups`, (j) =>
    Array.isArray((j as { backups?: unknown })?.backups) ? (j as { backups: BackupRow[] }).backups : []
  )
  const [usage, retryUsage] = useJson<ResourceCurrent | null>(`/api/hosting/${project.id}/resources?hours=1`, (j) =>
    ((j as { current?: ResourceCurrent | null })?.current ?? null)
  )

  // ── Domain + SSL ─────────────────────────────────────────────────────
  const extraDomains = Math.max(0, (project.websiteDomains?.length ?? 0) - 1)
  let ssl: { text: string; tone: Tone } = { text: 'Checking HTTPS…', tone: 'muted' }
  if (!sslLoading) {
    if (!sslInfo) ssl = { text: 'HTTPS status unavailable', tone: 'muted' }
    else if (!sslInfo.sslEnabled) ssl = { text: 'Not secured: HTTPS is off', tone: 'bad' }
    else {
      const cert = sslInfo.cert
      const days = cert?.daysUntilExpiry
      const status = cert?.status ?? 'issued'
      if (status === 'failed') ssl = { text: 'Certificate could not be issued', tone: 'bad' }
      else if (status === 'pending' || status === 'renewing') ssl = { text: 'Certificate is being issued', tone: 'warn' }
      else if (days != null && days < 0) ssl = { text: `Certificate expired ${-days} days ago`, tone: 'bad' }
      else if (days != null && days < 14) ssl = { text: `Secured · expires in ${days} days`, tone: 'warn' }
      else ssl = { text: cert?.autoRenew === false ? 'Secured with HTTPS' : 'Secured · renews automatically', tone: 'ok' }
    }
  }

  // ── Backups ──────────────────────────────────────────────────────────
  const lastBackup =
    backups.state === 'ready' ? backups.data.find((b) => b.status === 'completed') ?? null : null
  const backupRunning = backups.state === 'ready' && backups.data.some((b) => b.status === 'running' || b.status === 'pending')

  const deployWord = latestDeployment ? DEPLOY_WORDS[latestDeployment.status] ?? { text: latestDeployment.status, tone: 'muted' as Tone } : null

  const tasks: { label: string; hint: string; go: () => void }[] = [
    ...(kind === 'wordpress'
      ? [{ label: 'Plugins, themes and updates', hint: 'Update WordPress, manage plugins and admins', go: () => onNavigate('wordpress') }]
      : kind === 'apptools'
        ? [{ label: 'App tools', hint: 'Run framework commands and tasks', go: () => onNavigate('apptools') }]
        : []),
    { label: 'Edit or upload files', hint: 'File manager and SFTP access', go: () => onNavigate('files') },
    { label: 'Connect a domain', hint: 'Add a domain, HTTPS, redirects', go: () => onNavigate('domains') },
    { label: 'Create an email address', hint: 'Mailboxes on your domain', go: () => onNavigate('email') },
    { label: 'Back up or restore', hint: 'Backups, staging copy, import a site', go: () => onNavigate('backups') },
    { label: 'Manage databases', hint: 'Credentials and database tools', go: () => onNavigate('databases') },
  ]

  return (
    <div className="space-y-6">
      <section aria-labelledby="glance-heading">
        <h3 id="glance-heading" className="sr-only">
          At a glance
        </h3>
        <dl className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 xl:grid-cols-4">
          <Fact label="Domain & HTTPS" action={<FactLink onClick={() => onNavigate('domains')}>Manage domains</FactLink>}>
            {primaryDomain ? (
              <>
                <p className="truncate font-mono text-[13px]" title={primaryDomain}>
                  {primaryDomain}
                </p>
                {sslLoading ? <Skeleton className="h-4 w-40" /> : <p className={TONE_TEXT[ssl.tone]}>{ssl.text}</p>}
              </>
            ) : (
              <>
                <p className="font-medium">{NO_DOMAIN_LABEL}</p>
                <p className="text-muted-foreground">The site is not online until a domain is connected.</p>
                <Button variant="link" className="h-auto p-0 text-sm" onClick={() => onNavigate('domains')}>
                  Connect a domain
                </Button>
              </>
            )}
            {extraDomains > 0 && (
              <p className="text-muted-foreground">
                +{extraDomains} more domain{extraDomains === 1 ? '' : 's'}
              </p>
            )}
          </Fact>

          <Fact
            label="Last deploy"
            action={
              latestDeployment ? (
                <FactLink onClick={() => onViewDeployLog(latestDeployment)}>View log</FactLink>
              ) : (
                <FactLink onClick={() => onNavigate('advanced', 'deployments')}>Deployments</FactLink>
              )
            }
          >
            {latestDeployment && deployWord ? (
              <>
                <p className={cn('font-medium', TONE_TEXT[deployWord.tone])}>{deployWord.text}</p>
                <p className="text-muted-foreground" title={formatDate(latestDeployment.createdAt)}>
                  {timeAgo(latestDeployment.createdAt)}
                  {latestDeployment.triggeredBy ? ` · ${latestDeployment.triggeredBy}` : ''}
                </p>
              </>
            ) : project.lastDeployedAt ? (
              <p className="text-muted-foreground" title={formatDate(project.lastDeployedAt)}>
                Deployed {timeAgo(project.lastDeployedAt)}
              </p>
            ) : (
              <p className="text-muted-foreground">Not deployed yet</p>
            )}
          </Fact>

          <Fact
            label="Last backup"
            action={<FactLink onClick={() => onNavigate('backups')}>{lastBackup ? 'All backups' : 'Back up now'}</FactLink>}
          >
            {backups.state === 'loading' ? (
              <Skeleton className="h-4 w-32" />
            ) : backups.state === 'error' ? (
              <FactError message={backups.message} onRetry={retryBackups} />
            ) : lastBackup ? (
              <>
                <p className="font-medium" title={formatDate(lastBackup.createdAt)}>
                  {timeAgo(lastBackup.createdAt)}
                </p>
                <p className="text-muted-foreground capitalize">{lastBackup.type.replace(/[-_]/g, ' ')} backup</p>
              </>
            ) : (
              <p className={TONE_TEXT.warn}>No backups yet</p>
            )}
            {backupRunning && <p className="text-muted-foreground">A backup is running now</p>}
          </Fact>

          <Fact label="Plan usage" action={<FactLink onClick={() => onNavigate('advanced', 'resources')}>Resource usage</FactLink>}>
            {usage.state === 'loading' ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
              </div>
            ) : usage.state === 'error' ? (
              <FactError message={usage.message} onRetry={retryUsage} />
            ) : usage.data && usage.data.storageGB > 0 ? (
              <div className="space-y-2.5">
                <UsageBar label="Storage" used={usage.data.storageUsedGB} total={usage.data.storageGB} unit="GB" />
                {usage.data.ramMB > 0 && (
                  <UsageBar label="Memory" used={usage.data.ramUsedMB / 1024} total={Math.round((usage.data.ramMB / 1024) * 10) / 10} unit="GB" />
                )}
              </div>
            ) : (
              <p className="text-muted-foreground">No usage measured yet. It appears once the site has been running for a while.</p>
            )}
          </Fact>
        </dl>
      </section>

      <section aria-labelledby="tasks-heading" className="space-y-3">
        <h3 id="tasks-heading" className="text-sm font-semibold">
          Common tasks
        </h3>
        <ul className="grid gap-px overflow-hidden rounded-xl border bg-border md:grid-cols-2">
          {tasks.map((t, i) => (
            <li
              key={t.label}
              className={cn('bg-card', tasks.length % 2 === 1 && i === tasks.length - 1 && 'md:col-span-2')}
            >
              <button
                type="button"
                onClick={t.go}
                className="group flex w-full items-center gap-3 px-4 py-3 text-start hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{t.label}</span>
                  <span className="block text-xs text-muted-foreground">{t.hint}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="details-heading" className="space-y-3">
        <h3 id="details-heading" className="text-sm font-semibold">
          Details
        </h3>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 rounded-xl border bg-card p-4 text-sm sm:grid-cols-2 sm:p-5">
          <DetailRow label="Address">{primaryDomain ?? NO_DOMAIN_LABEL}</DetailRow>
          <DetailRow label="Server">{project.server ? `${project.server.name} · ${project.server.region}` : 'Not assigned yet'}</DetailRow>
          <DetailRow label="Created">{formatDate(project.createdAt)}</DetailRow>
          <DetailRow label="Auto-deploy">
            {project.autoDeploy ? 'On' : 'Off'}{' '}
            <Button variant="link" className="h-auto p-0 text-sm" onClick={() => onNavigate('advanced', 'settings')}>
              Change
            </Button>
          </DetailRow>
          {project.repoUrl && <DetailRow label="Repository">{project.repoUrl}</DetailRow>}
          {project.team && <DetailRow label="Team">{project.team.name}</DetailRow>}
        </dl>
      </section>
    </div>
  )
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-3">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </div>
  )
}
