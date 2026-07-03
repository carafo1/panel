/**
 * GET /api/provisioning/list
 * =========================
 *
 * Lists provisioning jobs, paginated.
 *
 * Auth: required. Regular users see only their own jobs; super_admin/admin
 * see all jobs (with an optional ?userId= filter).
 *
 * Query params:
 *   page     – 1-based page number (default 1)
 *   limit    – page size, capped at 100 (default 20)
 *   status   – filter by job status: pending|running|success|failed|rolled_back
 *   userId   – (admins only) filter to a specific user's jobs
 *
 * Response: { jobs: [...], total, page, limit, totalPages }
 */
import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { db } from '@/lib/db'

function isAdmin(role: string): boolean {
  return role === 'super_admin' || role === 'admin'
}

const VALID_STATUSES = new Set([
  'pending',
  'running',
  'success',
  'failed',
  'rolled_back',
])

export async function GET(request: Request) {
  try {
    // ── Auth ───────────────────────────────────────────────────────
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

    // ── Parse query params ─────────────────────────────────────────
    const url = new URL(request.url)
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
    const limit = Math.min(
      100,
      Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10) || 20)
    )
    const statusParam = url.searchParams.get('status')?.trim() || ''
    const statusFilter = VALID_STATUSES.has(statusParam) ? statusParam : undefined

    // Admins can scope to a specific user; regular users are always scoped
    // to themselves.
    const adminUser = isAdmin(user.role)
    const requestedUserId = url.searchParams.get('userId')?.trim() || ''
    const scopeUserId = adminUser && requestedUserId ? requestedUserId : undefined

    // Build the WHERE clause
    const where: Record<string, unknown> = {}
    if (!adminUser) {
      where.userId = user.userId
    } else if (scopeUserId) {
      where.userId = scopeUserId
    }
    if (statusFilter) {
      where.status = statusFilter
    }

    // ── Fetch jobs + total in parallel ─────────────────────────────
    const [total, jobs] = await Promise.all([
      db.provisioningJob.count({ where }),
      db.provisioningJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          userId: true,
          domainName: true,
          stack: true,
          includeEmail: true,
          includeHosting: true,
          status: true,
          currentStep: true,
          error: true,
          startedAt: true,
          completedAt: true,
          rollbackStartedAt: true,
          rollbackCompletedAt: true,
          createdAt: true,
          updatedAt: true,
          // Light summary of steps — just counts by status, no heavy JSON
          _count: {
            select: {
              steps: {
                where: { status: 'success' },
              },
            },
          },
        },
      }),
    ])

    const totalPages = Math.max(1, Math.ceil(total / limit))

    // Reshape _count → stepsCompleted for a cleaner consumer API
    const jobsClean = jobs.map((j) => {
      const { _count, ...rest } = j
      return {
        ...rest,
        stepsCompleted: _count?.steps ?? 0,
      }
    })

    return NextResponse.json({
      jobs: jobsClean,
      total,
      page,
      limit,
      totalPages,
    })
  } catch (error) {
    console.error('[api/provisioning/list] error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: 'Internal server error',
      },
      { status: 500 }
    )
  }
}
