import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sendPasswordResetEmail } from '@/lib/email'
import { withRateLimit } from '@/lib/rate-limit'
import crypto from 'crypto'

// Anti-abuse: 5 reset requests per IP per minute (stops enumeration + email spam).
export const POST = withRateLimit(forgotPasswordHandler, { limit: 5, windowMs: 60_000 })

async function forgotPasswordHandler(request: Request) {
  try {
    const body = await request.json()
    const { email } = body

    if (!email) {
      return NextResponse.json(
        { error: 'Email is required' },
        { status: 400 }
      )
    }

    // Find user by email
    const user = await db.user.findUnique({
      where: { email },
    })

    // Always return the same success message to prevent email enumeration.
    // Even if the user doesn't exist, we don't reveal that.
    const genericMessage =
      'If an account with that email exists, a reset link has been sent.'

    if (!user) {
      return NextResponse.json({ message: genericMessage })
    }

    // Generate a random reset token
    const resetToken = crypto.randomBytes(32).toString('hex')

    // Store the token in the emailVerificationToken field (repurposed for demo)
    // In production, you'd have a dedicated passwordResetToken field
    await db.user.update({
      where: { id: user.id },
      data: { emailVerificationToken: resetToken },
    })

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const resetUrl = `${appUrl}?reset_token=${resetToken}`

    // Demo log kept for local development visibility (also logged by email service in demo mode)
    console.log(`[email] Password reset for ${user.email}`)
    console.log(`[email] Reset link: ${resetUrl}`)

    // Send the real password-reset email.
    // In demo mode (no SMTP env vars) this simply logs to console.
    await sendPasswordResetEmail(user.email, resetUrl)

    // Security: do NOT return the reset token in the API response.
    return NextResponse.json({ message: genericMessage })
  } catch (error) {
    console.error('Forgot password error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
