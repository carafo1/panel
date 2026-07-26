/**
 * POST /api/hosting/[id]/databases/[dbId]/import
 * Multipart upload of a .sql or .sql.gz file, executed against the tenant
 * database as its non-root user. Gzip is auto-detected (by extension or magic
 * bytes). Audited; refuses oversized files.
 */
import { NextResponse } from 'next/server'
import { gunzipSync } from 'zlib'
import { logAudit } from '@/lib/audit'
import { resolveTenantDatabase, DbAccessError } from '@/lib/db-engine'
import { driverFor } from '@/lib/db-engine/driver'

// Allow long-running imports where the platform honours it.
export const maxDuration = 300

const MAX_BYTES = 50 * 1024 * 1024 // 50 MB uploaded (pre-decompress)

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; dbId: string }> }
) {
  const { id, dbId } = await params
  try {
    const { conn, auth } = await resolveTenantDatabase(request, id, dbId)

    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file uploaded (field "file")' }, { status: 400 })
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `File too large — max ${Math.round(MAX_BYTES / 1024 / 1024)} MB` },
        { status: 413 }
      )
    }

    const buf = Buffer.from(await file.arrayBuffer())
    const isGz = file.name.endsWith('.gz') || (buf[0] === 0x1f && buf[1] === 0x8b)
    let sql: string
    try {
      sql = isGz ? gunzipSync(buf).toString('utf8') : buf.toString('utf8')
    } catch {
      return NextResponse.json({ error: 'Failed to decompress the .gz file' }, { status: 400 })
    }
    if (!sql.trim()) {
      return NextResponse.json({ error: 'The file is empty' }, { status: 400 })
    }

    const result = await driverFor(conn).importSql(conn, sql)

    await logAudit({
      userId: auth.userId,
      action: 'db.import',
      resource: 'database',
      resourceId: dbId,
      req: request,
      status: result.ok ? 'success' : 'failure',
      metadata: {
        database: conn.database,
        filename: file.name,
        bytes: file.size,
        gzip: isGz,
        error: result.error,
      },
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error || 'Import failed' }, { status: 422 })
    }
    return NextResponse.json({ ok: true, durationMs: result.durationMs })
  } catch (err) {
    if (err instanceof DbAccessError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Import failed' },
      { status: 500 }
    )
  }
}
