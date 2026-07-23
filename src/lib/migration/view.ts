/**
 * API view models for migrations.
 *
 * The database rows carry things the browser must never see (raw source refs
 * that may contain a token, absolute server paths), and things it cannot use
 * (JSON blobs as strings). This module is the single place that converts a row
 * into the shape the dashboard renders, so no route can accidentally leak a
 * field by spreading the record.
 */
import { db } from '@/lib/db'
import { redactUrl } from './extract'
import { MIGRATION_STAGES, type DetectionResult } from './types'
import { formatBytes } from './uploads'

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
  /** True when this stage recorded something rollback would undo. */
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
  detection: DetectionResult | null
  warnings: string[]
  attempts: number
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  durationMs: number | null
  /** Whether the UI should offer Retry / Roll back right now. */
  canRetry: boolean
  canRollback: boolean
  canCancel: boolean
  stages: MigrationStageView[]
}

type MigrationRow = NonNullable<
  Awaited<ReturnType<typeof db.siteMigration.findFirst>>
> & {
  project?: { name: string; slug: string } | null
  stages?: Array<{
    name: string
    label: string
    status: string
    order: number
    log: string | null
    error: string | null
    undo: string | null
    startedAt: Date | null
    finishedAt: Date | null
    durationMs: number | null
  }>
}

export function toMigrationView(row: MigrationRow): MigrationView {
  let detection: DetectionResult | null = null
  try {
    detection = row.detection ? (JSON.parse(row.detection) as DetectionResult) : null
  } catch {
    detection = null
  }

  const stages = (row.stages ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((s) => ({
      name: s.name,
      label: s.label,
      status: s.status,
      order: s.order,
      log: s.log,
      error: s.error,
      startedAt: s.startedAt?.toISOString() ?? null,
      finishedAt: s.finishedAt?.toISOString() ?? null,
      durationMs: s.durationMs,
      reversible: Boolean(s.undo),
    }))

  const terminal = ['completed', 'failed', 'rolled_back', 'cancelled']
  const hasReversible = stages.some((s) => s.reversible && s.status !== 'rolled_back')

  const startedAt = row.startedAt?.getTime() ?? null
  const endedAt = row.completedAt?.getTime() ?? null

  return {
    id: row.id,
    projectId: row.projectId,
    projectName: row.project?.name ?? '',
    projectSlug: row.project?.slug ?? '',
    sourceType: row.sourceType,
    sourceMode: row.sourceMode,
    // Belt and braces: the ref is redacted on write too, but a row created by
    // an older build could still hold credentials in a clone URL.
    sourceRef: row.sourceRef ? redactUrl(row.sourceRef) : null,
    sizeBytes: row.sizeBytes ?? null,
    sizeLabel: row.sizeBytes ? formatBytes(row.sizeBytes) : null,
    originalUrl: row.originalUrl,
    targetUrl: row.targetUrl,
    status: row.status,
    currentStage: row.currentStage,
    currentStageLabel:
      MIGRATION_STAGES.find((s) => s.name === row.currentStage)?.label ?? null,
    progress: row.progress,
    error: row.error,
    detection,
    warnings: detection?.warnings ?? [],
    attempts: row.attempts,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    durationMs: startedAt && endedAt ? endedAt - startedAt : null,
    canRetry:
      ['failed', 'rolled_back', 'cancelled'].includes(row.status) && row.attempts < 5,
    canRollback: terminal.includes(row.status) && row.status !== 'rolled_back' && hasReversible,
    canCancel: !terminal.includes(row.status),
    stages,
  }
}

/**
 * Load a migration the caller is allowed to see.
 *
 * Ownership is enforced through the project, not the migration's `userId`, so
 * a site that changed hands still shows its import history to whoever owns it
 * now. Admins see everything.
 */
export async function loadMigrationFor(
  migrationId: string,
  identity: { userId: string; role: string },
  isAdminRole: boolean
): Promise<MigrationRow | null> {
  const row = await db.siteMigration.findFirst({
    where: isAdminRole
      ? { id: migrationId }
      : { id: migrationId, project: { userId: identity.userId } },
    include: {
      project: { select: { name: true, slug: true } },
      stages: { orderBy: { order: 'asc' } },
    },
  })
  return row as MigrationRow | null
}
