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

    const { searchParams } = new URL(request.url)
    const userId = searchParams.get('userId')
    const eventType = searchParams.get('eventType')
    const status = searchParams.get('status')
    const limit = parseInt(searchParams.get('limit') || '50')
    const offset = parseInt(searchParams.get('offset') || '0')

    // Non-admin users can only see their own logs.
    // NOTE: must accept super_admin too — checking only for 'admin' silently
    // restricted super admins to their own rows.
    const isAdminRole =
      decoded.role === 'admin' || decoded.role === 'super_admin'
    const where: Record<string, unknown> = {}
    if (!isAdminRole) {
      where.userId = decoded.userId
    } else if (userId) {
      where.userId = userId
    }

    if (eventType) where.eventType = eventType
    if (status) where.status = status

    const [logs, total] = await Promise.all([
      db.automationLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.automationLog.count({ where }),
    ])

    return NextResponse.json({
      logs: logs.map((l) => ({
        id: l.id,
        userId: l.userId,
        projectId: l.projectId,
        domainId: l.domainId,
        eventType: l.eventType,
        action: l.action,
        status: l.status,
        input: l.input ? JSON.parse(l.input) : null,
        output: l.output ? JSON.parse(l.output) : null,
        error: l.error,
        retryCount: l.retryCount,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
      })),
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    })
  } catch (error) {
    console.error('Automation logs error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
