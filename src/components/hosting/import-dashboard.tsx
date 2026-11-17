'use client'

/**
 * Import dashboard.
 * ================
 *
 * The overview of every website import: what is running now, what finished,
 * and what needs attention. Selecting a row opens the same live progress view
 * the wizard shows, so there is one place to understand an import regardless
 * of how you arrived at it.
 *
 * Active imports refresh on a short interval. Finished ones do not — a list of
 * completed migrations does not change, and polling it would be free load on
 * the API for every open tab.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  CloudDownload,
  Container,
  Copy,
  FileArchive,
  GitBranch,
  Globe,
  HardDriveDownload,
  Inbox,
  Loader2,
  MinusCircle,
  Package,
  RefreshCw,
  Server,
  Undo2,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import ImportWizard from './import-wizard'
import MigrationProgress, {
  isTerminal,
  statusMeta,
  type MigrationView,
} from './migration-progress'

const SOURCE_ICONS: Record<string, typeof Globe> = {
  'wordpress-zip': Globe,
  wpress: Package,
  duplicator: Copy,
  updraftplus: CloudDownload,
  cpanel: Server,
  'files-sql': FileArchive,
  git: GitBranch,
  docker: Container,
}

const SOURCE_LABELS: Record<string, string> = {
  'wordpress-zip': 'WordPress backup',
  wpress: 'All-in-One WP Migration',
  duplicator: 'Duplicator',
  updraftplus: 'UpdraftPlus',
  cpanel: 'cPanel backup',
  'files-sql': 'Files + database',
  git: 'Git repository',
  docker: 'Docker project',
}

interface Counts {
  total: number
  active: number
  completed: number
  failed: number
  byStatus: Record<string, number>
}

/** The httpOnly session cookie authenticates same-origin requests. */
function authHeaders(): HeadersInit {
  return {}
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

// ─── Row ─────────────────────────────────────────────────────────────────

function MigrationRow({
  migration,
  onOpen,
}: {
  migration: MigrationView
  onOpen: () => void
}) {
  const SourceIcon = SOURCE_ICONS[migration.sourceType] ?? Globe
  const meta = statusMeta(migration.status)
  const StatusIcon = meta.icon
  const running = !isTerminal(migration.status)

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-4 rounded-lg border p-4 text-start transition-colors hover:border-indigo-300 hover:bg-muted/40"
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-lg',
          running
            ? 'bg-indigo-100 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400'
            : migration.status === 'completed'
              ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400'
              : 'bg-muted text-muted-foreground'
        )}
      >
        <SourceIcon className="size-5" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 flex-wrap">
          <span className="truncate font-medium">
            {migration.projectName || 'Website import'}
          </span>
          <Badge variant="outline" className={cn('gap-1 shrink-0', meta.className)}>
            <StatusIcon className={cn('size-3', running && 'animate-spin')} />
            {meta.label}
          </Badge>
        </span>
        <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
          <span>{SOURCE_LABELS[migration.sourceType] ?? migration.sourceType}</span>
          {migration.sizeLabel && (
            <>
              <span aria-hidden>·</span>
              <span>{migration.sizeLabel}</span>
            </>
          )}
          <span aria-hidden>·</span>
          <span className="flex items-center gap-1">
            <Clock className="size-3" />
            {relativeTime(migration.createdAt)}
          </span>
        </span>
        {running && (
          <span className="mt-2 block">
            <Progress value={migration.progress} className="h-1.5" />
            <span className="mt-1 block text-[11px] text-muted-foreground">
              {migration.currentStageLabel ?? 'Starting…'} · {migration.progress}%
            </span>
          </span>
        )}
        {migration.status === 'rolled_back' && migration.error && (
          <span className="mt-1 block truncate text-xs text-amber-600 dark:text-amber-400">
            {migration.error}
          </span>
        )}
        {migration.status === 'failed' && migration.error && (
          <span className="mt-1 block truncate text-xs text-red-600 dark:text-red-400">
            {migration.error}
          </span>
        )}
      </span>

      <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  )
}

// ─── Dashboard ───────────────────────────────────────────────────────────

export interface ImportDashboardProps {
  /** Restrict to one website's imports. */
  projectId?: string
  projectName?: string
  /** Opens the fresh-install wizard from the empty state. */
  onChooseFreshInstall?: () => void
}

export default function ImportDashboard({
  projectId,
  projectName,
  onChooseFreshInstall,
}: ImportDashboardProps) {
  const [migrations, setMigrations] = useState<MigrationView[]>([])
  const [counts, setCounts] = useState<Counts | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)

  const fetchAll = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!opts.silent) setRefreshing(true)
      try {
        const params = new URLSearchParams()
        if (filter !== 'all') params.set('status', filter)
        if (projectId) params.set('projectId', projectId)
        const res = await fetch(`/api/migrations?${params}`, {
          headers: authHeaders(),
        })
        if (!res.ok) {
          if (!opts.silent) toast.error('Could not load imports.')
          return
        }
        const data = await res.json()
        setMigrations((data.migrations ?? []) as MigrationView[])
        setCounts(data.counts as Counts)
      } catch {
        if (!opts.silent) toast.error('Network error while loading imports.')
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [filter, projectId]
  )

  useEffect(() => {
    void fetchAll({ silent: true })
  }, [fetchAll])

  // Poll only while something is actually moving.
  const hasActive = useMemo(
    () => migrations.some((m) => !isTerminal(m.status)),
    [migrations]
  )
  useEffect(() => {
    if (!hasActive || selectedId) return
    const t = setInterval(() => void fetchAll({ silent: true }), 6000)
    return () => clearInterval(t)
  }, [hasActive, selectedId, fetchAll])

  const selected = useMemo(
    () => migrations.find((m) => m.id === selectedId) ?? null,
    [migrations, selectedId]
  )

  // ── Detail view ────────────────────────────────────────────────────
  if (selectedId) {
    return (
      <div className="space-y-4">
        <MigrationProgress
          migrationId={selectedId}
          initial={selected}
          onClose={() => {
            setSelectedId(null)
            void fetchAll({ silent: true })
          }}
          onFinished={() => void fetchAll({ silent: true })}
        />
      </div>
    )
  }

  // ── List view ──────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">
            {projectName ? `Imports for ${projectName}` : 'Website imports'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Move an existing site here from any host, backup, or repository.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchAll()}
            disabled={refreshing}
          >
            <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
          </Button>
          <Button
            onClick={() => setWizardOpen(true)}
            className="bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            <HardDriveDownload className="size-4 me-2" />
            Import a website
          </Button>
        </div>
      </div>

      {/* Counters */}
      {counts && counts.total > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label="Total"
            value={counts.total}
            icon={Inbox}
            className="text-muted-foreground"
          />
          <StatCard
            label="In progress"
            value={counts.active}
            icon={Loader2}
            className="text-indigo-600 dark:text-indigo-400"
            spin={counts.active > 0}
          />
          <StatCard
            label="Completed"
            value={counts.completed}
            icon={CheckCircle2}
            className="text-emerald-600 dark:text-emerald-400"
          />
          <StatCard
            label="Needs attention"
            value={counts.failed}
            icon={XCircle}
            className="text-red-600 dark:text-red-400"
          />
        </div>
      )}

      {/* Filter */}
      {counts && counts.total > 0 && (
        <div className="flex items-center gap-2">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All imports</SelectItem>
              <SelectItem value="running">In progress</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="rolled_back">Rolled back</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      ) : migrations.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-14 text-center">
            <span className="mb-4 flex size-14 items-center justify-center rounded-full bg-indigo-100 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400">
              <HardDriveDownload className="size-7" />
            </span>
            <h3 className="text-lg font-semibold">
              {filter === 'all' ? 'No imports yet' : 'Nothing matches that filter'}
            </h3>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              {filter === 'all'
                ? 'Bring a site over from another host. Upload a backup and we handle the database, the URLs, the certificate, and the checks — you get a working site.'
                : 'Try a different status filter.'}
            </p>
            {filter === 'all' && (
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <Button
                  onClick={() => setWizardOpen(true)}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white"
                >
                  <HardDriveDownload className="size-4 me-2" />
                  Import a website
                </Button>
                {onChooseFreshInstall && (
                  <Button variant="outline" onClick={onChooseFreshInstall}>
                    Start a new site instead
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {migrations.map((m) => (
            <MigrationRow
              key={m.id}
              migration={m}
              onOpen={() => setSelectedId(m.id)}
            />
          ))}
        </div>
      )}

      <ImportWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCompleted={() => void fetchAll({ silent: true })}
        projectId={projectId}
        projectName={projectName}
        onChooseFreshInstall={onChooseFreshInstall}
      />
    </div>
  )
}

function StatCard({
  label,
  value,
  icon: Icon,
  className,
  spin,
}: {
  label: string
  value: number
  icon: typeof Inbox
  className?: string
  spin?: boolean
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <Icon className={cn('size-5 shrink-0', className, spin && 'animate-spin')} />
        <div className="min-w-0">
          <p className="text-xl font-semibold tabular-nums leading-none">{value}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  )
}
