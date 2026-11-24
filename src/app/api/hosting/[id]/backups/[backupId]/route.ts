import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { logAudit } from '@/lib/audit'
import { openBackupDownload, BackupDownloadError, deleteBackup, restoreBackup } from '@/lib/vps'

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
    const access = await requireProjectAccess(decoded, projectId, 'data')
    if (!access.ok) return access.response

    // Streamed: archives can be far larger than the memory this host can
    // spare. The file name comes from the backup row, never from the request.
    const { stream, filename, size } = await openBackupDownload(projectId, backupId)
    const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_') || 'backup.tar.gz'
    return new NextResponse(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${safeName}"`,
        'Content-Length': size.toString(),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    if (error instanceof BackupDownloadError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error('Download backup error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
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
    const access = await requireProjectAccess(decoded, projectId, 'data')
    if (!access.ok) return access.response
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
    const access = await requireProjectAccess(decoded, projectId, 'data')
    if (!access.ok) return access.response
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
