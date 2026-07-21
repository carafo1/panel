import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'

export async function GET(request: Request) {
  try {
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

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')

    const where: Record<string, unknown> = {}
    if (status) where.status = status

    // Non-admin users see all jobs (they're system-wide)
    // Admins can filter by status
    const [jobs, stats] = await Promise.all([
      db.jobQueue.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      db.jobQueue.groupBy({
        by: ['status'],
        _count: { status: true },
      }),
    ])

    const statusSummary = stats.reduce((acc, s) => {
      acc[s.status] = s._count.status
      return acc
    }, {} as Record<string, number>)

    return NextResponse.json({
      jobs: jobs.map((j) => ({
        id: j.id,
        type: j.type,
        payload: JSON.parse(j.payload),
        status: j.status,
        attempts: j.attempts,
        maxAttempts: j.maxAttempts,
        runAt: j.runAt,
        startedAt: j.startedAt,
        completedAt: j.completedAt,
        error: j.error,
        result: j.result ? JSON.parse(j.result) : null,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
      })),
      statusSummary,
    })
  } catch (error) {
    console.error('Automation jobs error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
