/**
 * GET /api/provisioning
 * =====================
 *
 * Lists recent provisioning jobs for the authenticated user, newest first.
 *
 * Query params:
 *   - status (optional): filter by job status — pending, running, success,
 *     failed, rolled_back, or "all" (default).
 *   - limit (optional): page size, default 50, max 100.
 *
 * Auth: any authenticated user (only their own jobs are returned).
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'

const VALID_STATUSES = new Set([
  'pending',
  'running',
  'success',
  'failed',
  'rolled_back',
])

export async function GET(request: Request) {
  try {
    const token = extractTokenFromHeader(
      request.headers.get('authorization') || ''
    )
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const user = verifyToken(token)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const status = (searchParams.get('status') || 'all').toLowerCase()
    const limitRaw = Number.parseInt(searchParams.get('limit') || '50', 10)
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 100)
      : 50

    const where: { userId: string; status?: string } = { userId: user.userId }
    if (status !== 'all' && VALID_STATUSES.has(status)) {
      where.status = status
    }

    const jobs = await db.provisioningJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        domainName: true,
        stack: true,
        includeHosting: true,
        includeEmail: true,
        status: true,
        currentStep: true,
        error: true,
        startedAt: true,
        completedAt: true,
        rollbackStartedAt: true,
        rollbackCompletedAt: true,
        createdAt: true,
        updatedAt: true,
        steps: {
          orderBy: { stepOrder: 'asc' },
          select: {
            id: true,
            stepName: true,
            stepOrder: true,
            status: true,
            duration: true,
            error: true,
          },
        },
      },
    })

    return NextResponse.json({
      jobs,
      total: jobs.length,
    })
  } catch (error) {
    console.error('[api/provisioning list] error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
