import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { maskSecret } from '@/lib/security'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
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

    const { id } = await params

    const webhook = await db.webhook.findFirst({
      where: { id, userId: decoded.userId },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        deliveries: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    })

    if (!webhook) {
      return NextResponse.json(
        { error: 'Webhook not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({
      webhook: {
        id: webhook.id,
        name: webhook.name,
        url: webhook.url,
        // SECURITY: mask the signing secret — full secret only shown at creation
        secret: webhook.secret ? maskSecret(webhook.secret) : null,
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
        lastTriggeredAt: webhook.lastTriggeredAt?.toISOString() ?? null,
        createdAt: webhook.createdAt.toISOString(),
        updatedAt: webhook.updatedAt.toISOString(),
        recentDeliveries: webhook.deliveries.map((d) => ({
          id: d.id,
          event: d.event,
          statusCode: d.statusCode,
          success: d.success,
          duration: d.duration,
          createdAt: d.createdAt.toISOString(),
        })),
      },
    })
  } catch (error) {
    console.error('Get webhook error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
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

    const { id } = await params
    const body = await request.json()

    // Check if this is a delete request
    if (body._delete) {
      const webhook = await db.webhook.findFirst({
        where: { id, userId: decoded.userId },
      })

      if (!webhook) {
        return NextResponse.json(
          { error: 'Webhook not found' },
          { status: 404 }
        )
      }

      await db.webhook.delete({
        where: { id },
      })

      return NextResponse.json({
        message: 'Webhook deleted successfully',
      })
    }

    // Regular update
    const webhook = await db.webhook.findFirst({
      where: { id, userId: decoded.userId },
    })

    if (!webhook) {
      return NextResponse.json(
        { error: 'Webhook not found' },
        { status: 404 }
      )
    }

    const { name, url, projectId, events, active } = body

    // Validate URL if provided
    if (url !== undefined) {
      try {
        new URL(url)
      } catch {
        return NextResponse.json(
          { error: 'Invalid webhook URL format' },
          { status: 400 }
        )
      }
    }

    // If projectId is being changed, verify it belongs to the user
    if (projectId !== undefined && projectId !== null) {
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

    const updateData: Record<string, unknown> = {}
    if (typeof name === 'string' && name.trim().length > 0) updateData.name = name.trim()
    if (typeof url === 'string') updateData.url = url.trim()
    if (projectId !== undefined) updateData.projectId = projectId || null
    if (Array.isArray(events) && events.length > 0) updateData.events = JSON.stringify(events)
    if (typeof active === 'boolean') updateData.active = active

    const updated = await db.webhook.update({
      where: { id },
      data: updateData,
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

    return NextResponse.json({
      webhook: {
        id: updated.id,
        name: updated.name,
        url: updated.url,
        // SECURITY: mask the signing secret in PATCH response too
        secret: updated.secret ? maskSecret(updated.secret) : null,
        events: JSON.parse(updated.events),
        active: updated.active,
        projectId: updated.projectId,
        project: updated.project
          ? {
              id: updated.project.id,
              name: updated.project.name,
              slug: updated.project.slug,
            }
          : null,
        lastTriggeredAt: updated.lastTriggeredAt?.toISOString() ?? null,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
    })
  } catch (error) {
    console.error('Update webhook error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
