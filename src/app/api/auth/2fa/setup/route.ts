import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { generateSecret, generateQRCode } from '@/lib/totp'

/**
 * POST /api/auth/2fa/setup
 *
 * Begins the 2FA enrollment flow for an authenticated user.
 * Generates a fresh TOTP secret (NOT yet persisted) and returns it along
 * with a QR code data URL and a human-friendly manual entry string.
 *
 * The secret is only persisted once the user proves they can generate a
 * valid token via /api/auth/2fa/verify. This prevents half-enrolled
 * states where a user generated a secret but never scanned it.
 *
 * Response:
 *   { secret, qrCode, manualEntry }
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

    const decoded = verifyToken(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
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
        { error: 'Two-factor authentication is already enabled. Disable it first to reconfigure.' },
        { status: 400 }
      )
    }

    // Generate a fresh secret. It is NOT saved here — the client must
    // POST it back to /api/auth/2fa/verify along with a valid token
    // before we persist it. This prevents half-enrolled states.
    const secret = generateSecret()
    const qrCode = await generateQRCode(secret, user.email)
    const manualEntry = secret

    return NextResponse.json({
      secret,
      qrCode,
      manualEntry,
    })
  } catch (error) {
    console.error('2FA setup error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
