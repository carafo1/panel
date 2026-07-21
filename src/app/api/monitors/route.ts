import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { createMonitor } from '@/lib/monitor'

/**
 * GET /api/monitors
 * List all uptime monitors owned by the authenticated user (via their
 * projects). Includes the parent project's name + subdomain so the UI can
 * show "Project → URL" rows.
 */
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

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const monitors = await db.uptimeMonitor.findMany({
      where: {
        project: { userId: decoded.userId },
      },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            subdomain: true,
            customDomain: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      monitors: monitors.map((m) => ({
        id: m.id,
        projectId: m.projectId,
        url: m.url,
        intervalSec: m.intervalSec,
        enabled: m.enabled,
        lastStatus: m.lastStatus,
        lastCheckedAt: m.lastCheckedAt,
        uptimePct: m.uptimePct,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        project: m.project,
      })),
    })
  } catch (error) {
    console.error('List monitors error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/monitors
 * Create a new uptime monitor for a project the user owns.
 * Body: { projectId: string, url: string, intervalSec?: number }
 */
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

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      )
    }

    const { projectId, url, intervalSec } = body as {
      projectId?: string
      url?: string
      intervalSec?: number
    }

    if (!projectId || !url) {
      return NextResponse.json(
        { error: 'projectId and url are required' },
        { status: 400 }
      )
    }

    // Normalize + validate the URL.
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      return NextResponse.json(
        { error: 'Invalid URL. Include the scheme (https://...).' },
        { status: 400 }
      )
    }
    if (!/^https?:$/.test(parsedUrl.protocol)) {
      return NextResponse.json(
        { error: 'Only http(s) URLs can be monitored' },
        { status: 400 }
      )
    }

    // Verify the user owns the project.
    const project = await db.project.findFirst({
      where: { id: projectId, userId: decoded.userId },
      select: { id: true, name: true },
    })
    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    // Validate interval (min 10s, max 1 day).
    const interval =
      typeof intervalSec === 'number' && intervalSec >= 10 && intervalSec <= 86400
        ? Math.floor(intervalSec)
        : 60

    // Prevent duplicate monitors for the same project + URL.
    const existing = await db.uptimeMonitor.findFirst({
      where: { projectId, url: parsedUrl.toString() },
      select: { id: true },
    })
    if (existing) {
      return NextResponse.json(
        { error: 'A monitor for this URL already exists on the project', id: existing.id },
        { status: 409 }
      )
    }

    const created = await createMonitor(projectId, parsedUrl.toString(), interval)

    const monitor = await db.uptimeMonitor.findUnique({
      where: { id: created.id },
      include: {
        project: {
          select: { id: true, name: true, subdomain: true, customDomain: true },
        },
      },
    })

    return NextResponse.json({ monitor }, { status: 201 })
  } catch (error) {
    console.error('Create monitor error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
