import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  verifyTokenFresh,
  extractTokenFromHeader,
  invalidateUserAuthCache,
} from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { notifyAccountStatusChanged } from '@/lib/billing-notifications'

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

    // Check admin role (super_admin OR admin - backward compatible)
    if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }

    const users = await db.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        emailVerified: true,
        status: true,
        statusReason: true,
        createdAt: true,
        subscriptions: {
          include: { plan: true },
          where: { status: 'active' },
        },
        _count: {
          select: {
            projects: true,
            domains: true,
            payments: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        emailVerified: u.emailVerified,
        status: u.status || 'active',
        statusReason: u.statusReason || null,
        createdAt: u.createdAt,
        activeSubscription: u.subscriptions[0] ? {
          id: u.subscriptions[0].id,
          planName: u.subscriptions[0].plan.name,
          status: u.subscriptions[0].status,
        } : null,
        stats: {
          projects: u._count.projects,
          domains: u._count.domains,
          payments: u._count.payments,
        },
      })),
    })
  } catch (error) {
    console.error('Admin users error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

const ACCOUNT_STATUSES = ['active', 'suspended', 'fraud', 'closed'] as const

/**
 * PATCH /api/admin/users
 * Body: { userId, action: "set_status", status, reason? }
 *
 * Account standing is what actually stops a fraudulent or non-paying user:
 * login checks it, and /api/auth/me re-checks it so an in-flight session ends
 * on the next page load instead of surviving until the token expires.
 *
 * NOTE: this endpoint deliberately does NOT change roles or passwords.
 */
export async function PATCH(request: Request) {
  try {
    const token = extractTokenFromHeader(request.headers.get('Authorization'))
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
    if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }

    const body = (await request.json().catch(() => ({}))) as {
      userId?: string
      action?: string
      status?: string
      reason?: string
    }

    if ((body.action || 'set_status') !== 'set_status') {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
    if (!body.userId || !body.status) {
      return NextResponse.json(
        { error: 'userId and status are required' },
        { status: 400 }
      )
    }
    const status = body.status.toLowerCase()
    if (!ACCOUNT_STATUSES.includes(status as (typeof ACCOUNT_STATUSES)[number])) {
      return NextResponse.json(
        { error: `status must be one of: ${ACCOUNT_STATUSES.join(', ')}` },
        { status: 400 }
      )
    }

    const target = await db.user.findUnique({
      where: { id: body.userId },
      select: { id: true, email: true, role: true, status: true },
    })
    if (!target) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }
    // Locking yourself out is never the intent, and locking out the last
    // super admin would leave nobody able to undo it.
    if (target.id === decoded.userId && status !== 'active') {
      return NextResponse.json(
        { error: 'You cannot suspend or close your own account.' },
        { status: 400 }
      )
    }
    if (target.role === 'super_admin' && status !== 'active') {
      const otherActiveSupers = await db.user.count({
        where: {
          role: 'super_admin',
          status: 'active',
          id: { not: target.id },
        },
      })
      if (otherActiveSupers === 0) {
        return NextResponse.json(
          {
            error:
              'This is the only active super admin — suspending it would lock everyone out.',
          },
          { status: 400 }
        )
      }
    }

    await db.user.update({
      where: { id: target.id },
      data: {
        status,
        statusReason: body.reason?.trim() || null,
        statusChangedAt: new Date(),
      },
    })

    // After the write, so a concurrent request can't re-cache the old status.
    // This is what makes a suspension take effect on the next request rather
    // than whenever the token happens to expire.
    invalidateUserAuthCache(target.id)

    await logAudit({
      userId: decoded.userId,
      action: 'user.set_status',
      resource: 'user',
      resourceId: target.id,
      req: request,
      metadata: {
        email: target.email,
        from: target.status || 'active',
        to: status,
        reason: body.reason || null,
      },
    }).catch(() => {})

    await notifyAccountStatusChanged({
      userId: target.id,
      status,
      reason: body.reason || null,
    }).catch(() => {})

    return NextResponse.json({
      success: true,
      status,
      message:
        status === 'active'
          ? `${target.email} restored — they can sign in again.`
          : `${target.email} marked ${status}. Sign-in is now blocked and any active session ends on their next page load.`,
    })
  } catch (error) {
    console.error('Admin users PATCH error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
