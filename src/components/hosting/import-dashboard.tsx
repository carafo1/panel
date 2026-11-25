'use client'

/**
 * Import history.
 * ==============
 *
 * Every website import the customer can see, newest first. Selecting one
 * opens the same plain-language progress view the New website flow shows
 * (./new-website/import-progress.tsx), so retry, cancel and undo live in one
 * place however you arrive. "Import a website" opens the single New website
 * flow on "Move my existing website" — or, inside a website, straight into
 * "import a backup into this site".
 *
 * Only running imports are polled; a list of finished ones does not change.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ChevronRight, HardDriveDownload, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import ImportWizard from './import-wizard'
import type { MigrationView } from './migration-progress'
import { ImportProgress, isMigrationActive } from './new-website/import-progress'
import { explainFailure } from './new-website/friendly-errors'
import { relativeTime } from './new-website/format'

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

type Filter = 'all' | 'running' | 'attention' | 'completed'

function needsAttention(m: MigrationView) {
  return m.status === 'failed' || m.status === 'rolled_back' || m.status === 'cancelled'
}

function StatusText({ m }: { m: MigrationView }) {
  if (isMigrationActive(m.status)) {
    return (
      <span className="text-primary">
        {m.status === 'pending' ? 'Waiting to start' : `${m.currentStageLabel ?? 'In progress'} · ${m.progress}%`}
      </span>
    )
  }
  if (m.status === 'completed') return <span className="text-emerald-700 dark:text-emerald-400">Moved successfully</span>
  if (m.status === 'failed') return <span className="text-destructive">{explainFailure(m.error, 'import').title}</span>
  if (m.status === 'rolled_back') return <span className="text-amber-700 dark:text-amber-400">Undone</span>
  return <span className="text-muted-foreground">Cancelled</span>
}

function MigrationRow({ m, onOpen }: { m: MigrationView; onOpen: () => void }) {
  const active = isMigrationActive(m.status)
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="group flex w-full items-center gap-4 rounded-lg border bg-card p-4 text-start outline-none transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{m.projectName || 'Website import'}</span>
          <span className="mt-0.5 block text-sm">
            <StatusText m={m} />
          </span>
          {active && <Progress value={m.progress} className="mt-2 h-1.5" aria-label={`${m.projectName} import progress`} />}
          <span className="mt-1.5 block text-xs text-muted-foreground">
            {[SOURCE_LABELS[m.sourceType] ?? m.sourceType, m.sizeLabel, relativeTime(m.createdAt)].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span className="hidden text-sm font-medium text-primary sm:inline">
          {needsAttention(m) && m.canRetry ? 'Review and retry' : 'View'}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden />
      </button>
    </li>
  )
}

export interface ImportDashboardProps {
  /** Restrict to one website's imports (and import into it). */
  projectId?: string
  projectName?: string
  /** Kept for compatibility; the New website flow offers a fresh install itself. */
  onChooseFreshInstall?: () => void
  /** Back to the website list (shown when this is a full page). */
  onBack?: () => void
  /** A website was created by an import started here. */
  onCreated?: () => void
}

export default function ImportDashboard({ projectId, projectName, onBack, onCreated }: ImportDashboardProps) {
  const [migrations, setMigrations] = useState<MigrationView[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)

  const fetchAll = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!opts.silent) setRefreshing(true)
      try {
        const params = new URLSearchParams({ limit: '100' })
        if (projectId) params.set('projectId', projectId)
        const res = await fetch(`/api/migrations?${params}`, { credentials: 'same-origin' })
        if (!res.ok) {
          setLoadError('Your imports could not be loaded.')
          return
        }
        const data = await res.json()
        setMigrations((data.migrations ?? []) as MigrationView[])
        setLoadError(null)
      } catch {
        setLoadError('No connection to the server.')
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [projectId]
  )

  useEffect(() => {
    void fetchAll({ silent: true })
  }, [fetchAll])

  const hasActive = useMemo(() => migrations.some((m) => isMigrationActive(m.status)), [migrations])
  useEffect(() => {
    if (!hasActive || selectedId) return
    const t = setInterval(() => void fetchAll({ silent: true }), 6000)
    return () => clearInterval(t)
  }, [hasActive, selectedId, fetchAll])

  const counts = useMemo(
    () => ({
      all: migrations.length,
      running: migrations.filter((m) => isMigrationActive(m.status)).length,
      attention: migrations.filter(needsAttention).length,
      completed: migrations.filter((m) => m.status === 'completed').length,
    }),
    [migrations]
  )
  const visible = migrations.filter((m) =>
    filter === 'all'
      ? true
      : filter === 'running'
        ? isMigrationActive(m.status)
        : filter === 'attention'
          ? needsAttention(m)
          : m.status === 'completed'
  )
  const selected = migrations.find((m) => m.id === selectedId) ?? null

  const wizard = (
    <ImportWizard
      open={wizardOpen}
      onClose={() => {
        setWizardOpen(false)
        void fetchAll({ silent: true })
      }}
      onCompleted={() => void fetchAll({ silent: true })}
      onCreated={() => {
        onCreated?.()
        void fetchAll({ silent: true })
      }}
      projectId={projectId}
      projectName={projectName}
    />
  )

  if (selectedId) {
    return (
      <div className="space-y-4">
        <Button
          variant="ghost"
          size="sm"
          className="-ms-2"
          onClick={() => {
            setSelectedId(null)
            void fetchAll({ silent: true })
          }}
        >
          <ArrowLeft className="me-1.5 size-4" aria-hidden />
          All imports
        </Button>
        <ImportProgress
          migrationId={selectedId}
          initial={selected}
          onFinished={() => void fetchAll({ silent: true })}
          onStartOver={() => setWizardOpen(true)}
        />
        {wizard}
      </div>
    )
  }

  const filters: Array<[Filter, string]> = [
    ['all', 'All'],
    ['running', 'In progress'],
    ['attention', 'Needs attention'],
    ['completed', 'Moved'],
  ]

  return (
    <div className="space-y-5">
      {onBack && (
        <Button variant="ghost" size="sm" className="-ms-2" onClick={onBack}>
          <ArrowLeft className="me-1.5 size-4" aria-hidden />
          Websites
        </Button>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold">{projectName ? 'Import a backup' : 'Website imports'}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {projectName
              ? `Replace ${projectName} with a backup from another host. A snapshot is taken first, so it can be undone.`
              : 'Sites you are moving here from another host.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => void fetchAll()}
            disabled={refreshing}
            aria-label="Refresh imports"
          >
            <RefreshCw className={cn('size-4', refreshing && 'animate-spin motion-reduce:animate-none')} aria-hidden />
          </Button>
          <Button onClick={() => setWizardOpen(true)}>
            <HardDriveDownload className="me-2 size-4" aria-hidden />
            {projectName ? 'Import a backup' : 'Import a website'}
          </Button>
        </div>
      </div>

      {counts.all > 0 && (
        <div role="group" aria-label="Filter imports" className="flex flex-wrap gap-1.5">
          {filters.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
              className={cn(
                'rounded-full border px-3 py-1 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                filter === id ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted'
              )}
            >
              {label} <span className="tabular-nums opacity-70">{counts[id]}</span>
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="space-y-2" role="status" aria-label="Loading imports">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      ) : loadError ? (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <p className="font-medium">{loadError}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => void fetchAll()}>
            Try again
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-lg border border-dashed px-6 py-10 text-center">
          <p className="font-medium">{counts.all === 0 ? 'No imports yet' : 'Nothing here'}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {counts.all === 0
              ? 'Upload a backup from your old host and we restore the files, the database, the links and HTTPS for you.'
              : 'No imports match this filter.'}
          </p>
          {counts.all === 0 && (
            <Button className="mt-4" onClick={() => setWizardOpen(true)}>
              <HardDriveDownload className="me-2 size-4" aria-hidden />
              {projectName ? 'Import a backup' : 'Import a website'}
            </Button>
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((m) => (
            <MigrationRow key={m.id} m={m} onOpen={() => setSelectedId(m.id)} />
          ))}
        </ul>
      )}

      {wizard}
    </div>
  )
}
