import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sendPasswordResetEmail } from '@/lib/email'
import { withRateLimit } from '@/lib/rate-limit'
import { issuePasswordResetToken } from '@/lib/password-reset'

// Anti-abuse: 5 reset requests per IP per minute (stops enumeration + email spam).
export const POST = withRateLimit(forgotPasswordHandler, { limit: 5, windowMs: 60_000 })

/**
 * POST /api/auth/forgot-password   { email }
 *
 * Emails a single-use reset link that expires in 1 hour (lib/password-reset).
 * The answer is the same whether or not the account exists, so the endpoint
 * cannot be used to discover who has an account. The link is never logged.
 */
async function forgotPasswordHandler(request: Request) {
  try {
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 })
    }
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }

    const genericMessage = 'If an account with that email exists, a reset link has been sent.'

    const user = await db.user.findUnique({ where: { email }, select: { id: true, email: true } })
    if (!user) {
      return NextResponse.json({ message: genericMessage })
    }

    const resetToken = await issuePasswordResetToken(user.id)

    // Built from the configured app URL, never the request's Host header, so a
    // forged Host cannot point the emailed link at another site.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const resetUrl = `${appUrl}?reset_token=${resetToken}`

    await sendPasswordResetEmail(user.email, resetUrl)

    return NextResponse.json({ message: genericMessage })
  } catch (error) {
    console.error('Forgot password error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
