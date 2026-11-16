import { NextResponse } from 'next/server'
import { withRateLimit } from '@/lib/rate-limit'
import { db } from '@/lib/db'
import { issueSession, verifyTwoFactorTempToken } from '@/lib/auth'
import { consumeBackupCode } from '@/lib/totp'
import { logAudit } from '@/lib/audit'
import { attachSession } from '@/lib/session'

/**
 * POST /api/auth/2fa/verify-backup
 *
 * Second step of a 2FA login for a user who cannot reach their authenticator
 * (e.g. lost phone): a single-use backup code takes the place of the 6-digit
 * code.
 *
 * SECURITY: a backup code replaces the SECOND factor, never the password. This
 * endpoint used to accept `{ email, backupCode }` alone, so a leaked backup
 * code was a full login with no password at all. It now requires the
 * `tempToken` that /api/auth/login issues only after the password checks out —
 * the same proof /api/auth/2fa/login-verify requires.
 *
 * Body:     { tempToken: string, backupCode: string }
 * Response: { token, user } and the session cookie
 */
async function postHandler(request: Request) {
  try {
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 })
    }
    const { tempToken, backupCode } = body as { tempToken?: string; backupCode?: string }

    if (!tempToken || !backupCode) {
      return NextResponse.json(
        { error: 'Sign in with your password first, then enter a backup code' },
        { status: 400 }
      )
    }

    const pending = verifyTwoFactorTempToken(tempToken)
    if (!pending) {
      return NextResponse.json({ error: 'Your session has expired. Please sign in again.' }, { status: 401 })
    }

    const user = await db.user.findUnique({
      where: { id: pending.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        avatar: true,
        emailVerified: true,
        twoFactorEnabled: true,
        twoFactorBackupCodes: true,
        createdAt: true,
      },
    })

    if (!user || !user.twoFactorEnabled || !user.twoFactorBackupCodes) {
      return NextResponse.json({ error: 'Invalid backup code' }, { status: 401 })
    }

    const { valid, remaining } = await consumeBackupCode(backupCode, user.twoFactorBackupCodes)

    if (!valid) {
      await logAudit({
        userId: user.id,
        action: 'user.login_failed',
        resource: 'user',
        resourceId: user.id,
        req: request,
        status: 'failure',
        metadata: { email: user.email, reason: 'invalid_backup_code' },
      })
      return NextResponse.json({ error: 'Invalid backup code' }, { status: 401 })
    }

    // Burn the used backup code so it can never be reused.
    await db.user.update({
      where: { id: user.id },
      data: { twoFactorBackupCodes: remaining },
    })

    const token = await issueSession({ userId: user.id, email: user.email, role: user.role }, request)

    await logAudit({
      userId: user.id,
      action: 'user.login',
      resource: 'user',
      resourceId: user.id,
      req: request,
      metadata: { email: user.email, role: user.role, twoFactor: true, method: 'backup_code' },
    })

    return attachSession(
      NextResponse.json({
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          avatar: user.avatar,
          emailVerified: user.emailVerified,
          createdAt: user.createdAt,
        },
      }),
      token,
      request
    )
  } catch (error) {
    console.error('2FA backup verify error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// Rate limited: see lib/rate-limit. 10 requests per 60s per IP.
export const POST = withRateLimit(postHandler, { limit: 10, windowMs: 60000 })
