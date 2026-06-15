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
    await automationProcessJob(job.id)
     
    console.log(`[worker] Job ${job.id} processed via automation engine`)
  } catch (error) {
     
    console.error(
      `[worker] Job ${job.id} failed:`,
      error instanceof Error ? error.message : error
    )
    // Mark as failed if not already
    try {
      await db.jobQueue.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown worker error',
          completedAt: new Date(),
        },
      })
    } catch {
      // swallow - already logged above
    }
  }
}

/**
 * Process up to `limit` pending jobs. Returns aggregate counts.
 */
export async function processPendingJobs(limit = 10): Promise<ProcessResult> {
  const pendingJobs = await db.jobQueue.findMany({
    where: {
      status: { in: ['queued', 'failed'] },
      runAt: { lte: new Date() },
      attempts: { lt: 3 },
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
 * Re-queue any jobs stuck in 'processing' for too long (e.g. after a crash).
 * A job is considered stuck if it has been processing for more than 5 minutes.
 */
export async function recoverStuckJobs(stuckAfterMs = 5 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - stuckAfterMs)
  const stuck = await db.jobQueue.findMany({
    where: {
      status: 'processing',
      startedAt: { lt: cutoff },
    },
    select: { id: true },
  })
  if (stuck.length === 0) return 0
  await db.jobQueue.updateMany({
    where: { id: { in: stuck.map((j) => j.id) } },
    data: { status: 'queued', startedAt: null },
  })
   
  console.log(`[worker] Recovered ${stuck.length} stuck jobs`)
  return stuck.length
}
