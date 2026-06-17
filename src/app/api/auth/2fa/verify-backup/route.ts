import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { generateToken } from '@/lib/auth'
import { consumeBackupCode } from '@/lib/totp'

/**
 * POST /api/auth/2fa/verify-backup
 *
 * Login path for a user who cannot access their authenticator (e.g. lost
 * phone). They submit their email + one of their single-use backup codes.
 * If the code is valid we consume it (so it can never be used again) and
 * issue a full 7-day JWT.
 *
 * Body:
 *   { email: string, backupCode: string }
 *
 * Response:
 *   { token, user }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { email, backupCode } = body as { email?: string; backupCode?: string }

    if (!email || !backupCode) {
      return NextResponse.json(
        { error: 'Email and backup code are required' },
        { status: 400 }
      )
    }

    const user = await db.user.findUnique({
      where: { email: email.toLowerCase().trim() },
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
      // Return the same error as a normal bad-login to avoid leaking
      // whether the account exists or has 2FA enabled.
      return NextResponse.json(
        { error: 'Invalid email or backup code' },
        { status: 401 }
      )
    }

    const { valid, remaining } = await consumeBackupCode(
      backupCode,
      user.twoFactorBackupCodes
    )

    if (!valid) {
      return NextResponse.json(
        { error: 'Invalid email or backup code' },
        { status: 401 }
      )
    }

    // Burn the used backup code so it can never be reused.
    await db.user.update({
      where: { id: user.id },
      data: { twoFactorBackupCodes: remaining },
    })

    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    })

    return NextResponse.json({
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
    })
  } catch (error) {
    console.error('2FA backup verify error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
