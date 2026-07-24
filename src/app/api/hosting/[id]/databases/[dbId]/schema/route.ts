/**
 * GET /api/hosting/[id]/databases/[dbId]/schema
 * Returns the Database Explorer tree (tables, views, routines, triggers) for a
 * tenant database. Tenant-scoped + audited via the Studio guard.
 */
import { NextResponse } from 'next/server'
import { logAudit } from '@/lib/audit'
import { resolveTenantDatabase, DbAccessError } from '@/lib/db-engine'
import { getSchemaTree } from '@/lib/db-engine/mariadb'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; dbId: string }> }
) {
  const { id, dbId } = await params
  try {
    const { conn, auth } = await resolveTenantDatabase(request, id, dbId)
    const tree = await getSchemaTree(conn)
    await logAudit({
      userId: auth.userId,
      action: 'db.schema.read',
      resource: 'database',
      resourceId: dbId,
      req: request,
      metadata: { database: conn.database, tables: tree.tables.length },
    })
    return NextResponse.json({ schema: tree })
  } catch (err) {
    if (err instanceof DbAccessError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to read schema' },
      { status: 500 }
    )
  }
}
