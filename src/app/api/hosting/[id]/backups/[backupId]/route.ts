import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { isAdmin } from '@/lib/security'
import { logAudit } from '@/lib/audit'
import { downloadBackup, deleteBackup, restoreBackup } from '@/lib/vps'

/**
 * Project Backup Endpoint (single)
 * ================================
 *
 *   GET    /api/hosting/[id]/backups/[backupId]   — stream the backup file as a download
 *   DELETE /api/hosting/[id]/backups/[backupId]   — delete the backup
 *   POST   /api/hosting/[id]/backups/[backupId]   — perform an action
 *            body: { action: 'restore' }          — restore the backup
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; backupId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, backupId } = await params
    const project = await db.project.findFirst({ where: isAdmin(decoded.role) ? { id: projectId } : { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const { content, filename, size } = await downloadBackup(projectId, backupId)
    return new NextResponse(new Uint8Array(content), {
      status: 200,
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '_')}"`,
        'Content-Length': size.toString(),
      },
    })
  } catch (error) {
    const msg = 'Internal server error'
    console.error('Download backup error:', error)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; backupId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, backupId } = await params
    const project = await db.project.findFirst({ where: isAdmin(decoded.role) ? { id: projectId } : { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const result = await deleteBackup(projectId, backupId)
    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: 400 })
    }
    await logAudit({
      userId: decoded.userId,
      action: 'project.backup.delete',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { backupId },
    })
    return NextResponse.json({ message: result.message })
  } catch (error) {
    console.error('Delete backup error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; backupId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, backupId } = await params
    const project = await db.project.findFirst({ where: isAdmin(decoded.role) ? { id: projectId } : { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const body = await request.json().catch(() => ({}))
    if (body?.action !== 'restore') {
      return NextResponse.json(
        { error: 'Unknown action (expected { action: "restore" })' },
        { status: 400 }
      )
    }
    const result = await restoreBackup(projectId, backupId)
    await logAudit({
      userId: decoded.userId,
      action: 'project.backup.restore',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { backupId, ok: result.ok },
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: 500 })
    }
    return NextResponse.json(result)
  } catch (error) {
    const msg = 'Internal server error'
    console.error('Restore backup error:', error)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
