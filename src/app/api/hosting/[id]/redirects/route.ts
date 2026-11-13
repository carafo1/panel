import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { logAudit } from '@/lib/audit'
import { listRedirects, createRedirect } from '@/lib/vps'

/**
 * Project Redirects Endpoint (collection)
 * ========================================
 *
 *   GET  /api/hosting/[id]/redirects          — list all redirects
 *   POST /api/hosting/[id]/redirects          — create a new redirect
 *            body: { fromPath, toUrl, statusCode?, matchQuery?, enabled? }
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId } = await params
    const access = await requireProjectAccess(decoded, projectId, 'view')
    if (!access.ok) return access.response
    const redirects = await listRedirects(projectId)
    return NextResponse.json({ redirects })
  } catch (error) {
    console.error('List redirects error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId } = await params
    const access = await requireProjectAccess(decoded, projectId, 'configure')
    if (!access.ok) return access.response

    const body = await request.json().catch(() => ({}))
    const fromPath = typeof body?.fromPath === 'string' ? body.fromPath.trim() : ''
    const toUrl = typeof body?.toUrl === 'string' ? body.toUrl.trim() : ''
    const statusCode =
      body?.statusCode === 302 ? 302 : body?.statusCode === 301 ? 301 : 301
    const matchQuery =
      typeof body?.matchQuery === 'string' && body.matchQuery.trim()
        ? body.matchQuery.trim()
        : null
    const enabled = body?.enabled !== false

    if (!fromPath) {
      return NextResponse.json({ error: 'From path is required' }, { status: 400 })
    }
    if (!fromPath.startsWith('/')) {
      return NextResponse.json(
        { error: 'From path must start with "/"' },
        { status: 400 }
      )
    }
    if (!toUrl) {
      return NextResponse.json({ error: 'To URL is required' }, { status: 400 })
    }

    const redirect = await createRedirect(projectId, {
      fromPath,
      toUrl,
      statusCode,
      matchQuery,
      enabled,
    })

    await logAudit({
      userId: decoded.userId,
      action: 'project.redirect.create',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { redirectId: redirect.id, fromPath, toUrl, statusCode },
    })

    return NextResponse.json({ redirect }, { status: 201 })
  } catch (error) {
    const msg = 'Internal server error'
    console.error('Create redirect error:', error)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
