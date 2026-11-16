import { NextResponse } from 'next/server'
import { extractTokenFromHeader, verifyTokenFresh, issueSession } from '@/lib/auth'
import { attachSession, requestSource } from '@/lib/session'

/**
 * POST /api/auth/session   (Authorization: Bearer <session token>)
 *
 * One-time upgrade for browsers that signed in before sessions moved into an
 * httpOnly cookie: the page sends the token it still has in localStorage, gets
 * the cookie back, and deletes its copy. Without this every signed-in user
 * would be logged out by the update.
 *
 * Only the panel's own pages may call it, so another site cannot use it to
 * sign a visitor into an account of its choosing.
 */
export async function POST(request: Request) {
  if (requestSource(request) !== 'same-origin') {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
  }
  const token = extractTokenFromHeader(request.headers.get('Authorization'))
  const auth = token ? await verifyTokenFresh(token) : null
  if (!token || !auth) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  }
  // A fresh, revocable session (listed in Settings) rather than the old token.
  const session = await issueSession({ userId: auth.userId, email: auth.email, role: auth.role }, request)
  return attachSession(NextResponse.json({ ok: true }), session, request)
}
