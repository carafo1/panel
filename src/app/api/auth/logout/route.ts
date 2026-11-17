import { NextResponse } from 'next/server'
import { verifyTokenFresh, extractTokenFromHeader, sessionIdOf, revokeSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { clearSession, clearSupportReturn } from '@/lib/session'

/**
 * POST /api/auth/logout
 *
 * Ends this device's session on the server (the token stops working
 * everywhere, not just in this browser), deletes the session cookie, and
 * records an audit entry. The proxy turns the session cookie into the
 * Authorization header, so the caller is identified as on every other route.
 */
export async function POST(request: Request) {
  try {
    const token = extractTokenFromHeader(request.headers.get('Authorization'))
    const decoded = token ? await verifyTokenFresh(token) : null

    if (decoded) {
      const sid = sessionIdOf(token)
      if (sid) await revokeSession(sid, decoded.userId, 'logout')
      await logAudit({
        userId: decoded.userId,
        action: 'user.logout',
        resource: 'user',
        resourceId: decoded.userId,
        req: request,
      })
    }

    // Also forget a remembered admin login from support access.
    return clearSupportReturn(clearSession(NextResponse.json({ message: 'Logged out successfully' })))
  } catch (error) {
    console.error('Logout error:', error)
    // Still end the browser session even if the server-side step failed.
    return clearSession(NextResponse.json({ error: 'Internal server error' }, { status: 500 }))
  }
}
