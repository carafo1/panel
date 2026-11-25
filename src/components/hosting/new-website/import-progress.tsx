'use client'

/**
 * Import progress, in plain words.
 *
 * The runner reports sixteen technical stages. A customer needs five: getting
 * the backup, checking it, the database, the files, going live. This view
 * groups the stages into those phases, names what is happening now and what
 * comes next, and on failure leads with an explanation and one action. The
 * raw stages, error and log stay one click away under "Technical details".
 *
 * Data: GET /api/migrations/[id] (polled every 4 s while running) plus the
 * realtime room for live log lines. Actions use the existing endpoints:
 * POST /api/migrations/[id]/retry, POST …/rollback, DELETE /api/migrations/[id].
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { ExternalLink, LifeBuoy, Loader2, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import {
  joinMigrationRoom,
  leaveMigrationRoom,
  type MigrationLogData,
  type MigrationStatusData,
} from '@/lib/socket'
import { useAppStore } from '@/store/app-store'
import type { MigrationView } from '../migration-progress'
import { explainFailure } from './friendly-errors'
import { formatDuration } from './format'
import {
  LogBlock,
  OutcomeBanner,
  ProgressTimeline,
  StageList,
  TechnicalDetails,
  type Phase,
  type PhaseStatus,
} from './progress-timeline'

export const ACTIVE_MIGRATION_STATUSES = ['pending', 'detecting', 'running', 'verifying']

export function isMigrationActive(status: string): boolean {
  return ACTIVE_MIGRATION_STATUSES.includes(status)
}

const PHASES: Array<{ id: string; label: string; description: string; stages: string[] }> = [
  {
    id: 'receive',
    label: 'Receiving your backup',
    description: 'Copying your backup to the server that will run your site.',
    stages: ['prepare', 'fetch'],
  },
  {
    id: 'check',
    label: 'Unpacking and checking',
    description: 'Opening the archive and working out what kind of site it is.',
    stages: ['extract', 'detect', 'snapshot'],
  },
  {
    id: 'database',
    label: 'Restoring your database',
    description: 'Creating a database and loading your pages, posts, orders and settings into it.',
    stages: ['create_db', 'import_sql'],
  },
  {
    id: 'files',
    label: 'Placing your files',
    description: 'Copying your files and updating every link to the new address.',
    stages: ['import_files', 'configure', 'rewrite_urls', 'permissions'],
  },
  {
    id: 'live',
    label: 'Going live',
    description: 'Starting your site, connecting its address with HTTPS and checking that it loads.',
    stages: ['deploy', 'proxy_ssl', 'clear_cache', 'verify', 'finalize'],
  },
]

export function importPhases(m: MigrationView): Phase[] {
  const active = isMigrationActive(m.status)
  const byName = new Map(m.stages.map((s) => [s.name, s]))
  const phases: Phase[] = PHASES.map((p) => {
    const stages = p.stages.map((n) => byName.get(n)).filter(Boolean) as MigrationView['stages']
    let status: PhaseStatus = 'pending'
    const holdsCurrent = m.currentStage ? p.stages.includes(m.currentStage) : false
    if (stages.some((s) => s.status === 'failed')) status = 'failed'
    else if (stages.length > 0 && stages.every((s) => s.status === 'skipped')) status = 'skipped'
    else if (stages.length > 0 && stages.every((s) => s.status === 'completed' || s.status === 'skipped'))
      status = 'done'
    else if (active && (stages.some((s) => s.status === 'running') || holdsCurrent)) status = 'running'
    else if (!active && holdsCurrent && m.status === 'failed') status = 'failed'
    return { id: p.id, label: p.label, description: p.description, status }
  })
  // A queued import has no running stage yet: show the first open phase as active.
  if (active && !phases.some((p) => p.status === 'running')) {
    const first = phases.find((p) => p.status === 'pending')
    if (first) first.status = 'running'
  }
  return phases
}

export function ImportProgress({
  migrationId,
  initial,
  onFinished,
  onStartOver,
}: {
  migrationId: string
  initial?: MigrationView | null
  onFinished?: (m: MigrationView) => void
  /** Offered when retrying cannot help (e.g. the file has to be uploaded again). */
  onStartOver?: () => void
}) {
  const setDashboardTab = useAppStore((s) => s.setDashboardTab)
  const [migration, setMigration] = useState<MigrationView | null>(initial ?? null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [liveLog, setLiveLog] = useState<string[]>([])
  const [busy, setBusy] = useState<'retry' | 'rollback' | 'cancel' | null>(null)
  const [confirm, setConfirm] = useState<'rollback' | 'cancel' | null>(null)
  const [gitToken, setGitToken] = useState('')
  const finishedFor = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/migrations/${migrationId}`, { credentials: 'same-origin' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setLoadError(data.error || 'This import could not be loaded.')
        return
      }
      const data = await res.json()
      if (data.migration) {
        setMigration(data.migration as MigrationView)
        setLoadError(null)
      }
    } catch {
      // A dropped poll during a long import is normal; the next one catches up.
    }
  }, [migrationId])

  useEffect(() => {
    void load()
  }, [load])

  const status = migration?.status
  useEffect(() => {
    if (!status || !isMigrationActive(status)) return
    const onLog = (d: MigrationLogData) => {
      if (d.migrationId === migrationId) setLiveLog((prev) => [...prev, d.line].slice(-500))
    }
    const onStatus = (d: MigrationStatusData) => {
      if (d.migrationId !== migrationId) return
      setMigration((prev) => (prev ? { ...prev, status: d.status, progress: d.progress, currentStage: d.stage ?? prev.currentStage } : prev))
      void load()
    }
    joinMigrationRoom(migrationId, onLog, onStatus)
    const poll = setInterval(() => void load(), 4000)
    return () => {
      clearInterval(poll)
      leaveMigrationRoom(migrationId)
    }
  }, [migrationId, status, load])

  useEffect(() => {
    if (!migration || isMigrationActive(migration.status)) return
    const key = `${migration.id}:${migration.status}:${migration.attempts}`
    if (finishedFor.current === key) return
    finishedFor.current = key
    onFinished?.(migration)
  }, [migration, onFinished])

  const act = useCallback(
    async (action: 'retry' | 'rollback' | 'cancel') => {
      if (!migration) return
      setBusy(action)
      try {
        const url =
          action === 'cancel'
            ? `/api/migrations/${migration.id}`
            : `/api/migrations/${migration.id}/${action}`
        const res = await fetch(url, {
          method: action === 'cancel' ? 'DELETE' : 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: action === 'retry' && gitToken.trim() ? JSON.stringify({ gitToken: gitToken.trim() }) : undefined,
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          toast.error(data.error || 'That did not work. Please try again.')
          return
        }
        if (action === 'retry') {
          setLiveLog([])
          toast.success('Import restarted')
        } else if (action === 'rollback') toast.success('The import was undone')
        else toast.success('Import cancelled')
        if (data.migration) setMigration(data.migration as MigrationView)
        void load()
      } catch {
        toast.error('No connection to the server. Check your internet and try again.')
      } finally {
        setBusy(null)
        setConfirm(null)
      }
    },
    [migration, gitToken, load]
  )

  if (!migration) {
    if (loadError) {
      return (
        <OutcomeBanner tone="failed" title="This import could not be loaded">
          <p>{loadError}</p>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </OutcomeBanner>
      )
    }
    return (
      <div className="space-y-3" role="status" aria-label="Loading import">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  const active = isMigrationActive(migration.status)
  const phases = importPhases(migration)
  const name = migration.projectName || 'your website'
  const failedStage = migration.stages.find((s) => s.status === 'failed')
  const rawError = migration.error || failedStage?.error || null
  const explanation = explainFailure(rawError, 'import')

  const logLines =
    liveLog.length > 0
      ? liveLog
      : migration.stages.filter((s) => s.log).flatMap((s) => (s.log as string).split('\n'))

  const support = (
    <Button
      type="button"
      variant="ghost"
      onClick={() => setDashboardTab('support')}
    >
      <LifeBuoy className="me-1.5 size-4" aria-hidden />
      Contact support
    </Button>
  )

  let tone: 'running' | 'success' | 'failed' | 'stopped' = 'running'
  let headline = `Moving ${name}`
  let subline: ReactNode =
    'This runs on our servers. You can close this window — the import keeps going and your website list shows its progress.'
  let banner: ReactNode = null
  let actions: ReactNode = null

  if (migration.status === 'pending') {
    headline = `Getting ready to move ${name}`
  }

  if (active) {
    actions = migration.canCancel ? (
      <Button type="button" variant="ghost" onClick={() => setConfirm('cancel')} disabled={busy !== null}>
        Cancel import
      </Button>
    ) : null
  } else if (migration.status === 'completed') {
    tone = 'success'
    headline = 'Your website has moved'
    // The duration spans every attempt (startedAt is the first), so only show it for a first-time success.
    subline = migration.durationMs && migration.attempts <= 1 ? `Finished in ${formatDuration(migration.durationMs)}.` : undefined
    const wp = migration.detection?.wordpress
    banner = (
      <OutcomeBanner tone="success" title="It is live at its new address">
        {migration.targetUrl && (
          <p>
            <a
              href={migration.targetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground underline underline-offset-2"
            >
              {migration.targetUrl}
            </a>
          </p>
        )}
        {wp && (
          <p>
            We found WordPress{wp.version ? ` ${wp.version}` : ''}
            {wp.pluginCount !== null ? ` with ${wp.pluginCount} plugin${wp.pluginCount === 1 ? '' : 's'}` : ''}
            {migration.originalUrl ? `, and changed links from ${migration.originalUrl} to the new address` : ''}.
          </p>
        )}
        <p>
          Your old site keeps working until you point your domain here. When you are ready, connect your domain
          from the website’s Domains section.
        </p>
      </OutcomeBanner>
    )
    actions = migration.targetUrl ? (
      <Button asChild>
        <a href={migration.targetUrl} target="_blank" rel="noopener noreferrer">
          Visit your site
          <ExternalLink className="ms-1.5 size-4" aria-hidden />
        </a>
      </Button>
    ) : null
  } else if (migration.status === 'failed') {
    tone = 'failed'
    headline = explanation.title
    subline = undefined
    const canRetry = migration.canRetry && explanation.retryHelps
    banner = (
      <OutcomeBanner tone="failed" title="What happened">
        <p>{explanation.body}</p>
        {!migration.canRetry && migration.attempts >= 5 && (
          <p>This import has been tried {migration.attempts} times. Our support team can help from here.</p>
        )}
      </OutcomeBanner>
    )
    actions = (
      <>
        {canRetry || !onStartOver ? support : null}
        {canRetry ? (
          <Button type="button" onClick={() => void act('retry')} disabled={busy !== null}>
            {busy === 'retry' ? (
              <Loader2 className="me-1.5 size-4 animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <RefreshCw className="me-1.5 size-4" aria-hidden />
            )}
            Retry import
          </Button>
        ) : onStartOver ? (
          <>
            {support}
            <Button type="button" onClick={onStartOver}>
              Start a new import
            </Button>
          </>
        ) : null}
      </>
    )
  } else if (migration.status === 'rolled_back') {
    tone = 'stopped'
    headline = 'The import was undone'
    subline = undefined
    banner = (
      <OutcomeBanner tone="stopped" title="Everything it changed has been reversed">
        <p>{rawError ? explanation.body : 'The website is back to how it was before the import.'}</p>
      </OutcomeBanner>
    )
    actions = (
      <>
        {support}
        {migration.canRetry && (
          <Button type="button" onClick={() => void act('retry')} disabled={busy !== null}>
            <RefreshCw className="me-1.5 size-4" aria-hidden />
            Try the import again
          </Button>
        )}
      </>
    )
  } else if (migration.status === 'cancelled') {
    tone = 'stopped'
    headline = 'Import cancelled'
    subline = undefined
    actions = migration.canRetry ? (
      <Button type="button" onClick={() => void act('retry')} disabled={busy !== null}>
        <RefreshCw className="me-1.5 size-4" aria-hidden />
        Start it again
      </Button>
    ) : null
  }

  return (
    <>
      <ProgressTimeline
        tone={tone}
        headline={headline}
        subline={subline}
        percent={migration.progress}
        phases={phases}
        banner={banner}
        actions={
          <>
            {migration.status === 'failed' && migration.sourceMode === 'git' && migration.canRetry && (
              <div className="w-full sm:me-auto sm:w-64">
                <label htmlFor={`${migration.id}-token`} className="sr-only">
                  Access token for a private repository
                </label>
                <Input
                  id={`${migration.id}-token`}
                  type="password"
                  autoComplete="off"
                  placeholder="Access token (private repos only)"
                  value={gitToken}
                  onChange={(e) => setGitToken(e.target.value)}
                />
              </div>
            )}
            {actions}
          </>
        }
      >
        <TechnicalDetails>
          {rawError && (
            <p className="break-words rounded-md bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
              {rawError}
            </p>
          )}
          {migration.warnings.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Things to check</p>
              <ul className="list-disc space-y-1 ps-4 text-xs">
                {migration.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <StageList
            stages={migration.stages.map((s) => ({
              key: s.name,
              label: s.label,
              status: s.status,
              note: s.error,
              duration: formatDuration(s.durationMs),
            }))}
          />
          <LogBlock lines={logLines} label="Log" />
          <p className="text-xs text-muted-foreground">
            Import ID <span className="font-mono">{migration.id}</span>
            {migration.attempts > 1 ? ` · attempt ${migration.attempts}` : ''}
            {migration.sizeLabel ? ` · ${migration.sizeLabel}` : ''}
          </p>
          {migration.canRollback && (
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirm('rollback')} disabled={busy !== null}>
              <RotateCcw className="me-1.5 size-4" aria-hidden />
              Undo this import
            </Button>
          )}
        </TechnicalDetails>
      </ProgressTimeline>

      <AlertDialog open={confirm !== null} onOpenChange={(v) => !v && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === 'rollback' ? 'Undo this import?' : 'Cancel this import?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'rollback'
                ? 'The imported website is removed and what was there before is restored. Anything added to the imported site since — orders, posts, uploads — is lost.'
                : 'The import stops. A step that is already running finishes first; you can undo what was completed from Technical details afterwards. Your uploaded backup is kept, so you can start it again.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{confirm === 'rollback' ? 'Keep the import' : 'Keep importing'}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                if (confirm) void act(confirm)
              }}
            >
              {busy ? <Loader2 className="me-1.5 size-4 animate-spin" aria-hidden /> : null}
              {confirm === 'rollback' ? 'Undo import' : 'Cancel import'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
