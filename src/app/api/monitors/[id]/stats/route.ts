import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { getMonitorStats } from '@/lib/monitor'
import { requireProjectAccess } from '@/lib/project-access'

/**
 * GET /api/monitors/[id]/stats?hours=24
 * Returns uptime statistics for a monitor over the last `hours` hours.
 *
 * Response:
 *   { uptimePct, totalChecks, upCount, downCount, avgResponseTime, checks: [...] }
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }
    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    // Verify access to the monitor's project.
    const monitor = await db.uptimeMonitor.findUnique({
      where: { id },
      select: { projectId: true },
    })
    if (!monitor) {
      return NextResponse.json(
        { error: 'Monitor not found' },
        { status: 404 }
      )
    }
    const access = await requireProjectAccess(decoded, monitor.projectId, 'view')
    if (!access.ok) return access.response

    // Parse hours (1..720h / 30 days).
    const url = new URL(request.url)
    const rawHours = url.searchParams.get('hours') ?? '24'
    let hours = Number.parseInt(rawHours, 10)
    if (!Number.isFinite(hours) || hours < 1) hours = 24
    if (hours > 720) hours = 720

    const stats = await getMonitorStats(id, hours)

    return NextResponse.json({
      monitorId: id,
      hours,
      ...stats,
    })
  } catch (error) {
    console.error('Monitor stats error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
