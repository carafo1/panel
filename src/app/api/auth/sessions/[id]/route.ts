import { NextResponse } from 'next/server'
import { extractTokenFromHeader, verifyTokenFresh, sessionIdOf, revokeSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { clearSession } from '@/lib/session'

/**
 * DELETE /api/auth/sessions/[id]   sign out one device
 *
 * Only the owner's own sessions can be ended (a foreign id is a 404, so ids
 * cannot be probed). Ending the current session also clears this browser's
 * cookie — the same as signing out.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const token = extractTokenFromHeader(request.headers.get('Authorization'))
  const auth = token ? await verifyTokenFresh(token) : null
  if (!auth) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })

  const { id } = await params
  const ended = await revokeSession(id, auth.userId, 'user')
  if (!ended) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  await logAudit({
    userId: auth.userId,
    action: 'user.session_revoked',
    resource: 'user',
    resourceId: auth.userId,
    req: request,
    metadata: { sessionId: id },
  })

  const res = NextResponse.json({ message: 'Signed out on that device' })
  return id === sessionIdOf(token) ? clearSession(res) : res
}
