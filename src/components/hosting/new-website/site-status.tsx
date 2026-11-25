'use client'

/**
 * What the website list shows for a site that is being imported.
 *
 * A site created by an import sits at "creating" (or "stopped" once the
 * runner gives up) until the import finishes, which read as broken. The list
 * now asks GET /api/migrations once (all imports the customer can see,
 * newest first), keeps the latest import per website, and polls only while
 * one is still running.
 */

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { MigrationView } from '../migration-progress'
import { ImportProgress, isMigrationActive } from './import-progress'
import { explainFailure } from './friendly-errors'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export function useLatestImports(refreshKey: unknown) {
  const [byProject, setByProject] = useState<Record<string, MigrationView>>({})

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/migrations?limit=200', { credentials: 'same-origin' })
      if (!res.ok) return
      const data = await res.json()
      const map: Record<string, MigrationView> = {}
      for (const m of (data.migrations ?? []) as MigrationView[]) {
        if (!map[m.projectId]) map[m.projectId] = m // newest first
      }
      setByProject(map)
    } catch {
      // The list still works without import details.
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const anyActive = Object.values(byProject).some((m) => isMigrationActive(m.status))
  useEffect(() => {
    if (!anyActive) return
    const t = setInterval(() => void load(), 6000)
    return () => clearInterval(t)
  }, [anyActive, load])

  return { byProject, reload: load, hasAny: Object.keys(byProject).length > 0 }
}

/**
 * The import that explains this site's state, if any: one still running, or
 * a failed one on a site that never went live.
 */
export function relevantImport(projectStatus: string, m: MigrationView | undefined): MigrationView | null {
  if (!m) return null
  if (isMigrationActive(m.status)) return m
  if ((m.status === 'failed' || m.status === 'cancelled') && projectStatus !== 'running') return m
  return null
}

const PROJECT_STATUS_LABEL: Record<string, string> = {
  running: 'Live',
  live: 'Live',
  stopped: 'Stopped',
  creating: 'Setting up',
  building: 'Building',
  deploying: 'Publishing',
  queued: 'Queued',
  error: 'Needs attention',
  failed: 'Needs attention',
  suspended: 'Suspended',
  deleting: 'Deleting',
}

export function projectStatusLabel(status: string): string {
  return PROJECT_STATUS_LABEL[status] ?? status.charAt(0).toUpperCase() + status.slice(1)
}

/** Status line for a website card that is waiting on, or blocked by, an import. */
export function ImportStatusLine({
  migration,
  onOpen,
}: {
  migration: MigrationView
  onOpen: () => void
}) {
  const active = isMigrationActive(migration.status)
  return (
    <div
      className={cn(
        'mt-3 rounded-md border px-3 py-2 text-xs',
        active ? 'border-primary/25 bg-primary/[0.04]' : 'border-destructive/25 bg-destructive/5'
      )}
    >
      <div className="flex items-center gap-2">
        {active && <Loader2 className="size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden />}
        <span className="min-w-0 flex-1 font-medium">
          {active
            ? 'Waiting for your import to finish'
            : migration.status === 'cancelled'
              ? 'Import cancelled'
              : explainFailure(migration.error, 'import').title}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
          className="shrink-0 rounded font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {active ? 'View progress' : migration.canRetry ? 'Review and retry' : 'View details'}
        </button>
      </div>
      {active && (
        <p className="mt-1 text-muted-foreground">
          {migration.status === 'pending'
            ? 'Starting soon'
            : `${migration.currentStageLabel ?? 'In progress'} · ${migration.progress}%`}
        </p>
      )}
    </div>
  )
}

/** Progress for one import, opened from a website card. */
export function ImportProgressDialog({
  migration,
  onClose,
  onFinished,
}: {
  migration: MigrationView | null
  onClose: () => void
  onFinished: () => void
}) {
  return (
    <Dialog open={migration !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[min(94dvh,880px)] w-[calc(100vw-1rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 pb-4 pt-5 pe-12 text-start sm:px-6">
          <DialogTitle>{migration?.projectName || 'Website import'}</DialogTitle>
          <DialogDescription>Progress, problems and next steps for this import.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          {migration && <ImportProgress migrationId={migration.id} initial={migration} onFinished={onFinished} />}
        </div>
      </DialogContent>
    </Dialog>
  )
}
