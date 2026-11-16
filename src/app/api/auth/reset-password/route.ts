import { NextResponse } from 'next/server'
import { withRateLimit } from '@/lib/rate-limit'
import { db } from '@/lib/db'
import { hashPassword, revokeAllSessions } from '@/lib/auth'
import { consumePasswordResetToken } from '@/lib/password-reset'
import { logAudit } from '@/lib/audit'

/**
 * POST /api/auth/reset-password   { token, newPassword }
 *
 * Sets a new password with a link from /api/auth/forgot-password. The token
 * must be unexpired (1 hour) and unused; it is used up even if the request
 * then fails, so a link only ever works once. Every existing login of the
 * account is ended — whoever knew the old password may still be signed in.
 */
async function postHandler(request: Request) {
  try {
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 })
    }
    const { token, newPassword } = body as { token?: unknown; newPassword?: unknown }

    if (typeof token !== 'string' || !token || typeof newPassword !== 'string' || !newPassword) {
      return NextResponse.json({ error: 'Token and new password are required' }, { status: 400 })
    }
    // Validate BEFORE using up the token, so a too-short password doesn't
    // burn a working link.
    if (newPassword.length < 8) {
      return NextResponse.json({ error: 'New password must be at least 8 characters' }, { status: 400 })
    }

    const userId = await consumePasswordResetToken(token)
    if (!userId) {
      return NextResponse.json(
        { error: 'This reset link is invalid, expired or already used. Request a new one.' },
        { status: 400 }
      )
    }

    await db.user.update({
      where: { id: userId },
      // Following the emailed link proves the address works.
      data: { password: await hashPassword(newPassword), emailVerified: true },
    })

    await revokeAllSessions(userId, 'password_reset')

    await logAudit({
      userId,
      action: 'user.password_reset',
      resource: 'user',
      resourceId: userId,
      req: request,
    })

    return NextResponse.json({ message: 'Password reset successfully' })
  } catch (error) {
    console.error('Reset password error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// Rate limited: see lib/rate-limit. 10 requests per 60s per IP.
export const POST = withRateLimit(postHandler, { limit: 10, windowMs: 60000 })
