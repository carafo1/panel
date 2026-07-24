/**
 * GET /api/hosting/[id]/databases/[dbId]/export?mode=full|structure|data
 * Streams a mariadb-dump of the tenant database as a downloadable .sql file.
 */
import { NextResponse } from 'next/server'
import { logAudit } from '@/lib/audit'
import { resolveTenantDatabase, DbAccessError } from '@/lib/db-engine'
import { dumpDatabase, type DumpMode } from '@/lib/db-engine/mariadb'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; dbId: string }> }
) {
  const { id, dbId } = await params
  try {
    const { conn, auth } = await resolveTenantDatabase(request, id, dbId)
    const modeParam = new URL(request.url).searchParams.get('mode')
    const mode: DumpMode =
      modeParam === 'structure' || modeParam === 'data' ? modeParam : 'full'

    const { sql, durationMs } = await dumpDatabase(conn, mode)

    await logAudit({
      userId: auth.userId,
      action: 'db.export',
      resource: 'database',
      resourceId: dbId,
      req: request,
      metadata: { database: conn.database, mode, bytes: sql.length, durationMs },
    })

    return new NextResponse(sql, {
      status: 200,
      headers: {
        'Content-Type': 'application/sql; charset=utf-8',
        'Content-Disposition': `attachment; filename="${conn.database}-${mode}.sql"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    if (err instanceof DbAccessError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Export failed' },
      { status: 500 }
    )
  }
}
