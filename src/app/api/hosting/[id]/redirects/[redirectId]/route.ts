import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { logAudit } from '@/lib/audit'
import { updateRedirect, deleteRedirect } from '@/lib/vps'

/**
 * Project Redirect Endpoint (single)
 * ===================================
 *
 *   PATCH  /api/hosting/[id]/redirects/[redirectId]  — update a redirect
 *              body: { fromPath?, toUrl?, statusCode?, matchQuery?, enabled? }
 *   DELETE /api/hosting/[id]/redirects/[redirectId]  — delete a redirect
 */

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; redirectId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, redirectId } = await params
    const access = await requireProjectAccess(decoded, projectId, 'configure')
    if (!access.ok) return access.response
    const existing = await db.redirect.findFirst({
      where: { id: redirectId, projectId },
    })
    if (!existing) {
      return NextResponse.json({ error: 'Redirect not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const patch: Record<string, unknown> = {}
    if (body?.fromPath !== undefined) patch.fromPath = body.fromPath
    if (body?.toUrl !== undefined) patch.toUrl = body.toUrl
    if (body?.statusCode !== undefined) patch.statusCode = Number(body.statusCode)
    if (body?.matchQuery !== undefined) patch.matchQuery = body.matchQuery
    if (body?.enabled !== undefined) patch.enabled = !!body.enabled

    const redirect = await updateRedirect(redirectId, patch)

    await logAudit({
      userId: decoded.userId,
      action: 'project.redirect.update',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { redirectId, fields: Object.keys(patch) },
    })

    return NextResponse.json({ redirect })
  } catch (error) {
    const msg = 'Internal server error'
    console.error('Update redirect error:', error)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; redirectId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, redirectId } = await params
    const access = await requireProjectAccess(decoded, projectId, 'configure')
    if (!access.ok) return access.response
    const existing = await db.redirect.findFirst({
      where: { id: redirectId, projectId },
    })
    if (!existing) {
      return NextResponse.json({ error: 'Redirect not found' }, { status: 404 })
    }

    await deleteRedirect(redirectId)

    await logAudit({
      userId: decoded.userId,
      action: 'project.redirect.delete',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { redirectId },
    })

    return NextResponse.json({ message: 'Redirect deleted' })
  } catch (error) {
    console.error('Delete redirect error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
