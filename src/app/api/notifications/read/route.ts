import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const decoded = verifyToken(token)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const body = await request.json()
    const { notificationIds, markAll } = body as {
      notificationIds?: string[]
      markAll?: boolean
    }

    if (markAll) {
      const result = await db.notification.updateMany({
        where: { userId: decoded.userId, read: false },
        data: { read: true },
      })
      return NextResponse.json({ marked: result.count })
    }

    if (notificationIds && Array.isArray(notificationIds) && notificationIds.length > 0) {
      const result = await db.notification.updateMany({
        where: {
          id: { in: notificationIds },
          userId: decoded.userId,
        },
        data: { read: true },
      })
      return NextResponse.json({ marked: result.count })
    }

    return NextResponse.json({ error: 'Provide notificationIds or markAll' }, { status: 400 })
  } catch (error) {
    console.error('Error marking notifications as read:', error)
    return NextResponse.json({ error: 'Failed to mark notifications as read' }, { status: 500 })
  }
}
