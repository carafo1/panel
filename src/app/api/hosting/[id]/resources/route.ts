import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { getProjectResourceUsage, getProjectResourceHistory } from '@/lib/vps'

/**
 * Project Resources Endpoint
 * ==========================
 *
 *   GET /api/hosting/[id]/resources?hours=24   — current usage + history chart points
 *
 * Returns:
 *   {
 *     current: ResourceUsage,
 *     history: ResourceHistoryPoint[]
 *   }
 *
 * In demo mode, values are randomized within the project's allocated limits
 * so the panel's chart renders something alive without a real VPS.
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId } = await params
    const project = await db.project.findFirst({ where: { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const url = new URL(request.url)
    const hoursParam = parseInt(url.searchParams.get('hours') || '24', 10)
    const hours = Number.isFinite(hoursParam) && hoursParam > 0 && hoursParam <= 168 ? hoursParam : 24

    const current = await getProjectResourceUsage(projectId)
    if (!current) {
      return NextResponse.json({ current: null, history: [] })
    }
    const history = await getProjectResourceHistory(projectId, hours)

    return NextResponse.json({ current, history })
  } catch (error) {
    console.error('Get resources error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
