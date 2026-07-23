import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdminRole } from '@/lib/auth'
import { recordHeartbeat } from '@/lib/health'
import { sweepStaleUploads } from '@/lib/migration'

/**
 * Housekeeping for the import subsystem.
 *
 * Two jobs, both of which only matter because migrations deal in very large
 * files and very long runs:
 *
 *  1. **Reap abandoned uploads.** Staged backups live on the panel's own disk
 *     and are routinely several gigabytes. A customer who uploads and then
 *     closes the tab leaves that behind forever; a handful of those fills the
 *     volume and takes the whole panel down, not just imports.
 *
 *  2. **Fail orphaned runs.** A migration is driven by an in-process async
 *     function. If the panel restarts mid-import — a deploy, an OOM — nothing
 *     resumes it, and the row sits at "running, 45%" indefinitely while the
 *     dashboard spins. Marking it failed after a generous idle window turns a
 *     permanent lie into something the customer can actually retry.
 *
 * Called on a worker tick, or by an admin.
 */

const CRON_API_KEY =
  process.env.CRON_API_KEY &&
  !/^deployhub-cron-key$|^replace-with/.test(process.env.CRON_API_KEY)
    ? process.env.CRON_API_KEY
    : null

async function authorise(request: Request): Promise<boolean> {
  const key = request.headers.get('x-cron-key')
  if (CRON_API_KEY && key && key === CRON_API_KEY) return true
  return Boolean(await requireAdminRole(request))
}

/**
 * How long a migration may go without a database write before it is presumed
 * dead. Generous on purpose: transferring and extracting a 20 GB backup can
 * legitimately spend a long time inside one stage, and killing a healthy
 * import would be far worse than leaving a dead one visible a while longer.
 */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000 // 2 hours

export async function POST(request: Request) {
  try {
    if (!(await authorise(request))) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 403 })
    }

    const uploadsRemoved = await sweepStaleUploads(48).catch((err) => {
      console.error('[migration-sweep] upload sweep failed:', err)
      return 0
    })

    const cutoff = new Date(Date.now() - STALE_AFTER_MS)
    const orphaned = await db.siteMigration.findMany({
      where: {
        status: { in: ['pending', 'detecting', 'running', 'verifying'] },
        updatedAt: { lt: cutoff },
      },
      select: { id: true, projectId: true, currentStage: true },
    })

    for (const m of orphaned) {
      await db.siteMigration
        .update({
          where: { id: m.id },
          data: {
            status: 'failed',
            error:
              'The import stopped unexpectedly — the server restarted while it was running. Retry to start it again.',
            completedAt: new Date(),
          },
        })
        .catch(() => {})
      await db.migrationStage
        .updateMany({
          where: { migrationId: m.id, status: 'running' },
          data: { status: 'failed', error: 'Interrupted by a server restart' },
        })
        .catch(() => {})
    }

    if (orphaned.length > 0) {
      console.log(
        `[migration-sweep] failed ${orphaned.length} orphaned import(s):`,
        orphaned.map((m) => `${m.id}@${m.currentStage ?? '?'}`).join(', ')
      )
    }

    await recordHeartbeat(
      'migrations',
      `uploads_removed=${uploadsRemoved} orphans_failed=${orphaned.length}`
    )

    return NextResponse.json({
      success: true,
      uploadsRemoved,
      orphansFailed: orphaned.length,
    })
  } catch (error) {
    console.error('[migration-sweep] failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
