/**
 * POST /api/hosting/[id]/databases/[dbId]/query
 * Execute an ad-hoc SQL statement against a tenant database (the SQL editor).
 * body: { sql: string, maxRows?: number }
 *
 * Runs as the tenant's non-root user, so the database engine enforces which
 * operations are permitted. Reads and writes are both audited.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logAudit } from '@/lib/audit'
import { resolveTenantDatabase, DbAccessError } from '@/lib/db-engine'
import { runStatement, classifyCommand, isReadCommand } from '@/lib/db-engine/mariadb'

const bodySchema = z.object({
  sql: z.string().min(1, 'SQL is required').max(200_000),
  maxRows: z.number().int().positive().max(5000).optional(),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; dbId: string }> }
) {
  const { id, dbId } = await params
  let conn
  let auth
  try {
    ;({ conn, auth } = await resolveTenantDatabase(request, id, dbId))
  } catch (err) {
    if (err instanceof DbAccessError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await request.json())
  } catch (err) {
    const msg =
      err instanceof z.ZodError ? err.issues[0]?.message : 'Invalid request body'
    return NextResponse.json({ error: msg }, { status: 400 })
  }

  const command = classifyCommand(body.sql)
  try {
    const result = await runStatement(conn, body.sql, { maxRows: body.maxRows })
    await logAudit({
      userId: auth.userId,
      action: isReadCommand(command) ? 'db.query.read' : 'db.query.write',
      resource: 'database',
      resourceId: dbId,
      req: request,
      metadata: {
        database: conn.database,
        command,
        rowCount: result.rowCount,
        affectedRows: result.affectedRows,
        durationMs: result.durationMs,
      },
    })
    return NextResponse.json({ result })
  } catch (err) {
    // SQL errors (bad syntax, permission denied by the engine) land here.
    await logAudit({
      userId: auth.userId,
      action: isReadCommand(command) ? 'db.query.read' : 'db.query.write',
      resource: 'database',
      resourceId: dbId,
      req: request,
      status: 'failure',
      metadata: {
        database: conn.database,
        command,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    const anyErr = err as { message?: string; code?: string; sqlState?: string }
    return NextResponse.json(
      {
        error: anyErr.message || 'Query failed',
        code: anyErr.code,
        sqlState: anyErr.sqlState,
      },
      { status: 422 }
    )
  }
}
