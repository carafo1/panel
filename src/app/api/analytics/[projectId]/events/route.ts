import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const authHeader = req.headers.get('authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const payload = verifyToken(token)
    if (!payload) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const { projectId } = await params

    // Verify project ownership
    const project = await db.project.findUnique({
      where: { id: projectId },
    })
    if (!project || project.userId !== payload.userId) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const body = await req.json()
    const events = Array.isArray(body) ? body : [body]

    const created = []
    for (const event of events) {
      const { type, path, method, status, duration, country, city, userAgent, ip } = event

      if (!type) continue

      const analyticsEvent = await db.analyticsEvent.create({
        data: {
          projectId,
          type,
          path: path || null,
          method: method || null,
          status: status || null,
          duration: duration || null,
          country: country || null,
          city: city || null,
          userAgent: userAgent || null,
          ip: ip || null,
        },
      })
      created.push(analyticsEvent)
    }

    return NextResponse.json({ created: created.length }, { status: 201 })
  } catch (error) {
    console.error('Analytics events error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
