/**
 * DeployHub Worker Service (mini-service, port 3005)
 *
 * A standalone Bun service that drives the background-job and uptime-monitor
 * pipelines by calling the Next.js API:
 *
 *   - Every 10s:  POST /api/admin/jobs/process   (with x-cron-key)
 *     -> picks up queued/failed JobQueue rows and runs them via the
 *        automation engine. This is what advances deployment_status_check
 *        jobs (which transition deployments through building → live) to
 *        completion.
 *
 *   - Every 60s:  POST /api/monitors/run         (with x-cron-key)
 *     -> runs an uptime check sweep across every enabled UptimeMonitor.
 *
 * Both target endpoints accept the `x-cron-key` header so we can call them
 * without a user session. The key is read from CRON_API_KEY (falls back to
 * the dev default 'deployhub-cron-key' to match /api/monitors/run).
 *
 * The Next.js dev server is assumed to be running on port 3000 - we call
 * it directly via http://localhost:3000 because this service runs inside
 * the same sandbox (no need to go through the Caddy gateway).
 *
 * Exposes:
 *   GET  /health       -> JSON status { status, uptime, lastRun, ... }
 *   POST /health       -> alias for GET (some monitors POST)
 */

import { createServer, IncomingMessage, ServerResponse } from 'http'

// ── Configuration ─────────────────────────────────────────────────────
const PORT = 3005
const NEXT_API_BASE =
  process.env.NEXT_API_BASE || 'http://localhost:3000'
const CRON_API_KEY = process.env.CRON_API_KEY || 'deployhub-cron-key'

const JOBS_INTERVAL_MS = 10_000 // 10s
const MONITORS_INTERVAL_MS = 60_000 // 60s
// Subscription lifecycle: remind before expiry, mark past_due, suspend after
// grace. Hourly is plenty — these are day-scale transitions.
const BILLING_INTERVAL_MS = 60 * 60_000 // 1h

// ── State ─────────────────────────────────────────────────────────────
interface RunStats {
  jobs: {
    lastRunAt: string | null
    lastResult: { processed: number; succeeded: number; failed: number } | null
    lastError: string | null
    runs: number
    successes: number
    failures: number
  }
  monitors: {
    lastRunAt: string | null
    lastResult: { checked: number; up: number; down: number } | null
    lastError: string | null
    runs: number
    successes: number
    failures: number
  }
}

const stats: RunStats = {
  jobs: {
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    runs: 0,
    successes: 0,
    failures: 0,
  },
  monitors: {
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    runs: 0,
    successes: 0,
    failures: 0,
  },
}

const startedAt = Date.now()
let jobsTimer: ReturnType<typeof setInterval> | null = null
let monitorsTimer: ReturnType<typeof setInterval> | null = null
let billingTimer: ReturnType<typeof setInterval> | null = null

// ── HTTP helper ───────────────────────────────────────────────────────
async function callNextApi(
  path: string,
  options: { method?: 'GET' | 'POST'; timeoutMs?: number } = {}
): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  const method = options.method || 'POST'
  const timeoutMs = options.timeoutMs ?? 30_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${NEXT_API_BASE}${path}`, {
      method,
      headers: {
        'x-cron-key': CRON_API_KEY,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    })
    let body: unknown = null
    const text = await res.text()
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    return { ok: res.ok, status: res.status, body }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(timer)
  }
}

// ── Job processing tick ───────────────────────────────────────────────
async function processJobsTick() {
  stats.jobs.runs++
  stats.jobs.lastRunAt = new Date().toISOString()
  try {
    const res = await callNextApi('/api/admin/jobs/process?limit=20', {
      method: 'POST',
      timeoutMs: 60_000,
    })
    if (!res.ok) {
      const errMsg = `HTTP ${res.status}: ${
        typeof res.body === 'object' && res.body
          ? JSON.stringify(res.body)
          : String(res.body)
      }`
      stats.jobs.failures++
      stats.jobs.lastError = errMsg
      console.error(`[worker] /api/admin/jobs/process failed: ${errMsg}`)
      return
    }
    const body = res.body as {
      processed?: number
      succeeded?: number
      failed?: number
    } | null
    const result = {
      processed: body?.processed ?? 0,
      succeeded: body?.succeeded ?? 0,
      failed: body?.failed ?? 0,
    }
    stats.jobs.successes++
    stats.jobs.lastResult = result
    stats.jobs.lastError = null
    // Only log when there's interesting activity to keep the console clean.
    if (result.processed > 0) {
      console.log(
        `[worker] jobs: processed=${result.processed} succeeded=${result.succeeded} failed=${result.failed}`
      )
    }
  } catch (err) {
    stats.jobs.failures++
    stats.jobs.lastError = err instanceof Error ? err.message : String(err)
    console.error('[worker] jobs tick error:', stats.jobs.lastError)
  }
}

// ── Billing sweep tick ────────────────────────────────────────────────
// Enforces the subscription lifecycle for non-Stripe (offline / Waafi)
// subscriptions. Stripe drives its own via webhooks.
async function billingTick(): Promise<void> {
  try {
    const res = await callNextApi('/api/billing/sweep', { timeoutMs: 60_000 })
    if (!res.ok) {
      const errMsg = `HTTP ${res.status}: ${
        typeof res.body === 'object' && res.body
          ? JSON.stringify(res.body)
          : String(res.body)
      }`
      console.error(`[worker] /api/billing/sweep failed: ${errMsg}`)
      return
    }
    const body = res.body as {
      scanned?: number
      reminded?: number
      pastDue?: number
      suspended?: number
    } | null
    const reminded = body?.reminded ?? 0
    const pastDue = body?.pastDue ?? 0
    const suspended = body?.suspended ?? 0
    if (reminded || pastDue || suspended) {
      console.log(
        `[worker] billing: scanned=${body?.scanned ?? 0} reminded=${reminded} pastDue=${pastDue} suspended=${suspended}`
      )
    }
  } catch (err) {
    console.error(
      '[worker] billing tick error:',
      err instanceof Error ? err.message : String(err)
    )
  }
}

// ── Uptime monitor tick ───────────────────────────────────────────────
async function runMonitorsTick() {
  stats.monitors.runs++
  stats.monitors.lastRunAt = new Date().toISOString()
  try {
    const res = await callNextApi('/api/monitors/run', {
      method: 'POST',
      timeoutMs: 60_000,
    })
    if (!res.ok) {
      const errMsg = `HTTP ${res.status}: ${
        typeof res.body === 'object' && res.body
          ? JSON.stringify(res.body)
          : String(res.body)
      }`
      stats.monitors.failures++
      stats.monitors.lastError = errMsg
      console.error(`[worker] /api/monitors/run failed: ${errMsg}`)
      return
    }
    const body = res.body as {
      checked?: number
      up?: number
      down?: number
    } | null
    const result = {
      checked: body?.checked ?? 0,
      up: body?.up ?? 0,
      down: body?.down ?? 0,
    }
    stats.monitors.successes++
    stats.monitors.lastResult = result
    stats.monitors.lastError = null
    if (result.checked > 0) {
      console.log(
        `[worker] monitors: checked=${result.checked} up=${result.up} down=${result.down}`
      )
    }
  } catch (err) {
    stats.monitors.failures++
    stats.monitors.lastError = err instanceof Error ? err.message : String(err)
    console.error('[worker] monitors tick error:', stats.monitors.lastError)
  }
}

// ── HTTP server ───────────────────────────────────────────────────────
const httpServer = createServer(
  (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health' && (req.method === 'GET' || req.method === 'POST')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'worker-service',
          uptime: Math.floor((Date.now() - startedAt) / 1000),
          uptimeHuman: formatUptime(Date.now() - startedAt),
          nextApiBase: NEXT_API_BASE,
          intervals: {
            jobsMs: JOBS_INTERVAL_MS,
            monitorsMs: MONITORS_INTERVAL_MS,
          },
          stats,
          timestamp: new Date().toISOString(),
        })
      )
      return
    }

    // Friendly root path that summarises what this service does.
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          service: 'worker-service',
          message: 'DeployHub background worker. See /health for stats.',
          endpoints: ['/health'],
        })
      )
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  }
)

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

// ── Startup ───────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`[worker] DeployHub worker service running on port ${PORT}`)
  console.log(`[worker] Health check: GET http://localhost:${PORT}/health`)
  console.log(
    `[worker] Targeting Next.js API at ${NEXT_API_BASE} (cron key: ${
      CRON_API_KEY === 'deployhub-cron-key' ? 'dev default' : 'env CRON_API_KEY'
    })`
  )
  console.log(
    `[worker] Schedules: jobs every ${JOBS_INTERVAL_MS}ms, monitors every ${MONITORS_INTERVAL_MS}ms, billing every ${BILLING_INTERVAL_MS}ms`
  )

  // Kick off an immediate tick on startup so we don't wait a full interval
  // before the first batch runs.
  processJobsTick().catch((err) =>
    console.error('[worker] initial jobs tick failed:', err)
  )
  runMonitorsTick().catch((err) =>
    console.error('[worker] initial monitors tick failed:', err)
  )
  billingTick().catch((err) =>
    console.error('[worker] initial billing tick failed:', err)
  )

  // Schedule recurring ticks.
  jobsTimer = setInterval(() => {
    processJobsTick().catch((err) =>
      console.error('[worker] scheduled jobs tick failed:', err)
    )
  }, JOBS_INTERVAL_MS)

  monitorsTimer = setInterval(() => {
    runMonitorsTick().catch((err) =>
      console.error('[worker] scheduled monitors tick failed:', err)
    )
  }, MONITORS_INTERVAL_MS)

  billingTimer = setInterval(() => {
    billingTick().catch((err) =>
      console.error('[worker] scheduled billing tick failed:', err)
    )
  }, BILLING_INTERVAL_MS)
})

// ── Graceful shutdown ─────────────────────────────────────────────────
function shutdown(signal: string) {
  console.log(`[worker] Received ${signal}, shutting down...`)
  if (jobsTimer) clearInterval(jobsTimer)
  if (monitorsTimer) clearInterval(monitorsTimer)
  if (billingTimer) clearInterval(billingTimer)
  httpServer.close(() => {
    console.log('[worker] HTTP server closed')
    process.exit(0)
  })
  // Force exit after 5s if graceful shutdown hangs.
  setTimeout(() => {
    console.error('[worker] Forced shutdown after timeout')
    process.exit(1)
  }, 5000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
