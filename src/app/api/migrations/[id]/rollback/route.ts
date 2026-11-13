import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { requireProjectAccess } from '@/lib/project-access'
import { rollbackMigration } from '@/lib/migration'
import { loadMigrationFor, toMigrationView } from '@/lib/migration/view'

/**
 * POST /api/migrations/[id]/rollback
 *
 * Undoes a completed import: restores the pre-import snapshot of the site
 * directory, drops the database that was created for it, removes the container
 * and proxy entry, and puts the project row back.
 *
 * A failing import rolls itself back automatically. This endpoint is for the
 * other case — the import succeeded technically, the customer looked at the
 * result, and wants their previous site returned.
 *
 * Unlike the other migration endpoints this one runs synchronously: a rollback
 * is fast (extract a tarball, remove a container) and the customer must know
 * whether their site came back before they leave the page.
 */

export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(
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

    const logLines: string[] = []
    const result = await rollbackMigration(id, {
      onLog: (line) => {
        logLines.push(line)
        console.log(`[migration ${id.slice(0, 8)}] ${line}`)
      },
    })

    await logAudit({
      userId: decoded.userId,
      action: 'migration.rollback',
      resource: 'migration',
      resourceId: id,
      req: request,
      metadata: { projectId: row.projectId, ok: result.ok },
    })

    const updated = await loadMigrationFor(id, decoded, true)

    return NextResponse.json(
      {
        ok: result.ok,
        message: result.message,
        log: logLines,
        migration: updated ? toMigrationView(updated) : null,
      },
      { status: result.ok ? 200 : 409 }
    )
  } catch (error) {
    console.error('Rollback migration error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
