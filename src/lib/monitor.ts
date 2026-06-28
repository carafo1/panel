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
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'APSAMO-Uptime-Monitor/1.0' },
    })
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
}

/**
 * Run uptime checks for all enabled monitors in the database.
 * Records each result in the UptimeCheck table and updates the parent
 * monitor's lastStatus / lastCheckedAt / uptimePct fields.
 */
export async function runUptimeChecks(): Promise<RunResult> {
  let monitors: Array<{
    id: string
    url: string
    intervalSec: number
    enabled: boolean
  }> = []

  try {
    const found = await db.uptimeMonitor.findMany({
      where: { enabled: true },
    })
    monitors = found
  } catch (error) {
    console.error(
      '[monitor] UptimeMonitor table not available - returning empty result',
      error instanceof Error ? error.message : error
    )
    return { checked: 0, up: 0, down: 0 }
  }

  let up = 0
  let down = 0

  for (const m of monitors) {
    const result = await checkUptime(m.url)
    if (result.status === 'up') up++
    else down++

    try {
      await db.uptimeCheck.create({
        data: {
          monitorId: m.id,
          status: result.status,
          responseTime: result.responseTime,
          statusCode: result.statusCode ?? null,
          error: result.error ?? null,
          checkedAt: new Date(),
        },
      })
    } catch (error) {
      console.error(
        '[monitor] Failed to record uptime check',
        error instanceof Error ? error.message : error
      )
    }

    // Refresh the parent monitor's denormalized status fields. We compute
    // uptimePct over the last 24h of checks so the listing endpoint can
    // show a stable percentage without re-querying checks every render.
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const recent = await db.uptimeCheck.findMany({
        where: { monitorId: m.id, checkedAt: { gte: since } },
        select: { status: true },
        take: 1000,
      })
      const upCnt = recent.filter((c) => c.status === 'up').length
      const pct =
        recent.length > 0
          ? Math.round((upCnt / recent.length) * 10000) / 100
          : result.status === 'up'
            ? 100
            : 0

      await db.uptimeMonitor.update({
        where: { id: m.id },
        data: {
          lastStatus: result.status,
          lastCheckedAt: new Date(),
          uptimePct: pct,
        },
      })
    } catch (error) {
      console.error(
        '[monitor] Failed to update monitor summary',
        error instanceof Error ? error.message : error
      )
    }
  }

  return { checked: monitors.length, up, down }
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
    console.error(
      '[monitor] Failed to create monitor - returning demo id',
      error instanceof Error ? error.message : error
    )
    return { id: `demo-monitor-${Date.now()}` }
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
