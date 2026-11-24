/**
 * Restart site imports that a panel restart cut off.
 *
 * Imports run as an in-process async task. A restart (deploy, crash, OOM)
 * kills the task, and the row used to sit at "running" until a sweep failed
 * it two hours later with "Retry to start it again" — a customer moving a
 * site had to notice, wait and press Retry, and a deploy during their import
 * silently cost them hours.
 *
 * Called once at server start (src/instrumentation.ts). At that moment no
 * import can be running in this process, so every row still marked
 * pending/detecting/running/verifying was interrupted. Each is reset and run
 * again from the start (the stages are idempotent: files are re-extracted,
 * the database is re-imported) while it has attempts left; the customer gets
 * a notification. Uploaded archives are kept for 48 h, so they are still there.
 */
import { db } from '@/lib/db'

const ACTIVE = ['pending', 'detecting', 'running', 'verifying']

export async function resumeInterruptedMigrations(): Promise<number> {
  const rows = await db.siteMigration
    .findMany({
      where: { status: { in: ACTIVE } },
      select: { id: true, projectId: true, userId: true, sourceMode: true, attempts: true },
      take: 20,
    })
    .catch(() => [])
  if (rows.length === 0) return 0

  const { prepareRetry, runMigration } = await import('./runner')
  const { createNotification } = await import('@/lib/notifications')
  let resumed = 0

  for (const m of rows) {
    // Mark it interrupted first, so prepareRetry (which refuses a running
    // import) can reset it, and so a failure below leaves an honest record.
    await db.siteMigration.update({
      where: { id: m.id },
      data: {
        status: 'failed',
        error: 'The import was interrupted by a server restart.',
        completedAt: new Date(),
      },
    })
    await db.migrationStage
      .updateMany({ where: { migrationId: m.id, status: 'running' }, data: { status: 'failed', error: 'Interrupted by a server restart' } })
      .catch(() => {})

    // A private git import needs the customer's token, which is never stored.
    if (m.sourceMode === 'git') continue

    try {
      await prepareRetry(m.id) // refuses after five attempts
    } catch (err) {
      console.error(`[migration ${m.id}] not resumed:`, err instanceof Error ? err.message : err)
      continue
    }
    resumed++
    console.log(`[migration ${m.id}] resuming after a server restart`)
    void runMigration({
      migrationId: m.id,
      onLog: (line) => console.log(`[migration ${m.id.slice(0, 8)}] ${line}`),
    }).catch(async (err) => {
      console.error(`[migration ${m.id}] resumed run crashed:`, err)
      await db.siteMigration
        .update({
          where: { id: m.id },
          data: {
            status: 'failed',
            error: err instanceof Error ? err.message : 'The import failed.',
            completedAt: new Date(),
          },
        })
        .catch(() => {})
    })
    await createNotification({
      userId: m.userId,
      title: 'Import restarted',
      message:
        'Your site import was interrupted by a server update and has been restarted automatically. You can follow it under Import on your website page.',
      type: 'info',
      link: '/?tab=hosting',
    }).catch(() => {})
  }
  return resumed
}
