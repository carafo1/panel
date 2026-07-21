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

    // ── Account standing gate ───────────────────────────────────────────
    // Checked AFTER the password so we never reveal an account's status to
    // someone who can't authenticate as them. A suspended/fraud/closed
    // account gets a clear message rather than a confusing "invalid password".
    const accountStatus = (user as { status?: string }).status || 'active'
    if (accountStatus !== 'active') {
      await logAudit({
        userId: user.id,
        action: 'user.login_blocked',
        resource: 'user',
        resourceId: user.id,
        req: request,
        status: 'failure',
        metadata: { email, reason: `account_${accountStatus}` },
      })
      const messages: Record<string, string> = {
        suspended:
          'Your account is suspended. Please contact support to restore access.',
        fraud:
          'Your account is under review and access is temporarily disabled. Please contact support.',
        closed: 'This account has been closed.',
      }
      return NextResponse.json(
        { error: messages[accountStatus] || 'This account is not active.' },
        { status: 403 }
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
