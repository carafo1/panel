import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'
import { isAdmin } from '@/lib/security'
import { logAudit } from '@/lib/audit'
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
    const row = await loadMigrationFor(id, decoded, isAdmin(decoded.role))
    if (!row) {
      return NextResponse.json({ error: 'Import not found' }, { status: 404 })
    }
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
    const row = await loadMigrationFor(id, decoded, isAdmin(decoded.role))
    if (!row) {
      return NextResponse.json({ error: 'Import not found' }, { status: 404 })
    }

    const result = await cancelMigration(id)

    await logAudit({
      userId: decoded.userId,
      action: 'migration.cancel',
      resource: 'migration',
      resourceId: id,
      req: request,
      metadata: { projectId: row.projectId },
    })

    const updated = await loadMigrationFor(id, decoded, isAdmin(decoded.role))
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
