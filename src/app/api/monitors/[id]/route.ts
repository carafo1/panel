import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { deleteMonitor, setMonitorEnabled } from '@/lib/monitor'

/**
 * Resolve a monitor and verify the caller owns the parent project.
 * Returns either `{ monitor, project }` or a NextResponse error.
 */
async function resolveOwnedMonitor(
  request: Request,
  monitorId: string
): Promise<
  | {
      ok: true
      monitor: Awaited<ReturnType<typeof db.uptimeMonitor.findUnique>>
    }
  | { ok: false; response: NextResponse }
> {
  const authHeader = request.headers.get('Authorization')
  const token = extractTokenFromHeader(authHeader)
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      ),
    }
  }
  const decoded = verifyToken(token)
  if (!decoded) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      ),
    }
  }

  const monitor = await db.uptimeMonitor.findUnique({
    where: { id: monitorId },
    include: {
      project: { select: { id: true, name: true, userId: true, subdomain: true, customDomain: true } },
    },
  })

  if (!monitor || monitor.project.userId !== decoded.userId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Monitor not found' },
        { status: 404 }
      ),
    }
  }
  return { ok: true, monitor }
}

/**
 * GET /api/monitors/[id]
 * Returns monitor details + the 20 most recent checks.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const resolved = await resolveOwnedMonitor(request, id)
    if (!resolved.ok) return resolved.response
    const monitor = resolved.monitor

    const checks = await db.uptimeCheck.findMany({
      where: { monitorId: id },
      orderBy: { checkedAt: 'desc' },
      take: 20,
    })

    return NextResponse.json({
      monitor: {
        id: monitor!.id,
        projectId: monitor!.projectId,
        url: monitor!.url,
        intervalSec: monitor!.intervalSec,
        enabled: monitor!.enabled,
        lastStatus: monitor!.lastStatus,
        lastCheckedAt: monitor!.lastCheckedAt,
        uptimePct: monitor!.uptimePct,
        createdAt: monitor!.createdAt,
        updatedAt: monitor!.updatedAt,
        project: monitor!.project,
      },
      checks: checks.map((c) => ({
        id: c.id,
        status: c.status,
        responseTime: c.responseTime,
        statusCode: c.statusCode,
        error: c.error,
        checkedAt: c.checkedAt,
      })),
    })
  } catch (error) {
    console.error('Get monitor error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * PATCH /api/monitors/[id]
 * Partial update of a monitor. Allowed fields: enabled, intervalSec, url.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const resolved = await resolveOwnedMonitor(request, id)
    if (!resolved.ok) return resolved.response

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      )
    }

    const { enabled, intervalSec, url } = body as {
      enabled?: boolean
      intervalSec?: number
      url?: string
    }

    const data: Record<string, unknown> = {}

    if (typeof enabled === 'boolean') {
      data.enabled = enabled
    }

    if (typeof intervalSec === 'number') {
      if (intervalSec < 10 || intervalSec > 86400) {
        return NextResponse.json(
          { error: 'intervalSec must be between 10 and 86400' },
          { status: 400 }
        )
      }
      data.intervalSec = Math.floor(intervalSec)
    }

    if (typeof url === 'string' && url.length > 0) {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return NextResponse.json(
          { error: 'Invalid URL. Include the scheme (https://...).' },
          { status: 400 }
        )
      }
      if (!/^https?:$/.test(parsed.protocol)) {
        return NextResponse.json(
          { error: 'Only http(s) URLs can be monitored' },
          { status: 400 }
        )
      }
      data.url = parsed.toString()
      // Reset cached status when the URL changes.
      data.lastStatus = 'unknown'
      data.uptimePct = 100.0
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: 'No updatable fields provided' },
        { status: 400 }
      )
    }

    // `setMonitorEnabled` only flips the enabled flag - if we have additional
    // fields we do a direct update so everything is applied atomically.
    if (
      Object.keys(data).length === 1 &&
      typeof data.enabled === 'boolean'
    ) {
      await setMonitorEnabled(id, data.enabled)
    } else {
      await db.uptimeMonitor.update({ where: { id }, data })
    }

    const monitor = await db.uptimeMonitor.findUnique({
      where: { id },
      include: {
        project: {
          select: { id: true, name: true, subdomain: true, customDomain: true },
        },
      },
    })

    return NextResponse.json({ monitor })
  } catch (error) {
    console.error('Update monitor error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/monitors/[id]
 * Delete a monitor and all its checks.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const resolved = await resolveOwnedMonitor(request, id)
    if (!resolved.ok) return resolved.response

    const ok = await deleteMonitor(id)
    if (!ok) {
      return NextResponse.json(
        { error: 'Failed to delete monitor' },
        { status: 500 }
      )
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Delete monitor error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
