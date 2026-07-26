/**
 * GET /api/hosting/[id]/databases/[dbId]/tables/[table]/structure
 * Columns + indexes + foreign keys for a single table (the Structure tab).
 */
import { NextResponse } from 'next/server'
import { resolveTenantDatabase, DbAccessError } from '@/lib/db-engine'
import { getColumns, getIndexes, getForeignKeys } from '@/lib/db-engine/mariadb'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; dbId: string; table: string }> }
) {
  const { id, dbId, table } = await params
  try {
    const { conn } = await resolveTenantDatabase(request, id, dbId)
    const [columns, indexes, foreignKeys] = await Promise.all([
      getColumns(conn, table),
      getIndexes(conn, table),
      getForeignKeys(conn, table),
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
