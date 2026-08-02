import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { verifyToken as verifyTotpToken } from '@/lib/totp'

/**
 * POST /api/auth/2fa/disable
 *
 * Disables 2FA for the authenticated user. Requires a valid TOTP token
 * (or, when the user has lost their authenticator, an admin-reset flow
 * would be required — not implemented here). This extra check prevents
 * an attacker who steals a session token from silently turning off 2FA.
 *
 * Body:
 *   { token: string }
 *
 * Response:
 *   { success: true }
 */
export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const { token: totpToken } = body as { token?: string }

    if (!totpToken) {
      return NextResponse.json(
        { error: 'Verification code is required' },
        { status: 400 }
      )
    }

    const user = await db.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, twoFactorEnabled: true, twoFactorSecret: true },
    })

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    if (!user.twoFactorEnabled) {
      return NextResponse.json(
        { error: 'Two-factor authentication is not enabled' },
        { status: 400 }
      )
    }

    if (!user.twoFactorSecret) {
      return NextResponse.json(
        { error: 'Two-factor secret is missing. Please contact support.' },
        { status: 400 }
      )
    }

    const isValid = verifyTotpToken(totpToken, user.twoFactorSecret)
    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid verification code' },
        { status: 400 }
      )
    }

    await db.user.update({
      where: { id: user.id },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactorBackupCodes: null,
      },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('2FA disable error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
