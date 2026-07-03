import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { maskSecret } from '@/lib/security'
import crypto from 'crypto'

export async function GET(request: Request) {
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

    const webhooks = await db.webhook.findMany({
      where: { userId: decoded.userId },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        _count: {
          select: { deliveries: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      webhooks: webhooks.map((w) => ({
        id: w.id,
        name: w.name,
        url: w.url,
        // SECURITY: mask the signing secret in list view — full secret is
        // returned only once at creation time (POST /webhooks).
        secret: w.secret ? maskSecret(w.secret) : null,
        events: JSON.parse(w.events),
        active: w.active,
        projectId: w.projectId,
        project: w.project
          ? {
              id: w.project.id,
              name: w.project.name,
              slug: w.project.slug,
            }
          : null,
        deliveryCount: w._count.deliveries,
        lastTriggeredAt: w.lastTriggeredAt?.toISOString() ?? null,
        createdAt: w.createdAt.toISOString(),
        updatedAt: w.updatedAt.toISOString(),
      })),
    })
  } catch (error) {
    console.error('List webhooks error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

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
    const { name, url, projectId, events, active } = body

    if (!name || name.trim().length === 0) {
      return NextResponse.json(
        { error: 'Webhook name is required' },
        { status: 400 }
      )
    }

    if (!url || url.trim().length === 0) {
      return NextResponse.json(
        { error: 'Webhook URL is required' },
        { status: 400 }
      )
    }

    // Validate URL format
    try {
      new URL(url)
    } catch {
      return NextResponse.json(
        { error: 'Invalid webhook URL format' },
        { status: 400 }
      )
    }

    if (!events || !Array.isArray(events) || events.length === 0) {
      return NextResponse.json(
        { error: 'At least one event type is required' },
        { status: 400 }
      )
    }

    // If projectId is provided, verify it belongs to the user
    if (projectId) {
      const project = await db.project.findFirst({
        where: { id: projectId, userId: decoded.userId },
      })
      if (!project) {
        return NextResponse.json(
          { error: 'Project not found' },
          { status: 404 }
        )
      }
    }

    // Generate a random secret for webhook signature verification
    const secret = `whsec_${crypto.randomBytes(32).toString('hex')}`

    const webhook = await db.webhook.create({
      data: {
        userId: decoded.userId,
        projectId: projectId || null,
        name: name.trim(),
        url: url.trim(),
        secret,
        events: JSON.stringify(events),
        active: active !== undefined ? active : true,
      },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    })

    return NextResponse.json(
      {
        webhook: {
          id: webhook.id,
          name: webhook.name,
          url: webhook.url,
          secret: webhook.secret,
          events: JSON.parse(webhook.events),
          active: webhook.active,
          projectId: webhook.projectId,
          project: webhook.project
            ? {
                id: webhook.project.id,
                name: webhook.project.name,
                slug: webhook.project.slug,
              }
            : null,
          deliveryCount: 0,
          lastTriggeredAt: null,
          createdAt: webhook.createdAt.toISOString(),
          updatedAt: webhook.updatedAt.toISOString(),
        },
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('Create webhook error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
