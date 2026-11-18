/**
 * Background job worker.
 *
 * Used by:
 *  - #5 Background Job Worker
 *
 * Polls the JobQueue table for queued jobs and processes them using the
 * automation engine. Designed to be invoked from:
 *   - A cron-style API route (/api/cron/worker)
 *   - A long-running mini-service (mini-services/worker)
 *
 * NOTE: In Next.js there is no always-on background process by default, so
 * callers must trigger this on an interval (see {@link scheduleJobProcessing}).
 */
import { db } from '@/lib/db'
import { processJob as automationProcessJob } from '@/lib/automation'

interface JobRecord {
  id: string
  type: string
  payload: string
  status: string
  attempts: number
  maxAttempts: number
  runAt: Date
}

interface ProcessResult {
  processed: number
  succeeded: number
  failed: number
}

/**
 * Process a single job. Delegates to lib/automation.ts processJob (which
 * expects a job id) and updates the JobQueue row accordingly.
 */
export async function processJob(job: JobRecord): Promise<void> {
   
  console.log(`[worker] Processing job ${job.id} (type=${job.type})`)
  try {
    // The automation engine records every handler outcome itself (completed,
    // re-queued or failed). It only throws on an infrastructure error such as
    // the database being unavailable while recording that outcome.
    await automationProcessJob(job.id, { enforceMaxAttempts: true })

    console.log(`[worker] Job ${job.id} processed via automation engine`)
  } catch (error) {
    // Do NOT mark the job failed here. This used to overwrite the row by id
    // unconditionally, which could fail a job whose handler had succeeded or
    // that another tick had re-claimed. A row left 'processing' is handled by
    // recoverStuckJobs (re-queued, or failed once its attempts are used up).
    console.error(
      `[worker] Job ${job.id} hit an infrastructure error; left for stuck-job recovery:`,
      error instanceof Error ? error.message : error
    )
  }
}

/**
 * Process up to `limit` pending jobs. Returns aggregate counts.
 */
export async function processPendingJobs(limit = 10): Promise<ProcessResult> {
  // Jobs left 'processing' by a restart were stranded forever; nothing called
  // this. Ten minutes comfortably exceeds any single action's run time.
  await recoverStuckJobs(10 * 60 * 1000).catch((err) =>
    console.error('[worker] stuck-job recovery failed:', err)
  )

  // Provisioning pipelines run in-process; one interrupted by a restart
  // stayed 'running' forever and blocked any re-run. Loaded lazily so the
  // job tick does not pull in the registrar/mail/VPS clients until needed.
  await import('@/lib/orchestration')
    .then((m) => m.failStaleProvisioningJobs())
    .catch((err) => console.error('[worker] stale provisioning sweep failed:', err))

  // 'failed' is terminal (attempts exhausted); the claim in processJob
  // re-checks status and attempts, so a row taken by another tick is skipped
  // safely. Exhausted rows are excluded so they cannot fill the batch.
  const pendingJobs = await db.jobQueue.findMany({
    where: {
      status: 'queued',
      runAt: { lte: new Date() },
      attempts: { lt: db.jobQueue.fields.maxAttempts },
    },
    orderBy: { runAt: 'asc' },
    take: Math.max(1, Math.min(limit, 100)),
  })

  let processed = 0
  let succeeded = 0
  let failed = 0

  for (const job of pendingJobs) {
    processed++
    const beforeStatus = job.status
    await processJob(job)

    // Re-fetch the job to determine the outcome
    const updated = await db.jobQueue.findUnique({
      where: { id: job.id },
      select: { status: true },
    })
    const newStatus = updated?.status || 'unknown'

    if (newStatus === 'completed') {
      succeeded++
    } else if (newStatus === 'failed' && beforeStatus !== 'failed') {
      failed++
    }
  }

   
  console.log(
    `[worker] Batch complete: processed=${processed} succeeded=${succeeded} failed=${failed}`
  )

  return { processed, succeeded, failed }
}

/**
 * Schedule recurring processing of pending jobs using setInterval.
 * Returns the timer so callers can clear it on shutdown.
 *
 * Example (in a long-running service):
 *   const timer = scheduleJobProcessing(30_000) // every 30s
 *   process.on('SIGTERM', () => clearInterval(timer))
 */
export function scheduleJobProcessing(intervalMs = 30_000): NodeJS.Timeout {
   
  console.log(`[worker] Scheduling job processing every ${intervalMs}ms`)
  return setInterval(async () => {
    try {
      await processPendingJobs()
    } catch (error) {
       
      console.error(
        '[worker] Scheduled processing error:',
        error instanceof Error ? error.message : error
      )
    }
  }, intervalMs)
}

/**
 * Get the current queue depth (for monitoring / dashboard display).
 */
export async function getQueueStats(): Promise<{
  queued: number
  processing: number
  completed: number
  failed: number
}> {
  const [queued, processing, completed, failed] = await Promise.all([
    db.jobQueue.count({ where: { status: 'queued' } }),
    db.jobQueue.count({ where: { status: 'processing' } }),
    db.jobQueue.count({ where: { status: 'completed' } }),
    db.jobQueue.count({ where: { status: 'failed' } }),
  ])
  return { queued, processing, completed, failed }
}

/**
 * Recover jobs stuck in 'processing' for too long (e.g. after a crash).
 *
 * Each step is ONE conditional update, so a job that completed or was
 * re-claimed between a read and a write can never be reset (the old
 * findMany-then-update-by-id could). A stuck job with attempts left goes back
 * to 'queued' (the stuck window itself is the delay before it runs again);
 * one whose attempts are used up becomes 'failed', so a job that crashes the
 * process cannot loop forever.
 *
 * Also fails 'queued' rows that already used every attempt and have been due
 * for longer than the window: the worker never claims those, so they would
 * otherwise sit in the queue forever.
 */
export async function recoverStuckJobs(stuckAfterMs = 5 * 60 * 1000): Promise<number> {
  const now = new Date()
  const cutoff = new Date(now.getTime() - stuckAfterMs)
  const exhausted = { attempts: { gte: db.jobQueue.fields.maxAttempts } }

  const failedStuck = await db.jobQueue.updateMany({
    where: { status: 'processing', startedAt: { lt: cutoff }, ...exhausted },
    data: {
      status: 'failed',
      error: 'Interrupted while processing (restart or crash) with no attempts left',
      completedAt: now,
    },
  })
  const requeued = await db.jobQueue.updateMany({
    where: { status: 'processing', startedAt: { lt: cutoff } },
    data: { status: 'queued', startedAt: null },
  })
  const failedQueued = await db.jobQueue.updateMany({
    where: { status: 'queued', runAt: { lt: cutoff }, ...exhausted },
    data: { status: 'failed', error: 'No attempts left', completedAt: now },
  })

  const total = failedStuck.count + requeued.count + failedQueued.count
  if (total > 0) {
    console.log(
      `[worker] Stuck-job recovery: requeued=${requeued.count} failed=${failedStuck.count + failedQueued.count}`
    )
  }
  return total
}
