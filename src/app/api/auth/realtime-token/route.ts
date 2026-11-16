import { NextResponse } from 'next/server'
import { authenticateRequestFresh, generateRealtimeToken, sessionIdOf, extractTokenFromHeader } from '@/lib/auth'

/**
 * GET /api/auth/realtime-token
 *
 * A token for the browser's Socket.IO connection to the realtime service. The
 * session itself is in an httpOnly cookie the page cannot read; this token is
 * fetched on each connect, held only in memory, and accepted only by
 * /api/realtime/authorize (live logs, import progress, notifications).
 */
export async function GET(request: Request) {
  const auth = await authenticateRequestFresh(request)
  if (!auth) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  }
  // Tied to this login session: signing out also ends live updates.
  const sid = sessionIdOf(extractTokenFromHeader(request.headers.get('Authorization')))
  return NextResponse.json(
    { token: generateRealtimeToken(auth.userId, sid) },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
