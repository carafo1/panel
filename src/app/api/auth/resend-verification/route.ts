import { NextResponse } from 'next/server'
import { withRateLimit } from '@/lib/rate-limit'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { sendWelcomeEmail } from '@/lib/email'
import crypto from 'crypto'

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

    const user = await db.user.findUnique({
      where: { id: decoded.userId },
    })

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    if (user.emailVerified) {
      return NextResponse.json(
        { error: 'Email is already verified' },
        { status: 400 }
      )
    }

    // Generate new verification token
    const verificationToken = crypto.randomBytes(32).toString('hex')

    await db.user.update({
      where: { id: user.id },
      data: { emailVerificationToken: verificationToken },
    })

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const verificationUrl = `${appUrl}?verify_token=${verificationToken}`

    // Demo log kept for local development visibility (also logged by email service in demo mode)
    console.log(`[email] Verification email for ${user.email}`)
    console.log(`[email] Verification link: ${verificationUrl}`)

    // Resend the real welcome + verification email.
    // In demo mode (no SMTP env vars) this simply logs to console.
    await sendWelcomeEmail(user.email, user.name, verificationUrl)

    // Create notification
    await db.notification.create({
      data: {
        userId: user.id,
        title: 'Verification Email Sent',
        message: `A verification email has been sent to ${user.email}. Please check your inbox.`,
        type: 'info',
      },
    })

    return NextResponse.json({
      success: true,
      message: 'Verification email sent',
    })
  } catch (error) {
    console.error('Resend verification error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// Rate limited: see lib/rate-limit. 5 requests per 300s per IP.
export const POST = withRateLimit(postHandler, { limit: 5, windowMs: 300000 })
