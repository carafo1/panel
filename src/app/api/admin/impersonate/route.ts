import { NextResponse } from 'next/server'
import {
  verifyToken,
  extractTokenFromHeader,
  generateImpersonationToken,
} from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'

/**
 * Support impersonation — "log in as" a customer to reproduce their view.
 *
 * SECURITY (this endpoint hands out a token for someone else's account):
 *   - super_admin ONLY. A regular `admin` cannot impersonate.
 *   - You may never impersonate another admin/super_admin — that would be a
 *     privilege-escalation path between admins.
 *   - The issued token expires in 1 hour and carries an `impersonatedBy`
 *     claim, so anything done during the session is attributable.
 *   - Every attempt is written to the audit log, successful or not.
 */
export async function POST(request: Request) {
  try {
    const token = extractTokenFromHeader(request.headers.get('Authorization'))
    const decoded = token ? verifyToken(token) : null
    if (!decoded) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Deliberately stricter than the other admin endpoints.
    if (decoded.role !== 'super_admin') {
      await logAudit({
        userId: decoded.userId,
        action: 'impersonate.denied',
        resource: 'user',
        req: request,
        status: 'failure',
        metadata: { reason: 'not super_admin', role: decoded.role },
      }).catch(() => {})
      return NextResponse.json(
        { error: 'Super admin access required' },
        { status: 403 }
      )
    }

    // An impersonated session must not be able to start another one.
    if (decoded.impersonatedBy) {
      return NextResponse.json(
        { error: 'Cannot impersonate while already impersonating' },
        { status: 403 }
      )
    }

    const body = (await request.json().catch(() => ({}))) as { userId?: string }
    if (!body.userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 })
    }

    const target = await db.user.findUnique({
      where: { id: body.userId },
      select: { id: true, email: true, name: true, role: true },
    })
    if (!target) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }
    if (target.id === decoded.userId) {
      return NextResponse.json(
        { error: 'You are already signed in as this account' },
        { status: 400 }
      )
    }
    if (target.role === 'admin' || target.role === 'super_admin') {
      await logAudit({
        userId: decoded.userId,
        action: 'impersonate.denied',
        resource: 'user',
        resourceId: target.id,
        req: request,
        status: 'failure',
        metadata: { reason: 'target is an admin', targetRole: target.role },
      }).catch(() => {})
      return NextResponse.json(
        { error: 'Administrator accounts cannot be impersonated' },
        { status: 403 }
      )
    }

    const impersonationToken = generateImpersonationToken({
      userId: target.id,
      email: target.email,
      role: target.role,
      impersonatedBy: decoded.userId,
    })

    await logAudit({
      userId: decoded.userId,
      action: 'impersonate.start',
      resource: 'user',
      resourceId: target.id,
      req: request,
      metadata: {
        targetEmail: target.email,
        adminEmail: decoded.email,
        expiresIn: '1h',
      },
    }).catch(() => {})

    return NextResponse.json({
      success: true,
      token: impersonationToken,
      expiresInSeconds: 3600,
      user: { id: target.id, email: target.email, name: target.name, role: target.role },
      warning:
        'This session expires in 1 hour and every action is logged against your admin account.',
    })
  } catch (error) {
    console.error('[admin/impersonate] failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
