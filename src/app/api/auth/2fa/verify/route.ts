import { NextResponse } from 'next/server'
import { withRateLimit } from '@/lib/rate-limit'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import {
  verifyToken as verifyTotpToken,
  generateBackupCodes,
  hashBackupCodes,
} from '@/lib/totp'

/**
 * POST /api/auth/2fa/verify
 *
 * Completes the 2FA enrollment flow. The authenticated user submits the
 * secret returned from /api/auth/2fa/setup along with the 6-digit token
 * shown by their authenticator app. If the token is valid we persist the
 * secret, enable 2FA, and generate 10 single-use backup codes (hashed
 * with bcrypt).
 *
 * Body:
 *   { secret: string, token: string }
 *
 * Response:
 *   { success: true, backupCodes: string[] }
 *
 * Backup codes are returned in plaintext ONLY here — they are stored
 * hashed and can never be retrieved again. The UI must prompt the user
 * to save them immediately.
 */
async function postHandler(request: Request) {
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
    const { secret, token: totpToken } = body as { secret?: string; token?: string }

    if (!secret || !totpToken) {
      return NextResponse.json(
        { error: 'Secret and token are required' },
        { status: 400 }
      )
    }

    const user = await db.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, twoFactorEnabled: true },
    })

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    if (user.twoFactorEnabled) {
      return NextResponse.json(
        { error: 'Two-factor authentication is already enabled' },
        { status: 400 }
      )
    }

    // Confirm the user can actually generate a valid token for this
    // secret before we persist anything.
    const isValid = verifyTotpToken(totpToken, secret)
    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid verification code. Make sure your device time is correct and try again.' },
        { status: 400 }
      )
    }

    // Generate, hash, and store backup codes. The plaintext versions are
    // returned to the caller exactly once.
    const backupCodes = generateBackupCodes(10)
    const hashedBackupCodes = await hashBackupCodes(backupCodes)

    await db.user.update({
      where: { id: user.id },
      data: {
        twoFactorSecret: secret,
        twoFactorEnabled: true,
        twoFactorBackupCodes: hashedBackupCodes,
      },
    })

    return NextResponse.json({
      success: true,
      backupCodes,
    })
  } catch (error) {
    console.error('2FA verify error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// Rate limited: see lib/rate-limit. 10 requests per 60s per IP.
export const POST = withRateLimit(postHandler, { limit: 10, windowMs: 60000 })
