import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { sendWelcomeEmail } from '@/lib/email'
import { logAudit } from '@/lib/audit'
import crypto from 'crypto'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { name, email, password } = body

    if (!name || !email || !password) {
      return NextResponse.json(
        { error: 'Name, email, and password are required' },
        { status: 400 }
      )
    }

    if (password.length < 6) {
      return NextResponse.json(
        { error: 'Password must be at least 6 characters' },
        { status: 400 }
      )
    }

    // Check if user already exists
    const existingUser = await db.user.findUnique({ where: { email } })
    if (existingUser) {
      return NextResponse.json(
        { error: 'Email already registered' },
        { status: 409 }
      )
    }

    // Hash password
    const hashedPassword = await hashPassword(password)

    // Generate email verification token
    const verificationToken = crypto.randomBytes(32).toString('hex')

    // Create user
    const user = await db.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: 'user',
        emailVerified: false,
        emailVerificationToken: verificationToken,
      },
    })

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const verificationUrl = `${appUrl}?verify_token=${verificationToken}`

    // Demo log kept for local development visibility (also logged by email service in demo mode)
    console.log(`[email] Welcome email + verification for ${user.email}`)
    console.log(`[email] Verification link: ${verificationUrl}`)

    // Send the real welcome + verification email.
    // In demo mode (no SMTP env vars) this simply logs to console.
    await sendWelcomeEmail(user.email, user.name, verificationUrl)

    // Create welcome notification
    await db.notification.create({
      data: {
        userId: user.id,
        title: 'Welcome to APSAMO!',
        message: 'Your account has been created. Please verify your email address to get started.',
        type: 'info',
      },
    })

    // Audit successful registration
    await logAudit({
      userId: user.id,
      action: 'user.register',
      resource: 'user',
      resourceId: user.id,
      req: request,
      metadata: { email: user.email, name: user.name },
    })

    // Security: do NOT return the verification token or a session JWT.
    // The user must click the link in the email to verify their account,
    // then sign in normally.
    return NextResponse.json(
      {
        message:
          'Registration successful. Check your email for verification link.',
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('Registration error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
