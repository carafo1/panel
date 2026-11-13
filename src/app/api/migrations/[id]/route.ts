import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { requireProjectAccess } from '@/lib/project-access'
import { cancelMigration } from '@/lib/migration'
import { loadMigrationFor, toMigrationView } from '@/lib/migration/view'

/**
 *   GET    /api/migrations/[id]   — full status, stages, and logs
 *   DELETE /api/migrations/[id]   — cancel a running import
 *
 * The GET is what the progress screen polls when the realtime socket is
 * unavailable, so it returns everything needed to render the page in one
 * request rather than making the client stitch several together.
 */

export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id } = await params
    // Loaded by id alone (loadMigrationFor's unscoped mode); who may act on it
    // is decided by the project check below.
    const row = await loadMigrationFor(id, decoded, true)
    if (!row) {
      return NextResponse.json({ error: 'Import not found' }, { status: 404 })
    }
    // Site imports replace files and databases: 'data' on the target project.
    const access = await requireProjectAccess(decoded, row.projectId, 'data')
    if (!access.ok) return access.response
    return NextResponse.json({ migration: toMigrationView(row) })
  } catch (error) {
    console.error('Get migration error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id } = await params
    const row = await loadMigrationFor(id, decoded, true)
    if (!row) {
      return NextResponse.json({ error: 'Import not found' }, { status: 404 })
    }
    // Site imports replace files and databases: 'data' on the target project.
    const access = await requireProjectAccess(decoded, row.projectId, 'data')
    if (!access.ok) return access.response

    const result = await cancelMigration(id)

    await logAudit({
      userId: decoded.userId,
      action: 'migration.cancel',
      resource: 'migration',
      resourceId: id,
      req: request,
      metadata: { projectId: row.projectId },
    })

    const updated = await loadMigrationFor(id, decoded, true)
    return NextResponse.json(
      {
        ok: result.ok,
        message: result.message,
        migration: updated ? toMigrationView(updated) : null,
      },
      { status: result.ok ? 200 : 409 }
    )
  } catch (error) {
    console.error('Cancel migration error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
