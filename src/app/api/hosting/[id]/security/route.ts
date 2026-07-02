import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listIpBlocks, createIpBlock, validateIpAddress } from '@/lib/vps'

/**
 * Project IP Blocks / Security Endpoint (collection)
 * ===================================================
 *
 *   GET  /api/hosting/[id]/security          — list all IP block rules
 *   POST /api/hosting/[id]/security          — create a new IP block rule
 *            body: { ipAddress, action?, reason?, expiresAt? }
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
    const project = await db.project.findFirst({
      where: { id: projectId, userId: decoded.userId },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const blocks = await listIpBlocks(projectId)
    return NextResponse.json({ blocks })
  } catch (error) {
    console.error('List IP blocks error:', error)
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
    const project = await db.project.findFirst({
      where: { id: projectId, userId: decoded.userId },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const ipAddress = typeof body?.ipAddress === 'string' ? body.ipAddress.trim() : ''
    const action = body?.action === 'allow' ? 'allow' : 'deny'
    const reason =
      typeof body?.reason === 'string' && body.reason.trim()
        ? body.reason.trim().slice(0, 500)
        : null
    let expiresAt: Date | null = null
    if (typeof body?.expiresAt === 'string' && body.expiresAt.trim()) {
      const d = new Date(body.expiresAt)
      if (!Number.isNaN(d.getTime())) expiresAt = d
    } else if (body?.expiresAt instanceof Date) {
      expiresAt = body.expiresAt
    }
    const permanent = body?.permanent === true
    if (permanent) expiresAt = null

    if (!ipAddress) {
      return NextResponse.json({ error: 'IP address is required' }, { status: 400 })
    }
    const v = validateIpAddress(ipAddress)
    if (!v.ok) {
      return NextResponse.json({ error: v.message }, { status: 400 })
    }

    const block = await createIpBlock(projectId, {
      ipAddress,
      action,
      reason,
      expiresAt,
    })

    await logAudit({
      userId: decoded.userId,
      action: 'project.security.ipblock.create',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { blockId: block.id, ipAddress, action },
    })

    return NextResponse.json({ block }, { status: 201 })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Internal server error'
    console.error('Create IP block error:', error)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
