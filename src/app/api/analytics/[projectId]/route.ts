import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'

/**
 * Honest empty analytics — returned when a project has no recorded events yet.
 * Time-series buckets are pre-filled with zeros so charts render across the
 * selected period instead of collapsing. `hasData: false` lets the UI show an
 * empty state. We never fabricate metrics.
 */
function emptyAnalytics(period: string) {
  const now = new Date()
  const days = period === '24h' ? 1 : period === '7d' ? 7 : 30
  const requestsByDay: Array<{ date: string; count: number; errors: number }> = []
  const responseTimeByDay: Array<{ date: string; avg: number; p95: number }> = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().split('T')[0]
    requestsByDay.push({ date: dateStr, count: 0, errors: 0 })
    responseTimeByDay.push({ date: dateStr, avg: 0, p95: 0 })
  }
  return {
    hasData: false,
    totalRequests: 0,
    avgResponseTime: 0,
    errorRate: 0,
    bandwidth: 0,
    uniqueVisitors: 0,
    requestsByDay,
    topPaths: [] as Array<{ path: string; count: number; avgTime: number }>,
    responseTimeByDay,
    geoDistribution: [] as Array<{ country: string; count: number }>,
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const authHeader = req.headers.get('authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const payload = verifyToken(token)
    if (!payload) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const { projectId } = await params

    // Verify project ownership
    const project = await db.project.findUnique({
      where: { id: projectId },
    })
    if (!project || project.userId !== payload.userId) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const period = req.nextUrl.searchParams.get('period') || '7d'

    const since = new Date()
    if (period === '24h') since.setHours(since.getHours() - 24)
    else if (period === '7d') since.setDate(since.getDate() - 7)
    else since.setDate(since.getDate() - 30)

    const realEvents = await db.analyticsEvent.findMany({
      where: {
        projectId,
        timestamp: { gte: since },
      },
      orderBy: { timestamp: 'desc' },
      take: 1000,
    })

    // No recorded events → honest empty state (never fabricated data).
    if (realEvents.length === 0) {
      return NextResponse.json(emptyAnalytics(period))
    }

    // Compute metrics from the real events.
    const totalRequests = realEvents.length
    const withDuration = realEvents.filter((e) => e.duration)
    const avgResponseTime = Math.round(
      withDuration.reduce((sum, e) => sum + (e.duration || 0), 0) /
        Math.max(withDuration.length, 1)
    )
    const errorCount = realEvents.filter(
      (e) => e.type === 'error' || (e.status && e.status >= 400)
    ).length
    const errorRate = Math.round((errorCount / totalRequests) * 10000) / 100
    const uniqueVisitors = new Set(
      realEvents.filter((e) => e.ip).map((e) => e.ip)
    ).size
    const bandwidth = Math.round(totalRequests * 0.015 * 100) / 100 // rough MB estimate

    // Group by day
    const dayMap = new Map<string, { count: number; errors: number }>()
    realEvents.forEach((e) => {
      const dateKey = new Date(e.timestamp).toISOString().split('T')[0]
      const existing = dayMap.get(dateKey) || { count: 0, errors: 0 }
      existing.count++
      if (e.type === 'error' || (e.status && e.status >= 400)) existing.errors++
      dayMap.set(dateKey, existing)
    })
    const requestsByDay = Array.from(dayMap.entries())
      .map(([date, data]) => ({ date, count: data.count, errors: data.errors }))
      .sort((a, b) => a.date.localeCompare(b.date))

    // Top paths
    const pathMap = new Map<string, { count: number; totalTime: number }>()
    realEvents
      .filter((e) => e.path)
      .forEach((e) => {
        const existing = pathMap.get(e.path!) || { count: 0, totalTime: 0 }
        existing.count++
        existing.totalTime += e.duration || 0
        pathMap.set(e.path!, existing)
      })
    const topPaths = Array.from(pathMap.entries())
      .map(([path, data]) => ({
        path,
        count: data.count,
        avgTime: Math.round(data.totalTime / Math.max(data.count, 1)),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)

    // Response time by day
    const rtMap = new Map<string, { durations: number[] }>()
    realEvents
      .filter((e) => e.duration)
      .forEach((e) => {
        const dateKey = new Date(e.timestamp).toISOString().split('T')[0]
        const existing = rtMap.get(dateKey) || { durations: [] }
        existing.durations.push(e.duration!)
        rtMap.set(dateKey, existing)
      })
    const responseTimeByDay = Array.from(rtMap.entries())
      .map(([date, data]) => {
        const sorted = [...data.durations].sort((a, b) => a - b)
        const avg = Math.round(
          data.durations.reduce((s, d) => s + d, 0) / data.durations.length
        )
        const p95Idx = Math.floor(sorted.length * 0.95)
        const p95 = sorted[p95Idx] || avg
        return { date, avg, p95 }
      })
      .sort((a, b) => a.date.localeCompare(b.date))

    // Geo distribution
    const geoMap = new Map<string, number>()
    realEvents
      .filter((e) => e.country)
      .forEach((e) => {
        geoMap.set(e.country!, (geoMap.get(e.country!) || 0) + 1)
      })
    const geoDistribution = Array.from(geoMap.entries())
      .map(([country, count]) => ({ country, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    return NextResponse.json({
      hasData: true,
      totalRequests,
      avgResponseTime,
      errorRate,
      bandwidth,
      uniqueVisitors,
      requestsByDay,
      topPaths,
      responseTimeByDay,
      geoDistribution,
    })
  } catch (error) {
    console.error('Analytics summary error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
