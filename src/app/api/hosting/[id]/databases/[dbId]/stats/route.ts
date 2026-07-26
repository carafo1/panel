/**
 * GET /api/hosting/[id]/databases/[dbId]/stats
 * Dashboard summary for a tenant database (table/view counts, rows, size).
 */
import { NextResponse } from 'next/server'
import { resolveTenantDatabase, DbAccessError } from '@/lib/db-engine'
import { driverFor } from '@/lib/db-engine/driver'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; dbId: string }> }
) {
  const { id, dbId } = await params
  try {
    const { conn } = await resolveTenantDatabase(request, id, dbId)
    const stats = await driverFor(conn).getDatabaseStats(conn)
    return NextResponse.json({ stats })
  } catch (err) {
    if (err instanceof DbAccessError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to read stats' },
      { status: 500 }
    )
  }
}
