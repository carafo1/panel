import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { createBackup, listBackups } from '@/lib/vps'

/**
 * Project Backups Endpoint (collection)
 * =====================================
 *
 *   GET  /api/hosting/[id]/backups            — list all backups for the project
 *   POST /api/hosting/[id]/backups            — create a new backup
 *            body: { type?: 'manual' | 'pre-deploy', note?: string }
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
    const project = await db.project.findFirst({ where: { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const backups = await listBackups(projectId)
    return NextResponse.json({ backups })
  } catch (error) {
    console.error('List backups error:', error)
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
    const project = await db.project.findFirst({ where: { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const type = body?.type === 'pre-deploy' ? 'pre-deploy' : 'manual'
    const note = typeof body?.note === 'string' ? body.note : null

    const result = await createBackup(projectId, { type, note })

    await logAudit({
      userId: decoded.userId,
      action: 'project.backup.create',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { filename: result.filename, status: result.status },
    })

    if (result.status === 'failed') {
      return NextResponse.json({ error: result.message }, { status: 500 })
    }

    return NextResponse.json(
      {
        backup: {
          id: result.id,
          filename: result.filename,
          sizeBytes: result.sizeBytes,
          status: result.status,
          message: result.message,
        },
      },
      { status: 201 }
    )
  } catch (error) {
    const msg = 'Internal server error'
    console.error('Create backup error:', error)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
