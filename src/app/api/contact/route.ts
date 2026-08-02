import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { withRateLimit } from '@/lib/rate-limit'

// Anti-spam: 5 contact submissions per IP per minute.
export const POST = withRateLimit(contactHandler, { limit: 5, windowMs: 60_000 })

async function contactHandler(request: Request) {
  try {
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const { name, email, subject, message } = body

    if (!name || !email || !message) {
      return NextResponse.json(
        { success: false, error: 'Name, email, and message are required' },
        { status: 400 }
      )
    }

    await db.contactMessage.create({
      data: {
        name: String(name).slice(0, 200),
        email: String(email).slice(0, 200),
        subject: subject ? String(subject).slice(0, 300) : null,
        message: String(message).slice(0, 5000),
      },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Contact form error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to submit message' },
      { status: 500 }
    )
  }
}
