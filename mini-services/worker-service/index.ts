/**
 * Apsamo Worker Service (mini-service, port 3005)
 *
 * The panel's only scheduler. It drives every background sweep by calling a
 * panel route with the `x-cron-key` header (CRON_API_KEY):
 *
 *   jobs          10s   POST /api/admin/jobs/process   automation job queue
 *   monitors      60s   POST /api/monitors/run         uptime checks + alerts
 *   domains        2m   POST /api/domains/sweep        custom-domain DNS / SSL
 *   auto-deploy    3m   POST /api/cron/auto-deploy     redeploy when a branch moves,
 *                                                       reap stuck deployments
 *   health         5m   POST /api/health/check         email/in-app admin alerts
 *                                                       when a system check breaks
 *   migrations    30m   POST /api/migrations/sweep     import housekeeping
 *   billing        1h   POST /api/billing/sweep        renewals, overdue → suspension,
 *                                                       usage, retention, cleanup
 *
 * Reliability rules (each was a real failure):
 *   - A task never overlaps itself. setInterval fired the next tick while the
 *     previous request was still running, so two job ticks could run the same
 *     job and slow monitor sweeps piled up.
 *   - Startup waits for the panel to answer. The worker starts alongside the
 *     panel; the first billing tick used to fail against a server that was not
 *     listening yet, and the next attempt was an hour away.
 *   - A failing task is retried sooner than its normal interval (bounded
 *     backoff), and consecutive failures are logged loudly so they show up in
 *     the journal. The panel's own health check alerts admins on stale sweeps.
 *
 * Exposes GET /health with per-task state.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http'

// ── Configuration ─────────────────────────────────────────────────────
const PORT = Number(process.env.WORKER_PORT || 3005)
// 127.0.0.1, NOT localhost. On a dual-stack host `localhost` resolves to ::1
// first, while the Next.js server binds 0.0.0.0 (IPv4 only). curl hides this
// by falling back to IPv4, but Bun's fetch does not — it just fails with
// "HTTP 0", which silently killed every job tick, uptime check and billing
// sweep on production until this was pinned.
const NEXT_API_BASE = process.env.NEXT_API_BASE || 'http://127.0.0.1:3000'
const CRON_API_KEY = process.env.CRON_API_KEY || 'deployhub-cron-key'

const SECOND = 1000
const MINUTE = 60 * SECOND

interface TaskDef {
  name: string
  path: string
  everyMs: number
  timeoutMs: number
  /** One-line summary of a response worth logging, or null to stay quiet. */
  summarize?: (body: Record<string, unknown>) => string | null
}

const n = (v: unknown) => (typeof v === 'number' ? v : 0)

const TASKS: TaskDef[] = [
  {
    name: 'jobs',
    path: '/api/admin/jobs/process?limit=20',
    everyMs: 10 * SECOND,
    timeoutMs: 60 * SECOND,
    summarize: (b) =>
      n(b.processed) > 0
        ? `processed=${n(b.processed)} succeeded=${n(b.succeeded)} failed=${n(b.failed)}`
        : null,
  },
  {
    name: 'monitors',
    path: '/api/monitors/run',
    everyMs: MINUTE,
    timeoutMs: 3 * MINUTE,
    summarize: (b) =>
      n(b.wentDown) || n(b.recovered)
        ? `checked=${n(b.checked)} down=${n(b.down)} wentDown=${n(b.wentDown)} recovered=${n(b.recovered)}`
        : null,
  },
  {
    name: 'domains',
    path: '/api/domains/sweep',
    everyMs: 2 * MINUTE,
    timeoutMs: 90 * SECOND,
    summarize: (b) => (n(b.connected) > 0 ? `checked=${n(b.checked)} connected=${n(b.connected)}` : null),
  },
  {
    name: 'auto-deploy',
    path: '/api/cron/auto-deploy',
    everyMs: 3 * MINUTE,
    timeoutMs: 5 * MINUTE,
    summarize: (b) => {
      const triggered = Array.isArray(b.triggered) ? b.triggered.length : 0
      return triggered || n(b.reapedStale)
        ? `triggered=${triggered} reapedStale=${n(b.reapedStale)}`
        : null
    },
  },
  {
    name: 'health',
    path: '/api/health/check',
    everyMs: 5 * MINUTE,
    timeoutMs: 2 * MINUTE,
    summarize: (b) => (b.alerted ? `alerted: ${JSON.stringify(b.failing ?? '')}` : null),
  },
  {
    name: 'migrations',
    path: '/api/migrations/sweep',
    everyMs: 30 * MINUTE,
    timeoutMs: 2 * MINUTE,
    summarize: (b) =>
      n(b.uploadsRemoved) || n(b.orphansFailed)
        ? `uploads_removed=${n(b.uploadsRemoved)} orphans_failed=${n(b.orphansFailed)}`
        : null,
  },
  {
    name: 'billing',
    path: '/api/billing/sweep',
    everyMs: 60 * MINUTE,
    // The sweep also prunes backups and reclaims Docker space on every
    // server; 60s cut it off mid-run on a busy host.
    timeoutMs: 10 * MINUTE,
    summarize: (b) => {
      const busy =
        n(b.renewed) || n(b.pastDue) || n(b.suspended) || n(b.reminded) || n(b.websitesStopped)
      return busy
        ? `renewed=${n(b.renewed)} reminded=${n(b.reminded)} pastDue=${n(b.pastDue)} suspended=${n(b.suspended)} websitesStopped=${n(b.websitesStopped)}`
        : null
    },
  },
]

// ── State ─────────────────────────────────────────────────────────────
interface TaskState {
  running: boolean
  runs: number
  successes: number
  failures: number
  consecutiveFailures: number
  skippedOverlaps: number
  lastRunAt: string | null
  lastSuccessAt: string | null
  lastDurationMs: number | null
  lastError: string | null
  nextRunAt: string | null
}

const state = new Map<string, TaskState>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const startedAt = Date.now()
let stopping = false

// ── HTTP helper ───────────────────────────────────────────────────────
async function callNextApi(
  path: string,
  timeoutMs: number,
  method: 'GET' | 'POST' = 'POST'
): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${NEXT_API_BASE}${path}`, {
      method,
      headers: { 'x-cron-key': CRON_API_KEY, 'Content-Type': 'application/json' },
      signal: controller.signal,
    })
    const text = await res.text()
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    return { ok: res.ok, status: res.status, body }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      ok: false,
      status: 0,
      body: null,
      error: aborted ? `timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(timer)
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────
/** After a failure retry sooner, doubling up to the normal interval. */
function retryDelay(task: TaskDef, consecutiveFailures: number): number {
  const base = Math.min(30 * SECOND, task.everyMs)
  return Math.min(task.everyMs, base * 2 ** Math.max(0, consecutiveFailures - 1))
}

function schedule(task: TaskDef, delayMs: number) {
  if (stopping) return
  const s = state.get(task.name)!
  s.nextRunAt = new Date(Date.now() + delayMs).toISOString()
  timers.set(
    task.name,
    setTimeout(() => void runTask(task), delayMs)
  )
}

async function runTask(task: TaskDef): Promise<void> {
  const s = state.get(task.name)!
  if (s.running) {
    // Cannot normally happen with setTimeout chaining, but a manual trigger
    // or a clock jump must still never run a task twice at once.
    s.skippedOverlaps++
    return
  }
  s.running = true
  s.runs++
  s.lastRunAt = new Date().toISOString()
  const t0 = Date.now()
  let ok = false
  try {
    const res = await callNextApi(task.path, task.timeoutMs)
    if (res.ok) {
      ok = true
      const body = (res.body && typeof res.body === 'object' ? res.body : {}) as Record<string, unknown>
      const line = task.summarize?.(body)
      if (line) console.log(`[worker] ${task.name}: ${line}`)
    } else {
      const detail =
        res.error ||
        `HTTP ${res.status}: ${typeof res.body === 'object' ? JSON.stringify(res.body) : String(res.body)}`
      s.lastError = detail.slice(0, 500)
    }
  } catch (err) {
    s.lastError = err instanceof Error ? err.message : String(err)
  } finally {
    s.running = false
    s.lastDurationMs = Date.now() - t0
  }

  if (ok) {
    if (s.consecutiveFailures >= 3) {
      console.log(`[worker] ${task.name}: recovered after ${s.consecutiveFailures} failures`)
    }
    s.successes++
    s.consecutiveFailures = 0
    s.lastError = null
    s.lastSuccessAt = new Date().toISOString()
    schedule(task, task.everyMs)
  } else {
    s.failures++
    s.consecutiveFailures++
    const level = s.consecutiveFailures >= 3 ? 'ERROR' : 'warn'
    console.error(
      `[worker] ${level} ${task.name} failed (${s.consecutiveFailures} in a row): ${s.lastError}`
    )
    schedule(task, retryDelay(task, s.consecutiveFailures))
  }
}

/** Wait until the panel answers before starting the sweeps. */
async function waitForPanel(maxWaitMs = 5 * MINUTE): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs
  let attempt = 0
  while (!stopping && Date.now() < deadline) {
    const res = await callNextApi('/api/health', 5 * SECOND, 'GET')
    if (res.status > 0) return true // any HTTP answer means it is listening
    attempt++
    if (attempt === 1 || attempt % 6 === 0) {
      console.log(`[worker] waiting for the panel at ${NEXT_API_BASE} (${res.error || 'no answer'})`)
    }
    await new Promise((r) => setTimeout(r, 5 * SECOND))
  }
  return false
}

// ── HTTP server ───────────────────────────────────────────────────────
const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/health' && (req.method === 'GET' || req.method === 'POST')) {
    const tasks = Object.fromEntries(
      TASKS.map((t) => [t.name, { everyMs: t.everyMs, ...state.get(t.name) }])
    )
    const unhealthy = TASKS.filter((t) => (state.get(t.name)?.consecutiveFailures ?? 0) >= 3).map(
      (t) => t.name
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        status: unhealthy.length ? 'degraded' : 'ok',
        unhealthy,
        service: 'worker-service',
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        uptimeHuman: formatUptime(Date.now() - startedAt),
        nextApiBase: NEXT_API_BASE,
        tasks,
        timestamp: new Date().toISOString(),
      })
    )
    return
  }
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        service: 'worker-service',
        message: 'Apsamo background worker. See /health for per-task state.',
        endpoints: ['/health'],
      })
    )
    return
  }
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

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
for (const t of TASKS) {
  state.set(t.name, {
    running: false,
    runs: 0,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    skippedOverlaps: 0,
    lastRunAt: null,
    lastSuccessAt: null,
    lastDurationMs: null,
    lastError: null,
    nextRunAt: null,
  })
}

httpServer.listen(PORT, async () => {
  console.log(`[worker] Apsamo worker on port ${PORT}; panel at ${NEXT_API_BASE} (cron key: ${
    CRON_API_KEY === 'deployhub-cron-key' ? 'DEV DEFAULT — set CRON_API_KEY' : 'from CRON_API_KEY'
  })`)
  console.log(
    `[worker] Tasks: ${TASKS.map((t) => `${t.name}/${Math.round(t.everyMs / 1000)}s`).join(', ')}`
  )

  const up = await waitForPanel()
  if (!up && !stopping) {
    console.error('[worker] panel did not answer within 5 minutes — starting anyway; tasks will retry')
  }
  // Stagger the first runs a little so they do not all hit the panel at once.
  TASKS.forEach((t, i) => schedule(t, i * 2 * SECOND))
})

// ── Graceful shutdown ─────────────────────────────────────────────────
function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`[worker] Received ${signal}, shutting down...`)
  for (const t of timers.values()) clearTimeout(t)
  httpServer.close(() => {
    console.log('[worker] HTTP server closed')
    process.exit(0)
  })
  setTimeout(() => {
    console.error('[worker] Forced shutdown after timeout')
    process.exit(1)
  }, 5000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
