import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { triggerWebhookEvent } from '@/lib/webhook-delivery'

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

    const body = await request.json()
    const { event, payload, projectId } = body

    if (!event || typeof event !== 'string' || event.trim().length === 0) {
      return NextResponse.json(
        { error: 'Event name is required' },
        { status: 400 }
      )
    }

    if (payload !== undefined && payload !== null && typeof payload !== 'object') {
      return NextResponse.json(
        { error: 'Payload must be an object' },
        { status: 400 }
      )
    }

    // Deliver to all matching webhooks
    const results = await triggerWebhookEvent(
      decoded.userId,
      event.trim(),
      payload ?? {},
      projectId
    )

    // Filter out skipped results for the count
    const delivered = results.filter((r) => !r.skipped)

    return NextResponse.json({
      delivered: delivered.length,
      results: results.map((r) => ({
        id: r.id || undefined,
        webhookId: r.webhookId,
        event: r.event,
        statusCode: r.statusCode,
        success: r.success,
        duration: r.duration,
        skipped: r.skipped || false,
        skipReason: r.skipReason || undefined,
        createdAt: r.createdAt,
      })),
    })
  } catch (error) {
    console.error('Trigger webhook error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
