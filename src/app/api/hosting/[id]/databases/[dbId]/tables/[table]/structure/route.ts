/**
 * GET /api/hosting/[id]/databases/[dbId]/tables/[table]/structure
 * Columns + indexes + foreign keys for a single table (the Structure tab).
 */
import { NextResponse } from 'next/server'
import { resolveTenantDatabase, DbAccessError } from '@/lib/db-engine'
import { driverFor } from '@/lib/db-engine/driver'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; dbId: string; table: string }> }
) {
  const { id, dbId, table } = await params
  try {
    const { conn } = await resolveTenantDatabase(request, id, dbId)
    const d = driverFor(conn)
    const [columns, indexes, foreignKeys] = await Promise.all([
      d.getColumns(conn, table),
      d.getIndexes(conn, table),
      d.getForeignKeys(conn, table),
    ])
    return NextResponse.json({ table, columns, indexes, foreignKeys })
  } catch (err) {
    if (err instanceof DbAccessError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to read structure' },
      { status: 500 }
    )
  }
}
