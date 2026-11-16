'use client'

/**
 * Live import progress.
 * ====================
 *
 * Renders one migration: its overall bar, the stage checklist, the streaming
 * log, and the recovery controls (retry / roll back / cancel).
 *
 * Shared by the import wizard's final step and the import dashboard's detail
 * pane, so the customer sees exactly the same view whether they stayed on the
 * page through the import or came back to it an hour later.
 *
 * Updates arrive over the realtime socket and are backstopped by a poll. Both
 * exist on purpose: the socket makes a 40-second stage feel alive, and the
 * poll means a customer behind a proxy that eats websockets still sees their
 * import finish.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  Copy,
  ExternalLink,
  Loader2,
  MinusCircle,
  RefreshCw,
  RotateCcw,
  Terminal,
  Undo2,
  X,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { cn } from '@/lib/utils'
import {
  joinMigrationRoom,
  leaveMigrationRoom,
  type MigrationLogData,
  type MigrationStatusData,
} from '@/lib/socket'

// ─── Types (mirrors src/lib/migration/view.ts) ───────────────────────────

export interface MigrationStageView {
  name: string
  label: string
  status: string
  order: number
  log: string | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  reversible: boolean
}

export interface MigrationView {
  id: string
  projectId: string
  projectName: string
  projectSlug: string
  sourceType: string
  sourceMode: string
  sourceRef: string | null
  sizeBytes: number | null
  sizeLabel: string | null
  originalUrl: string | null
  targetUrl: string | null
  status: string
  currentStage: string | null
  currentStageLabel: string | null
  progress: number
  error: string | null
  detection: DetectionView | null
  warnings: string[]
  attempts: number
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  durationMs: number | null
  canRetry: boolean
  canRollback: boolean
  canCancel: boolean
  stages: MigrationStageView[]
}

export interface DetectionView {
  stack: string
  rootDir: string
  documentRoot: string | null
  sqlFiles: string[]
  sizeBytes: number | null
  fileCount: number | null
  warnings: string[]
  hasDockerfile?: boolean
  hasCompose?: boolean
  wordpress?: {
    version: string | null
    tablePrefix: string
    siteUrl: string | null
    homeUrl: string | null
    hasWpContent: boolean
    pluginCount: number | null
    themeCount: number | null
    isMultisite: boolean
    cachePlugins: string[]
  }
}

// ─── Status presentation ─────────────────────────────────────────────────

const TERMINAL = ['completed', 'failed', 'rolled_back', 'cancelled']

export function isTerminal(status: string): boolean {
  return TERMINAL.includes(status)
}

export function statusMeta(status: string): {
  label: string
  className: string
  icon: typeof CheckCircle2
} {
  switch (status) {
    case 'completed':
      return {
        label: 'Completed',
        className:
          'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900',
        icon: CheckCircle2,
      }
    case 'failed':
      return {
        label: 'Failed',
        className:
          'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400 border-red-200 dark:border-red-900',
        icon: XCircle,
      }
    case 'rolled_back':
      return {
        label: 'Rolled back',
        className:
          'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400 border-amber-200 dark:border-amber-900',
        icon: Undo2,
      }
    case 'cancelled':
      return {
        label: 'Cancelled',
        className:
          'bg-muted text-muted-foreground border-border',
        icon: MinusCircle,
      }
    default:
      return {
        label: 'Running',
        className:
          'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-400 border-indigo-200 dark:border-indigo-900',
        icon: Loader2,
      }
  }
}

function formatDuration(ms: number | null): string {
  if (!ms || ms < 0) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

/** The httpOnly session cookie authenticates same-origin requests. */
function authHeaders(): HeadersInit {
  return { 'Content-Type': 'application/json' }
}

// ─── Stage row ───────────────────────────────────────────────────────────

function StageRow({
  stage,
  isCurrent,
}: {
  stage: MigrationStageView
  isCurrent: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const hasDetail = Boolean(stage.log || stage.error)

  const icon =
    stage.status === 'completed' ? (
      <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500 text-white shrink-0">
        <Check className="size-3" strokeWidth={3} />
      </span>
    ) : stage.status === 'running' ? (
      <span className="flex size-5 items-center justify-center rounded-full bg-indigo-600 text-white shrink-0">
        <Loader2 className="size-3 animate-spin" />
      </span>
    ) : stage.status === 'failed' ? (
      <span className="flex size-5 items-center justify-center rounded-full bg-red-500 text-white shrink-0">
        <X className="size-3" strokeWidth={3} />
      </span>
    ) : stage.status === 'rolled_back' ? (
      <span className="flex size-5 items-center justify-center rounded-full bg-amber-500 text-white shrink-0">
        <Undo2 className="size-3" strokeWidth={3} />
      </span>
    ) : stage.status === 'skipped' ? (
      <span className="flex size-5 items-center justify-center rounded-full border-2 border-dashed border-muted-foreground/40 shrink-0" />
    ) : (
      <span className="flex size-5 items-center justify-center rounded-full border-2 border-muted-foreground/25 shrink-0" />
    )

  return (
    <li
      className={cn(
        'rounded-lg border transition-colors',
        isCurrent
          ? 'border-indigo-300 bg-indigo-50/60 dark:border-indigo-800 dark:bg-indigo-950/30'
          : stage.status === 'failed'
            ? 'border-red-200 bg-red-50/50 dark:border-red-900 dark:bg-red-950/20'
            : 'border-transparent'
      )}
    >
      <button
        type="button"
        onClick={() => hasDetail && setExpanded((v) => !v)}
        disabled={!hasDetail}
        className={cn(
          'flex w-full items-center gap-3 px-2 py-2 text-left',
          hasDetail && 'cursor-pointer hover:bg-muted/50 rounded-lg'
        )}
      >
        {icon}
        <span
          className={cn(
            'flex-1 text-sm truncate',
            stage.status === 'pending' && 'text-muted-foreground',
            stage.status === 'skipped' && 'text-muted-foreground line-through',
            stage.status === 'running' && 'font-medium'
          )}
        >
          {stage.label}
        </span>
        {stage.status === 'skipped' && (
          <span className="text-[11px] text-muted-foreground shrink-0">skipped</span>
        )}
        {stage.durationMs !== null && stage.status !== 'skipped' && (
          <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
            {formatDuration(stage.durationMs)}
          </span>
        )}
        {hasDetail &&
          (expanded ? (
            <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
          ))}
      </button>

      {expanded && hasDetail && (
        <div className="px-2 pb-2">
          {stage.error && (
            <p className="mb-2 rounded-md bg-red-100 dark:bg-red-950/50 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {stage.error}
            </p>
          )}
          {stage.log && (
            <pre className="max-h-48 overflow-auto rounded-md bg-zinc-950 px-3 py-2 text-[11px] leading-relaxed text-zinc-300 font-mono whitespace-pre-wrap break-all">
              {stage.log}
            </pre>
          )}
        </div>
      )}
    </li>
  )
}

// ─── Detection summary ───────────────────────────────────────────────────

function DetectionSummary({ detection }: { detection: DetectionView }) {
  const wp = detection.wordpress
  const facts: Array<[string, string]> = [
    ['Type', wp ? `WordPress ${wp.version ?? ''}`.trim() : detection.stack],
  ]
  if (detection.fileCount) facts.push(['Files', detection.fileCount.toLocaleString()])
  if (detection.sqlFiles.length > 0) {
    facts.push(['Database', `${detection.sqlFiles.length} dump found`])
  }
  if (wp) {
    facts.push(['Table prefix', wp.tablePrefix])
    if (wp.pluginCount !== null) facts.push(['Plugins', String(wp.pluginCount)])
    if (wp.themeCount !== null) facts.push(['Themes', String(wp.themeCount)])
    if (wp.siteUrl) facts.push(['Original URL', wp.siteUrl])
  }

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
      {facts.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{k}</p>
          <p className="text-sm font-medium truncate" title={v}>
            {v}
          </p>
        </div>
      ))}
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────

export interface MigrationProgressProps {
  migrationId: string
  /** Seed data so the first paint is not a spinner. */
  initial?: MigrationView | null
  /** Called whenever the status reaches a terminal state. */
  onFinished?: (migration: MigrationView) => void
  /** Shown as a back/close affordance when provided. */
  onClose?: () => void
  /** Compact mode drops the log pane — used in list rows. */
  compact?: boolean
}

export default function MigrationProgress({
  migrationId,
  initial = null,
  onFinished,
  onClose,
  compact = false,
}: MigrationProgressProps) {
  const [migration, setMigration] = useState<MigrationView | null>(initial)
  const [liveLog, setLiveLog] = useState<string[]>([])
  const [loading, setLoading] = useState(!initial)
  const [busy, setBusy] = useState<'retry' | 'rollback' | 'cancel' | null>(null)
  const [rollbackConfirm, setRollbackConfirm] = useState(false)
  const [showLog, setShowLog] = useState(!compact)

  const logEndRef = useRef<HTMLDivElement | null>(null)
  const finishedRef = useRef(false)

  // ── Fetch ──────────────────────────────────────────────────────────
  const fetchMigration = useCallback(async () => {
    try {
      const res = await fetch(`/api/migrations/${migrationId}`, {
        headers: authHeaders(),
      })
      if (!res.ok) return
      const data = await res.json()
      if (data.migration) setMigration(data.migration as MigrationView)
    } catch {
      // Transient network errors are expected during a long import; the next
      // poll picks it up.
    } finally {
      setLoading(false)
    }
  }, [migrationId])

  useEffect(() => {
    void fetchMigration()
  }, [fetchMigration])

  // ── Realtime + poll ────────────────────────────────────────────────
  useEffect(() => {
    if (migration && isTerminal(migration.status)) return

    const onLog = (data: MigrationLogData) => {
      if (data.migrationId !== migrationId) return
      // Cap the buffer: a large import emits thousands of lines and an
      // unbounded array in React state degrades the whole page.
      setLiveLog((prev) => [...prev, data.line].slice(-500))
    }
    const onStatus = (data: MigrationStatusData) => {
      if (data.migrationId !== migrationId) return
      setMigration((prev) =>
        prev
          ? {
              ...prev,
              status: data.status,
              progress: data.progress,
              currentStage: data.stage ?? prev.currentStage,
            }
          : prev
      )
      // A stage transition changes the checklist, which the socket payload
      // does not carry — refetch for the authoritative shape.
      void fetchMigration()
    }

    joinMigrationRoom(migrationId, onLog, onStatus)
    const poll = setInterval(() => void fetchMigration(), 5000)

    return () => {
      leaveMigrationRoom(migrationId)
      clearInterval(poll)
    }
  }, [migrationId, migration?.status, fetchMigration])

  // ── Terminal notification ──────────────────────────────────────────
  useEffect(() => {
    if (!migration || finishedRef.current) return
    if (!isTerminal(migration.status)) return
    finishedRef.current = true
    onFinished?.(migration)
  }, [migration, onFinished])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [liveLog])

  // ── Actions ────────────────────────────────────────────────────────
  const runAction = useCallback(
    async (
      action: 'retry' | 'rollback' | 'cancel',
      url: string,
      method: 'POST' | 'DELETE'
    ) => {
      setBusy(action)
      try {
        const res = await fetch(url, { method, headers: authHeaders() })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          toast.error(data.error || `Could not ${action} this import.`)
          return
        }
        toast.success(data.message || `Import ${action} succeeded.`)
        if (data.migration) setMigration(data.migration as MigrationView)
        if (action === 'retry') {
          setLiveLog([])
          finishedRef.current = false
        }
        void fetchMigration()
      } catch {
        toast.error('Network error — please try again.')
      } finally {
        setBusy(null)
      }
    },
    [fetchMigration]
  )

  // ── Render ─────────────────────────────────────────────────────────
  if (loading || !migration) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="size-5 animate-spin mr-2" />
        Loading import…
      </div>
    )
  }

  const meta = statusMeta(migration.status)
  const StatusIcon = meta.icon
  const done = isTerminal(migration.status)
  const succeeded = migration.status === 'completed'

  // Fall back to the persisted per-stage logs when the socket delivered
  // nothing — a customer returning to a finished import still sees the trail.
  const logLines =
    liveLog.length > 0
      ? liveLog
      : migration.stages
          .filter((s) => s.log)
          .flatMap((s) => (s.log as string).split('\n'))

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {onClose && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                className="h-7 px-2 -ml-2"
              >
                <ArrowLeft className="size-4" />
              </Button>
            )}
            <h3 className="text-lg font-semibold truncate">
              {migration.projectName || 'Website import'}
            </h3>
            <Badge variant="outline" className={cn('gap-1', meta.className)}>
              <StatusIcon
                className={cn('size-3', !done && 'animate-spin')}
              />
              {meta.label}
            </Badge>
            {migration.attempts > 1 && (
              <Badge variant="outline" className="text-[11px]">
                Attempt {migration.attempts}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {done
              ? succeeded
                ? `Imported in ${formatDuration(migration.durationMs)}`
                : migration.currentStageLabel
                  ? `Stopped at: ${migration.currentStageLabel}`
                  : meta.label
              : migration.currentStageLabel || 'Starting…'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {succeeded && migration.targetUrl && (
            <Button asChild size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-white">
              <a href={migration.targetUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4 mr-1.5" />
                Visit site
              </a>
            </Button>
          )}
          {migration.canCancel && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                runAction('cancel', `/api/migrations/${migration.id}`, 'DELETE')
              }
            >
              {busy === 'cancel' ? (
                <Loader2 className="size-4 mr-1.5 animate-spin" />
              ) : (
                <X className="size-4 mr-1.5" />
              )}
              Cancel
            </Button>
          )}
          {migration.canRetry && (
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                runAction('retry', `/api/migrations/${migration.id}/retry`, 'POST')
              }
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              {busy === 'retry' ? (
                <Loader2 className="size-4 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="size-4 mr-1.5" />
              )}
              Retry import
            </Button>
          )}
          {migration.canRollback && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => setRollbackConfirm(true)}
            >
              {busy === 'rollback' ? (
                <Loader2 className="size-4 mr-1.5 animate-spin" />
              ) : (
                <RotateCcw className="size-4 mr-1.5" />
              )}
              Roll back
            </Button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">
            {migration.stages.filter((s) => s.status === 'completed').length} of{' '}
            {migration.stages.length} steps complete
          </span>
          <span className="font-medium tabular-nums">{migration.progress}%</span>
        </div>
        <Progress
          value={migration.progress}
          className={cn(
            'h-2',
            migration.status === 'failed' && '[&>div]:bg-red-500',
            migration.status === 'rolled_back' && '[&>div]:bg-amber-500',
            succeeded && '[&>div]:bg-emerald-500'
          )}
        />
      </div>

      {/* Error banner */}
      {migration.error && (
        <div className="flex gap-3 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/40">
          <XCircle className="size-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-red-900 dark:text-red-200">
              {migration.status === 'rolled_back'
                ? 'Import failed and was rolled back'
                : 'Import failed'}
            </p>
            <p className="text-sm text-red-700 dark:text-red-300 break-words">
              {migration.error}
            </p>
            {migration.status === 'rolled_back' && (
              <p className="text-xs text-red-700/80 dark:text-red-300/80">
                Everything this import changed has been undone — your account is
                back exactly as it was.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Warnings */}
      {migration.warnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
          <p className="flex items-center gap-2 text-sm font-medium text-amber-900 dark:text-amber-200">
            <AlertTriangle className="size-4 shrink-0" />
            {migration.warnings.length} thing
            {migration.warnings.length !== 1 ? 's' : ''} to review
          </p>
          <ul className="mt-2 space-y-1.5">
            {migration.warnings.map((w, i) => (
              <li
                key={i}
                className="flex gap-2 text-xs text-amber-800 dark:text-amber-300"
              >
                <CircleAlert className="size-3.5 mt-0.5 shrink-0" />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* What we found */}
      {migration.detection && (
        <Card className="border-muted">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">What we found in your backup</CardTitle>
          </CardHeader>
          <CardContent>
            <DetectionSummary detection={migration.detection} />
            {migration.originalUrl && migration.targetUrl && (
              <>
                <Separator className="my-3" />
                <div className="flex items-center gap-2 text-xs flex-wrap">
                  <span className="text-muted-foreground">URLs rewritten:</span>
                  <code className="rounded bg-muted px-1.5 py-0.5">
                    {migration.originalUrl}
                  </code>
                  <ChevronRight className="size-3 text-muted-foreground" />
                  <code className="rounded bg-muted px-1.5 py-0.5">
                    {migration.targetUrl}
                  </code>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Stage checklist */}
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Steps
        </p>
        <ul className="space-y-0.5">
          {migration.stages.map((s) => (
            <StageRow
              key={s.name}
              stage={s}
              isCurrent={!done && s.name === migration.currentStage}
            />
          ))}
        </ul>
      </div>

      {/* Log */}
      {!compact && (
        <div>
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
          >
            {showLog ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            <Terminal className="size-3.5" />
            Detailed log
            {logLines.length > 0 && (
              <span className="normal-case tracking-normal">
                ({logLines.length} lines)
              </span>
            )}
          </button>

          {showLog && (
            <div className="relative">
              <Button
                variant="ghost"
                size="sm"
                className="absolute right-2 top-2 z-10 h-7 px-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
                onClick={() => {
                  void navigator.clipboard.writeText(logLines.join('\n'))
                  toast.success('Log copied')
                }}
              >
                <Copy className="size-3.5" />
              </Button>
              <ScrollArea className="h-64 rounded-lg bg-zinc-950">
                <div className="p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
                  {logLines.length === 0 ? (
                    <p className="text-zinc-500">Waiting for output…</p>
                  ) : (
                    logLines.map((line, i) => (
                      <div
                        key={i}
                        className={cn(
                          'whitespace-pre-wrap break-all',
                          /FAILED|ERROR/i.test(line) && 'text-red-400',
                          /Warning/i.test(line) && 'text-amber-400',
                          /^\[\d/.test(line) && 'text-zinc-400'
                        )}
                      >
                        {line}
                      </div>
                    ))
                  )}
                  <div ref={logEndRef} />
                </div>
              </ScrollArea>
            </div>
          )}
        </div>
      )}

      {/* Success footer */}
      {succeeded && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/40">
          <p className="flex items-center gap-2 font-medium text-emerald-900 dark:text-emerald-200">
            <CheckCircle2 className="size-5" />
            Your website is live
          </p>
          <p className="mt-1 text-sm text-emerald-800 dark:text-emerald-300">
            It is serving at{' '}
            <a
              href={migration.targetUrl ?? '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 font-medium"
            >
              {migration.targetUrl}
            </a>
            . The HTTPS certificate is issued automatically on the first visit.
          </p>
          <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">
            Point your domain&apos;s DNS at this server when you are ready to cut
            over — your old site keeps serving until you do.
          </p>
        </div>
      )}

      {/* Rollback confirmation */}
      <AlertDialog open={rollbackConfirm} onOpenChange={setRollbackConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <RotateCcw className="size-5 text-amber-500" />
              Roll back this import?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  The imported website will be removed and whatever was in this
                  project before the import will be restored.
                </p>
                <p className="font-medium text-foreground">
                  Anything created on the imported site since it went live —
                  orders, posts, uploads — will be lost.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the import</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 hover:bg-amber-700 text-white"
              onClick={() =>
                runAction('rollback', `/api/migrations/${migration.id}/rollback`, 'POST')
              }
            >
              Roll back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
