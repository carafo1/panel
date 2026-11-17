import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { consumeVerificationToken } from '@/lib/email-verification'
import { withRateLimit } from '@/lib/rate-limit'

/**
 * GET /api/auth/verify-email?token=…
 *
 * Confirms an email address from the emailed link. Links are single-use and
 * expire 48 hours after sending (lib/email-verification); an expired one asks
 * the customer to request a new link from the banner in the panel.
 */
async function getHandler(request: Request) {
  try {
    const token = new URL(request.url).searchParams.get('token') || ''
    if (!token) {
      return NextResponse.json({ error: 'Verification token is required' }, { status: 400 })
    }

    const result = await consumeVerificationToken(token)
    if (!result.ok) {
      return NextResponse.json(
        {
          error:
            result.reason === 'expired'
              ? 'This verification link has expired. Sign in and use "Resend verification email" to get a new one.'
              : 'This verification link is invalid or was already used.',
        },
        { status: 400 }
      )
    }

    const user = await db.user.findUnique({
      where: { id: result.userId },
      select: { id: true, name: true, email: true, role: true },
    })

    await db.notification.create({
      data: {
        userId: result.userId,
        title: 'Email Verified',
        message: 'Your email address has been verified successfully. Welcome to Apsamo Technology!',
        type: 'success',
      },
    })

    return NextResponse.json({
      success: true,
      message: 'Email verified successfully',
      user: user ? { ...user, emailVerified: true } : null,
    })
  } catch (error) {
    console.error('Email verification error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export const GET = withRateLimit(getHandler, { limit: 20, windowMs: 60_000 })
