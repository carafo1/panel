import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'

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

    const decoded = verifyToken(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    // Check admin role (super_admin OR admin - backward compatible)
    if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')

    const where = status ? { status } : {}

    const jobs = await db.jobQueue.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })

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
    })
  } catch (error) {
    console.error('Admin jobs error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
