import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyPassword, generateToken, generateTwoFactorTempToken } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { withRateLimit } from '@/lib/rate-limit'

// Brute-force protection: 10 login attempts per IP per minute.
export const POST = withRateLimit(loginHandler, { limit: 10, windowMs: 60_000 })

async function loginHandler(request: Request) {
  try {
    const body = await request.json()
    const { email, password } = body

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      )
    }

    // Find user
    const user = await db.user.findUnique({ where: { email } })
    if (!user) {
      // Audit failed login (unknown user - no userId)
      await logAudit({
        action: 'user.login_failed',
        resource: 'user',
        req: request,
        status: 'failure',
        metadata: { email, reason: 'user_not_found' },
      })
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      )
    }

    // Verify password
    const isValid = await verifyPassword(password, user.password)
    if (!isValid) {
      // Audit failed login (bad password)
      await logAudit({
        userId: user.id,
        action: 'user.login_failed',
        resource: 'user',
        resourceId: user.id,
        req: request,
        status: 'failure',
        metadata: { email, reason: 'invalid_password' },
      })
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      )
    }

    // ── 2FA gate ────────────────────────────────────────────────────────
    // If the user has 2FA enabled, we do NOT issue the full auth token
    // yet. Instead we return a short-lived tempToken (5m) that the client
    // uses to complete the second factor via /api/auth/2fa/login-verify
    // (or /api/auth/2fa/verify-backup for a backup code).
    if (user.twoFactorEnabled && user.twoFactorSecret) {
      const tempToken = generateTwoFactorTempToken(user.id)
      return NextResponse.json({
        requiresTwoFactor: true,
        tempToken,
      })
    }

    // Generate JWT
    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    })

    // Audit successful login
    await logAudit({
      userId: user.id,
      action: 'user.login',
      resource: 'user',
      resourceId: user.id,
      req: request,
      metadata: { email: user.email, role: user.role, twoFactor: false },
    })

    return NextResponse.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
      },
      token,
    })
  } catch (error) {
    console.error('Login error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
