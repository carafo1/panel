import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { isAdmin } from '@/lib/security'
import { logAudit } from '@/lib/audit'
import { prepareRetry, runMigration } from '@/lib/migration'
import { loadMigrationFor, toMigrationView } from '@/lib/migration/view'

/**
 * POST /api/migrations/[id]/retry
 *
 * Re-runs a failed import from the beginning, reusing the archive already
 * staged on the panel so the customer does not upload gigabytes twice.
 *
 * A private-repo import needs its token supplied again: tokens are never
 * persisted with the migration, so a retry without one would fail at the
 * clone. The body may carry `{ gitToken }` for that case.
 */

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id } = await params
    const row = await loadMigrationFor(id, decoded, isAdmin(decoded.role))
    if (!row) {
      return NextResponse.json({ error: 'Import not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const gitToken = typeof body?.gitToken === 'string' ? body.gitToken : undefined

    if (row.sourceMode === 'git' && !gitToken) {
      // Not an error — public repositories need nothing. Just make sure the
      // customer is not surprised when a private clone fails again.
      console.log(`[migration ${id}] retrying a git import without a token`)
    }

    // Validate and reset FIRST, awaited. Launching the run and letting its
    // guards reject asynchronously would route "already completed" into the
    // failure handler below, which would overwrite a successful import's
    // record with an error it never had.
    try {
      await prepareRetry(id)
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'This import cannot be retried.' },
        { status: 400 }
      )
    }

    // Only now is the background run safe to start: anything it reports is a
    // genuine failure of this attempt.
    void runMigration({
      migrationId: id,
      gitToken,
      onLog: (line) => console.log(`[migration ${id.slice(0, 8)}] ${line}`),
    }).catch(async (err) => {
      console.error(`[migration ${id}] retry crashed:`, err)
      await db.siteMigration
        .update({
          where: { id },
          data: {
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
            completedAt: new Date(),
          },
        })
        .catch(() => {})
    })

    await logAudit({
      userId: decoded.userId,
      action: 'migration.retry',
      resource: 'migration',
      resourceId: id,
      req: request,
      metadata: { projectId: row.projectId, attempt: row.attempts + 1 },
    })

    // Give the runner a beat to write its first transition so the client's
    // first render shows "running" rather than the stale failed state.
    await new Promise((r) => setTimeout(r, 250))
    const updated = await loadMigrationFor(id, decoded, isAdmin(decoded.role))

    return NextResponse.json({
      ok: true,
      message: 'Import restarted',
      migration: updated ? toMigrationView(updated) : null,
    })
  } catch (error) {
    console.error('Retry migration error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
