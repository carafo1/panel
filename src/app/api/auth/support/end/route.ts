import { NextResponse } from 'next/server'
import {
  extractTokenFromHeader,
  verifyTokenFresh,
  sessionIdOf,
  revokeSession,
} from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import {
  attachSession,
  clearSession,
  clearSupportReturn,
  readSupportReturnCookie,
  requestSource,
} from '@/lib/session'

/**
 * POST /api/auth/support/end   "Return to admin"
 *
 * Ends the current support (impersonation) session on the server and puts the
 * super admin's own login back in place — if the remembered login is still
 * valid, still a super admin, and is the admin who started this session.
 * Otherwise the browser is simply signed out. Only the panel's own pages may
 * call it.
 */
export async function POST(request: Request) {
  if (requestSource(request) !== 'same-origin') {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
  }

  const token = extractTokenFromHeader(request.headers.get('Authorization'))
  const current = token ? await verifyTokenFresh(token) : null
  if (!current?.impersonatedBy) {
    return NextResponse.json({ error: 'No support session is active' }, { status: 400 })
  }

  const sid = sessionIdOf(token)
  if (sid) await revokeSession(sid, current.userId, 'support_ended')

  const returnToken = readSupportReturnCookie(request.headers.get('cookie'))
  const admin = returnToken ? await verifyTokenFresh(returnToken) : null
  const canReturn =
    !!admin && admin.role === 'super_admin' && admin.userId === current.impersonatedBy && !admin.impersonatedBy

  await logAudit({
    userId: current.impersonatedBy,
    action: 'impersonate.end',
    resource: 'user',
    resourceId: current.userId,
    req: request,
    metadata: { restoredAdminSession: canReturn },
  }).catch(() => {})

  const res = NextResponse.json({ returnedToAdmin: canReturn })
  clearSupportReturn(res)
  return canReturn ? attachSession(res, returnToken!, request) : clearSession(res)
}
