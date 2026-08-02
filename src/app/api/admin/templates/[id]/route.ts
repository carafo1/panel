/**
 * PATCH /api/admin/templates/[id]
 * Body: { action: "approve" | "reject" | "feature" | "unfeature" | "make_official", reason?: string }
 *
 * DELETE /api/admin/templates/[id]
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { isAdmin, sanitizeError } from '@/lib/security'
import { logAudit } from '@/lib/audit'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) return NextResponse.json({ error: 'Authorization required' }, { status: 401 })
    const decoded = await verifyTokenFresh(token)
    if (!decoded || !isAdmin(decoded.role)) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const { id } = await params
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const { action, reason } = body

    const template = await db.template.findUnique({ where: { id } })
    if (!template) return NextResponse.json({ error: 'Template not found' }, { status: 404 })

    let newStatus = template.status
    let updateData: Record<string, unknown> = {}

    switch (action) {
      case 'approve':
        newStatus = 'approved'
        updateData = { status: newStatus, rejectedReason: null }
        break
      case 'reject':
        newStatus = 'rejected'
        updateData = { status: newStatus, rejectedReason: reason || 'Does not meet marketplace guidelines' }
        break
      case 'feature':
        newStatus = 'featured'
        updateData = { status: newStatus, featuredAt: new Date(), isOfficial: true }
        break
      case 'unfeature':
        newStatus = 'approved'
        updateData = { status: newStatus, featuredAt: null, isOfficial: false }
        break
      case 'make_official':
        updateData = { isOfficial: true }
        break
      default:
        return NextResponse.json({ error: 'Invalid action. Use: approve, reject, feature, unfeature, make_official' }, { status: 400 })
    }

    await db.template.update({ where: { id }, data: updateData })

    await logAudit({
      userId: decoded.userId,
      action: `template.${action}`,
      resource: 'template',
      resourceId: id,
      req: request,
      metadata: { name: template.name, previousStatus: template.status, newStatus, reason },
    })

    return NextResponse.json({
      templateId: id,
      status: newStatus,
      message: `Template ${action}d successfully`,
    })
  } catch (error) {
    console.error('[admin/templates PATCH] error:', error)
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) return NextResponse.json({ error: 'Authorization required' }, { status: 401 })
    const decoded = await verifyTokenFresh(token)
    if (!decoded || !isAdmin(decoded.role)) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const { id } = await params
    const template = await db.template.findUnique({ where: { id } })
    if (!template) return NextResponse.json({ error: 'Template not found' }, { status: 404 })

    await db.template.delete({ where: { id } })

    await logAudit({
      userId: decoded.userId,
      action: 'template.delete',
      resource: 'template',
      resourceId: id,
      req: request,
      metadata: { name: template.name, slug: template.slug },
    })

    return NextResponse.json({ message: 'Template deleted' })
  } catch (error) {
    console.error('[admin/templates DELETE] error:', error)
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 })
  }
}
