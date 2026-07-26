/**
 * POST /api/hosting/[id]/databases/[dbId]/tables/[table]/op
 * Run a table-level operation: { op: 'truncate'|'drop'|'rename'|'optimize'|'analyze', newName? }
 *
 * Lives under a dedicated `op/` child segment (not on `[table]` itself) because
 * a route handler directly on `[table]` shadows its nested `rows`/`structure`
 * routes. Runs as the tenant's non-root user; audited.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logAudit } from '@/lib/audit'
import { resolveTenantDatabase, DbAccessError } from '@/lib/db-engine'
import { driverFor } from '@/lib/db-engine/driver'

const bodySchema = z.object({
  op: z.enum(['truncate', 'drop', 'rename', 'optimize', 'analyze']),
  newName: z.string().max(64).optional(),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; dbId: string; table: string }> }
) {
  const { id, dbId, table } = await params
  try {
    const { conn, auth } = await resolveTenantDatabase(request, id, dbId)
    const body = bodySchema.parse(await request.json())
    const result = await driverFor(conn).tableOperation(conn, table, body.op, body.newName)
    await logAudit({
      userId: auth.userId,
      action: `db.table.${body.op}`,
      resource: 'database',
      resourceId: dbId,
      req: request,
      metadata: { database: conn.database, table, newName: body.newName },
    })
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof DbAccessError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    const anyErr = err as { message?: string; code?: string }
    return NextResponse.json(
      { error: anyErr.message || 'Operation failed', code: anyErr.code },
      { status: 422 }
    )
  }
}
