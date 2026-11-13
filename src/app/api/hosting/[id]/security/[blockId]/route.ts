import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { logAudit } from '@/lib/audit'
import { updateIpBlock, deleteIpBlock } from '@/lib/vps'

/**
 * Project IP Block Endpoint (single)
 * ===================================
 *
 *   PATCH  /api/hosting/[id]/security/[blockId]  — update an IP block rule
 *              body: { ipAddress?, action?, reason?, enabled?, expiresAt? }
 *   DELETE /api/hosting/[id]/security/[blockId]  — delete an IP block rule
 */

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; blockId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, blockId } = await params
    const access = await requireProjectAccess(decoded, projectId, 'configure')
    if (!access.ok) return access.response
    const existing = await db.ipBlock.findFirst({
      where: { id: blockId, projectId },
    })
    if (!existing) {
      return NextResponse.json({ error: 'IP block not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const patch: Record<string, unknown> = {}
    if (body?.ipAddress !== undefined) patch.ipAddress = body.ipAddress
    if (body?.action !== undefined) patch.action = body.action
    if (body?.reason !== undefined) patch.reason = body.reason
    if (body?.enabled !== undefined) patch.enabled = !!body.enabled
    if (body?.expiresAt !== undefined) {
      if (body.expiresAt === null || body.expiresAt === '') {
        patch.expiresAt = null
      } else if (typeof body.expiresAt === 'string') {
        const d = new Date(body.expiresAt)
        patch.expiresAt = Number.isNaN(d.getTime()) ? null : d
      }
    }
    if (body?.permanent === true) patch.expiresAt = null

    const block = await updateIpBlock(blockId, patch)

    await logAudit({
      userId: decoded.userId,
      action: 'project.security.ipblock.update',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { blockId, fields: Object.keys(patch) },
    })

    return NextResponse.json({ block })
  } catch (error) {
    const msg = 'Internal server error'
    console.error('Update IP block error:', error)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; blockId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, blockId } = await params
    const access = await requireProjectAccess(decoded, projectId, 'configure')
    if (!access.ok) return access.response
    const existing = await db.ipBlock.findFirst({
      where: { id: blockId, projectId },
    })
    if (!existing) {
      return NextResponse.json({ error: 'IP block not found' }, { status: 404 })
    }

    await deleteIpBlock(blockId)

    await logAudit({
      userId: decoded.userId,
      action: 'project.security.ipblock.delete',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { blockId, ipAddress: existing.ipAddress },
    })

    return NextResponse.json({ message: 'IP block removed' })
  } catch (error) {
    console.error('Delete IP block error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
