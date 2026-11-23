/**
 * Uptime monitoring service.
 *
 * Used by:
 *  - #11 Uptime Monitoring
 *
 * Periodically pings project URLs and records up/down status with response
 * times, so the dashboard can show uptime percentages and recent incidents.
 *
 * Prisma models (defined in prisma/schema.prisma):
 *   UptimeMonitor { id, projectId, url, intervalSec, enabled, lastStatus,
 *                    lastCheckedAt, uptimePct, createdAt, updatedAt }
 *   UptimeCheck { id, monitorId, status, responseTime, statusCode, error, checkedAt }
 *
 * The functions are defensive: if a DB call fails they log an error and
 * return sensible defaults so the rest of the request keeps working.
 * `checkUptime` itself is a pure HTTP probe and never touches the DB.
 */
import { db } from '@/lib/db'
import { assertPublicUrl, fetchPublicTarget } from '@/lib/ssrf'
import { createNotification } from '@/lib/notifications'
import { sendEmail } from '@/lib/email'
import { emitWebhookEvent } from '@/lib/webhook-delivery'

const DEFAULT_TIMEOUT_MS = 10_000

export interface UptimeCheckResult {
  status: 'up' | 'down'
  responseTime: number // ms
  statusCode?: number
  error?: string
}

/**
 * Probe a URL and report up/down + response time.
 * A 2xx/3xx response counts as up; everything else (or a network error) is down.
 */
export async function checkUptime(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<UptimeCheckResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const start = Date.now()
  try {
    // SSRF guard: refuse to probe private/loopback/metadata addresses.
    // Pinned to the checked address; a redirect is NOT followed (a 3xx already
    // counts as up), so a monitored site cannot bounce the probe into
    // 127.0.0.1 or the cloud metadata service.
    const target = await assertPublicUrl(url)
    const res = await fetchPublicTarget(target, url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'ApsamoPanel-Uptime-Monitor/1.0' },
    })
    // The body is never used; release the connection.
    res.body?.cancel().catch(() => {})
    const responseTime = Date.now() - start
    const isUp = res.status >= 200 && res.status < 400
    return {
      status: isUp ? 'up' : 'down',
      responseTime,
      statusCode: res.status,
      ...(isUp ? {} : { error: `HTTP ${res.status}` }),
    }
  } catch (error) {
    const responseTime = Date.now() - start
    const isAbort = (error as Error).name === 'AbortError'
    return {
      status: 'down',
      responseTime,
      error: isAbort
        ? `Request timed out after ${timeoutMs}ms`
        : (error as Error).message,
    }
  } finally {
    clearTimeout(timer)
  }
}

interface RunResult {
  checked: number
  up: number
  down: number
  /** Monitors that changed up → down in this sweep (alerts sent). */
  wentDown: number
  /** Monitors that changed down → up in this sweep (alerts sent). */
  recovered: number
  /** Enabled monitors not yet due (their interval has not elapsed). */
  notDue: number
}

/** Probes in flight at once — keeps a sweep well inside the worker timeout. */
const CHECK_CONCURRENCY = 8
/** Pause before re-checking a site that just failed, to rule out a blip. */
const CONFIRM_DELAY_MS = 5_000
/** Slack so a monitor due "in 2 seconds" is not pushed to the next sweep. */
const DUE_SLACK_MS = 5_000

type MonitorRow = {
  id: string
  url: string
  intervalSec: number
  lastStatus: string
  lastCheckedAt: Date | null
  projectId: string
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await fn(item)
    }
  })
  await Promise.all(workers)
}

/**
 * Run uptime checks for every enabled monitor that is due.
 *
 * - Each monitor's own `intervalSec` is honoured (it was ignored: every
 *   monitor was checked on every sweep).
 * - Checks run several at a time; one at a time with a 10s timeout each
 *   overran the worker's tick once a few sites were slow.
 * - A failure is re-checked once after a short pause before it counts as an
 *   outage, so a single dropped request does not page anyone.
 * - On a change of state the project owner is told — in-app, by email and
 *   through their `monitor.down` / `monitor.up` webhooks. Previously a site
 *   could be down for days with nobody notified at all.
 */
export async function runUptimeChecks(): Promise<RunResult> {
  const result: RunResult = { checked: 0, up: 0, down: 0, wentDown: 0, recovered: 0, notDue: 0 }

  let monitors: MonitorRow[] = []
  try {
    monitors = await db.uptimeMonitor.findMany({
      where: { enabled: true },
      select: { id: true, url: true, intervalSec: true, lastStatus: true, lastCheckedAt: true, projectId: true },
    })
  } catch (error) {
    console.error(
      '[monitor] UptimeMonitor table not available - returning empty result',
      error instanceof Error ? error.message : error
    )
    return result
  }

  const now = Date.now()
  const due = monitors.filter((m) => {
    if (!m.lastCheckedAt) return true
    const intervalMs = Math.max(30, m.intervalSec || 60) * 1000
    return m.lastCheckedAt.getTime() + intervalMs - DUE_SLACK_MS <= now
  })
  result.notDue = monitors.length - due.length

  await mapWithConcurrency(due, CHECK_CONCURRENCY, async (m) => {
    let check = await checkUptime(m.url)
    if (check.status === 'down' && m.lastStatus !== 'down') {
      await new Promise((r) => setTimeout(r, CONFIRM_DELAY_MS))
      const confirm = await checkUptime(m.url)
      if (confirm.status === 'up') check = confirm
    }

    result.checked++
    if (check.status === 'up') result.up++
    else result.down++

    try {
      await db.uptimeCheck.create({
        data: {
          monitorId: m.id,
          status: check.status,
          responseTime: check.responseTime,
          statusCode: check.statusCode ?? null,
          error: check.error ?? null,
          checkedAt: new Date(),
        },
      })
    } catch (error) {
      console.error('[monitor] Failed to record uptime check', error instanceof Error ? error.message : error)
    }

    // Refresh the parent monitor's denormalized status fields. uptimePct is
    // computed over the last 24h so the listing does not re-query checks.
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const [total, upCnt] = await Promise.all([
        db.uptimeCheck.count({ where: { monitorId: m.id, checkedAt: { gte: since } } }),
        db.uptimeCheck.count({ where: { monitorId: m.id, checkedAt: { gte: since }, status: 'up' } }),
      ])
      const pct = total > 0 ? Math.round((upCnt / total) * 10000) / 100 : check.status === 'up' ? 100 : 0
      await db.uptimeMonitor.update({
        where: { id: m.id },
        data: { lastStatus: check.status, lastCheckedAt: new Date(), uptimePct: pct },
      })
    } catch (error) {
      console.error('[monitor] Failed to update monitor summary', error instanceof Error ? error.message : error)
    }

    // 'unknown' → anything is a first check, not a change worth alerting on.
    if (m.lastStatus === 'up' && check.status === 'down') {
      result.wentDown++
      await alertStateChange(m, 'down', check)
    } else if (m.lastStatus === 'down' && check.status === 'up') {
      result.recovered++
      await alertStateChange(m, 'up', check)
    }
  })

  return result
}

/** Tell the project owner a monitored site went down or came back. */
async function alertStateChange(
  m: MonitorRow,
  state: 'down' | 'up',
  check: UptimeCheckResult
): Promise<void> {
  try {
    const project = await db.project.findUnique({
      where: { id: m.projectId },
      select: { id: true, name: true, userId: true, user: { select: { email: true, name: true } } },
    })
    if (!project) return

    // How long it was down, for the recovery message: from the first 'down'
    // after the last 'up' that preceded the check just recorded.
    let downFor: string | null = null
    if (state === 'up') {
      const lastUpBefore = await db.uptimeCheck.findFirst({
        where: { monitorId: m.id, status: 'up' },
        orderBy: { checkedAt: 'desc' },
        skip: 1, // skip the 'up' just recorded
        select: { checkedAt: true },
      })
      const firstDown = await db.uptimeCheck.findFirst({
        where: {
          monitorId: m.id,
          status: 'down',
          ...(lastUpBefore ? { checkedAt: { gt: lastUpBefore.checkedAt } } : {}),
        },
        orderBy: { checkedAt: 'asc' },
        select: { checkedAt: true },
      })
      if (firstDown) downFor = formatDuration(Date.now() - firstDown.checkedAt.getTime())
    }

    const reason = check.error || (check.statusCode ? `HTTP ${check.statusCode}` : 'no response')
    const title = state === 'down' ? `${project.name} is down` : `${project.name} is back up`
    const message =
      state === 'down'
        ? `${m.url} stopped responding (${reason}). We'll tell you when it recovers.`
        : `${m.url} is responding again${downFor ? ` after ${downFor}` : ''}.`

    await createNotification({
      userId: project.userId,
      title,
      message,
      type: state === 'down' ? 'error' : 'success',
      link: '/?tab=monitoring',
    }).catch(() => {})

    if (project.user?.email) {
      await sendEmail({
        to: project.user.email,
        subject: state === 'down' ? `🔴 ${project.name} is down` : `🟢 ${project.name} is back up`,
        html: `<p>Hi ${escapeHtml(project.user.name || 'there')},</p>
<p>${escapeHtml(message)}</p>
<p>Checked at ${new Date().toUTCString()}.</p>
<p>— Apsamo uptime monitoring</p>`,
      }).catch(() => {})
    }

    await emitWebhookEvent(
      project.userId,
      state === 'down' ? 'monitor.down' : 'monitor.up',
      {
        monitor: { id: m.id, url: m.url },
        project: { id: project.id, name: project.name },
        statusCode: check.statusCode ?? null,
        responseTimeMs: check.responseTime,
        ...(state === 'down' ? { reason } : { downFor }),
      },
      { projectId: project.id }
    )
  } catch (err) {
    console.error('[monitor] alert failed for', m.id, err)
  }
}

function formatDuration(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 1) return 'less than a minute'
  if (min < 60) return `about ${min} minute${min === 1 ? '' : 's'}`
  const h = Math.floor(min / 60)
  const rem = min % 60
  return `about ${h} hour${h === 1 ? '' : 's'}${rem ? ` ${rem} min` : ''}`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

interface CreateMonitorResult {
  id: string
}

/**
 * Create a new uptime monitor for a project URL.
 */
export async function createMonitor(
  projectId: string,
  url: string,
  intervalSec = 60
): Promise<CreateMonitorResult> {
  try {
    const monitor = await db.uptimeMonitor.create({
      data: {
        projectId,
        url,
        intervalSec,
        enabled: true,
      },
    })
    return { id: monitor.id }
  } catch (error) {
    // Returning an invented 'demo-monitor-…' id made the API answer 201
    // for a monitor that did not exist. Let the caller report the failure.
    console.error('[monitor] Failed to create monitor', error instanceof Error ? error.message : error)
    throw error
  }
}

interface MonitorStats {
  uptimePct: number
  totalChecks: number
  upCount: number
  downCount: number
  avgResponseTime: number
  checks: Array<{
    id: string
    status: string
    responseTime: number | null
    statusCode?: number | null
    error?: string | null
    checkedAt: Date
  }>
}

/**
 * Compute uptime percentage and return recent check records for a monitor.
 */
export async function getMonitorStats(
  monitorId: string,
  hours = 24
): Promise<MonitorStats> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000)
  try {
    const checks = await db.uptimeCheck.findMany({
      where: { monitorId, checkedAt: { gte: since } },
      orderBy: { checkedAt: 'desc' },
      take: 500,
    })

    if (checks.length === 0) {
      return {
        uptimePct: 0,
        totalChecks: 0,
        upCount: 0,
        downCount: 0,
        avgResponseTime: 0,
        checks: [],
      }
    }
    const upCount = checks.filter((c) => c.status === 'up').length
    const downCount = checks.length - upCount
    const uptimePct = (upCount / checks.length) * 100
    const responseTimes = checks
      .map((c) => c.responseTime)
      .filter((t): t is number => t != null)
    const avgResponseTime =
      responseTimes.length > 0
        ? Math.round(
            responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
          )
        : 0
    return {
      uptimePct: Math.round(uptimePct * 100) / 100,
      totalChecks: checks.length,
      upCount,
      downCount,
      avgResponseTime,
      checks: checks.map((c) => ({
        id: c.id,
        status: c.status,
        responseTime: c.responseTime,
        statusCode: c.statusCode,
        error: c.error,
        checkedAt: c.checkedAt,
      })),
    }
  } catch (error) {
    console.error(
      '[monitor] Failed to load monitor stats',
      error instanceof Error ? error.message : error
    )
    return {
      uptimePct: 0,
      totalChecks: 0,
      upCount: 0,
      downCount: 0,
      avgResponseTime: 0,
      checks: [],
    }
  }
}

/**
 * Delete a monitor and all its checks.
 */
export async function deleteMonitor(monitorId: string): Promise<boolean> {
  try {
    await db.uptimeCheck.deleteMany({ where: { monitorId } })
    await db.uptimeMonitor.delete({ where: { id: monitorId } })
    return true
  } catch (error) {
    console.error(
      '[monitor] Failed to delete monitor',
      error instanceof Error ? error.message : error
    )
    return false
  }
}

/**
 * Enable or pause a monitor.
 */
export async function setMonitorEnabled(
  monitorId: string,
  enabled: boolean
): Promise<boolean> {
  try {
    await db.uptimeMonitor.update({
      where: { id: monitorId },
      data: { enabled },
    })
    return true
  } catch (error) {
    console.error(
      '[monitor] Failed to toggle monitor',
      error instanceof Error ? error.message : error
    )
    return false
  }
}

// cache-bust-1781676663
