import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  extractTokenFromHeader,
  verifyTokenFresh,
  sessionIdOf,
  revokeAllSessions,
  issueSession,
} from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { attachSession } from '@/lib/session'

/**
 * GET    /api/auth/sessions   the signed-in devices of the current user
 * DELETE /api/auth/sessions   sign out everywhere else (keeps this device)
 *
 * Login tokens only — an API key manages API keys, not browser sessions.
 */

async function currentUser(request: Request) {
  const token = extractTokenFromHeader(request.headers.get('Authorization'))
  const auth = token ? await verifyTokenFresh(token) : null
  return auth ? { auth, sid: sessionIdOf(token) } : null
}

export async function GET(request: Request) {
  const me = await currentUser(request)
  if (!me) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })

  const rows = await db.session.findMany({
    where: { userId: me.auth.userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: 'desc' },
    select: {
      id: true,
      createdAt: true,
      lastSeenAt: true,
      expiresAt: true,
      ipAddress: true,
      userAgent: true,
      impersonatedBy: true,
    },
  })

  return NextResponse.json(
    {
      sessions: rows.map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
        supportAccess: !!s.impersonatedBy,
        current: s.id === me.sid,
      }))
      // This device first, then most recently active.
      .sort((a, b) => Number(b.current) - Number(a.current)),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}

export async function DELETE(request: Request) {
  const me = await currentUser(request)
  if (!me) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  if (me.auth.impersonatedBy) {
    return NextResponse.json({ error: 'Not available during support access' }, { status: 403 })
  }

  await revokeAllSessions(me.auth.userId, 'sign_out_everywhere')
  const fresh = await issueSession(
    { userId: me.auth.userId, email: me.auth.email, role: me.auth.role },
    request
  )

  await logAudit({
    userId: me.auth.userId,
    action: 'user.sessions_revoked',
    resource: 'user',
    resourceId: me.auth.userId,
    req: request,
    metadata: { scope: 'all_other_devices' },
  })

  return attachSession(
    NextResponse.json({ message: 'Signed out on all other devices' }),
    fresh,
    request
  )
}
