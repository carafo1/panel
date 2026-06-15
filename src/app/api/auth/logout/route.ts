import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'

/**
 * POST /api/auth/logout
 *
 * Stateless JWT logout. The client simply discards its token, but we use
 * this endpoint to record an audit-log entry so security teams can see
 * when a user explicitly signed out (vs. just let their token expire).
 */
export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    let userId: string | undefined
    if (token) {
      const decoded = verifyToken(token)
      if (decoded) {
        userId = decoded.userId
      }
    }

    // Always log the logout attempt - even if the token is invalid/expired
    // (the client-side store clears regardless). The userId may be undefined
    // for already-expired tokens.
    if (userId) {
      await logAudit({
        userId,
        action: 'user.logout',
        resource: 'user',
        resourceId: userId,
        req: request,
      })
    }

    return NextResponse.json({ message: 'Logged out successfully' })
  } catch (error) {
    console.error('Logout error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
