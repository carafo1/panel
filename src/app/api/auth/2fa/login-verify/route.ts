import { NextResponse } from 'next/server'
import { withRateLimit } from '@/lib/rate-limit'
import { db } from '@/lib/db'
import { issueSession, verifyTwoFactorTempToken } from '@/lib/auth'
import { verifyToken as verifyTotpToken } from '@/lib/totp'
import { logAudit } from '@/lib/audit'
import { attachSession } from '@/lib/session'

/**
 * POST /api/auth/2fa/login-verify
 *
 * Second step of the 2FA login flow. The user submits the tempToken
 * returned from /api/auth/login (valid for 5 minutes) along with the
 * 6-digit TOTP code from their authenticator. If valid, we issue the
 * full 7-day JWT and return the user record — identical to a normal
 * login response.
 *
 * Body:
 *   { tempToken: string, token: string }
 *
 * Response:
 *   { token, user }
 */
async function postHandler(request: Request) {
  try {
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const { tempToken, token: totpToken } = body as {
      tempToken?: string
      token?: string
    }

    if (!tempToken || !totpToken) {
      return NextResponse.json(
        { error: 'Temporary token and verification code are required' },
        { status: 400 }
      )
    }

    const decoded = verifyTwoFactorTempToken(tempToken)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Your session has expired. Please sign in again.' },
        { status: 401 }
      )
    }

    const user = await db.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        avatar: true,
        emailVerified: true,
        twoFactorEnabled: true,
        twoFactorSecret: true,
        createdAt: true,
      },
    })

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      // Edge case: user disabled 2FA between the password step and now.
      return NextResponse.json(
        { error: 'Two-factor authentication is no longer enabled for this account' },
        { status: 400 }
      )
    }

    const isValid = verifyTotpToken(totpToken, user.twoFactorSecret)
    if (!isValid) {
      // Audit failed 2FA verification
      await logAudit({
        userId: user.id,
        action: 'user.login_failed',
        resource: 'user',
        resourceId: user.id,
        req: request,
        status: 'failure',
        metadata: { email: user.email, reason: 'invalid_2fa_code' },
      })
      return NextResponse.json(
        { error: 'Invalid verification code' },
        { status: 400 }
      )
    }

    const token = await issueSession(
      { userId: user.id, email: user.email, role: user.role },
      request
    )

    // Audit successful 2FA login
    await logAudit({
      userId: user.id,
      action: 'user.login',
      resource: 'user',
      resourceId: user.id,
      req: request,
      metadata: { email: user.email, role: user.role, twoFactor: true },
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
    console.error('2FA login verify error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// Rate limited: see lib/rate-limit. 10 requests per 60s per IP.
export const POST = withRateLimit(postHandler, { limit: 10, windowMs: 60000 })
