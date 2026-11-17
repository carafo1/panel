import { NextResponse } from 'next/server'
import { verifyTokenFresh, extractTokenFromHeader, issueSession } from '@/lib/auth'
import { attachSession, attachSupportReturn, requestSource } from '@/lib/session'
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
    const decoded = token ? await verifyTokenFresh(token) : null
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

    const body = (await request.json().catch(() => ({}))) as { userId?: string; switchSession?: boolean }
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

    // A real session (1 hour): it shows in the customer's session list as
    // support access, and the customer — or a password change — can end it.
    const impersonationToken = await issueSession(
      { userId: target.id, email: target.email, role: target.role },
      request,
      { impersonatedBy: decoded.userId, ttlSeconds: 3600 }
    )

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

    const payload = {
      success: true,
      expiresInSeconds: 3600,
      user: { id: target.id, email: target.email, name: target.name, role: target.role },
      warning:
        'This session expires in 1 hour and every action is logged against your admin account.',
    }

    // From the admin panel itself: switch THIS browser into the support
    // session and keep the admin's own login aside for "Return to admin".
    // The token never reaches page scripts.
    if (body.switchSession === true) {
      if (requestSource(request) !== 'same-origin') {
        return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
      }
      const res = NextResponse.json(payload)
      attachSession(res, impersonationToken, request)
      attachSupportReturn(res, token!)
      return res
    }

    // API clients get the token to use as a bearer header.
    return NextResponse.json({ ...payload, token: impersonationToken })
  } catch (error) {
    console.error('[admin/impersonate] failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
