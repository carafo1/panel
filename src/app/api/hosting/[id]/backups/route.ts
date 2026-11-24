import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { logAudit } from '@/lib/audit'
import { createBackup, listBackups } from '@/lib/vps'
import { db } from '@/lib/db'

/** At most this many backups per website in BACKUP_WINDOW_MS. */
const BACKUPS_PER_WINDOW = 2
const BACKUP_WINDOW_MS = 10 * 60 * 1000

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
    const access = await requireProjectAccess(decoded, projectId, 'view')
    if (!access.ok) return access.response
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
    const access = await requireProjectAccess(decoded, projectId, 'data')
    if (!access.ok) return access.response

    // Each backup is a full archive of the site (up to 5 minutes of work on
    // the server, and disk space). Without a limit a script could fill the
    // disk or keep the server busy for every other customer.
    const recentBackups = await db.websiteBackup.count({
      where: { projectId, createdAt: { gt: new Date(Date.now() - BACKUP_WINDOW_MS) } },
    })
    if (recentBackups >= BACKUPS_PER_WINDOW) {
      return NextResponse.json(
        { error: 'A backup was just made for this website. Please wait a few minutes before creating another.' },
        { status: 429, headers: { 'Retry-After': String(BACKUP_WINDOW_MS / 1000) } }
      )
    }

    const body = await request.json().catch(() => ({}))
    const type = body?.type === 'pre-deploy' ? 'pre-deploy' : 'manual'
    const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : null

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
