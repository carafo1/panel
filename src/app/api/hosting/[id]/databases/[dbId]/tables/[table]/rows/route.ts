/**
 * /api/hosting/[id]/databases/[dbId]/tables/[table]/rows
 *   GET    — paginated, typed rows for the Data Grid
 *   PATCH  — update one row by primary key  { key, changes }
 *   POST   — insert one row                 { values }
 *   DELETE — delete one row by primary key  { key }
 *
 * All row writes are keyed on the primary key (refused for PK-less tables) and
 * executed as the tenant's non-root user; every mutation is audited.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logAudit } from '@/lib/audit'
import { resolveTenantDatabase, DbAccessError } from '@/lib/db-engine'
import {
  getTableRows,
  updateRow,
  insertRow,
  deleteRow,
} from '@/lib/db-engine/mariadb'

type Ctx = { params: Promise<{ id: string; dbId: string; table: string }> }

function fail(err: unknown) {
  if (err instanceof DbAccessError) {
    return NextResponse.json({ error: err.message }, { status: err.status })
  }
  const anyErr = err as { message?: string; code?: string; sqlState?: string }
  return NextResponse.json(
    { error: anyErr.message || 'Request failed', code: anyErr.code, sqlState: anyErr.sqlState },
    { status: 422 }
  )
}

const rowMap = z.record(z.string(), z.unknown())

export async function GET(request: Request, { params }: Ctx) {
  const { id, dbId, table } = await params
  try {
    const { conn, auth } = await resolveTenantDatabase(request, id, dbId)
    const q = new URL(request.url).searchParams
    const result = await getTableRows(conn, table, {
      limit: q.get('limit') ? Number(q.get('limit')) : undefined,
      offset: q.get('offset') ? Number(q.get('offset')) : undefined,
      orderBy: q.get('orderBy') ?? undefined,
      orderDir: q.get('orderDir') === 'DESC' ? 'DESC' : 'ASC',
      filterColumn: q.get('filterColumn') ?? undefined,
      filterValue: q.get('filterValue') ?? undefined,
    })
    await logAudit({
      userId: auth.userId,
      action: 'db.table.browse',
      resource: 'database',
      resourceId: dbId,
      req: request,
      metadata: { database: conn.database, table, returned: result.rows.length },
    })
    return NextResponse.json(result)
  } catch (err) {
    return fail(err)
  }
}

export async function PATCH(request: Request, { params }: Ctx) {
  const { id, dbId, table } = await params
  try {
    const { conn, auth } = await resolveTenantDatabase(request, id, dbId)
    const body = z.object({ key: rowMap, changes: rowMap }).parse(await request.json())
    const r = await updateRow(conn, table, body.key, body.changes)
    await logAudit({
      userId: auth.userId,
      action: 'db.row.update',
      resource: 'database',
      resourceId: dbId,
      req: request,
      metadata: { table, affectedRows: r.affectedRows },
    })
    return NextResponse.json(r)
  } catch (err) {
    return fail(err)
  }
}

export async function POST(request: Request, { params }: Ctx) {
  const { id, dbId, table } = await params
  try {
    const { conn, auth } = await resolveTenantDatabase(request, id, dbId)
    const body = z.object({ values: rowMap }).parse(await request.json())
    const r = await insertRow(conn, table, body.values)
    await logAudit({
      userId: auth.userId,
      action: 'db.row.insert',
      resource: 'database',
      resourceId: dbId,
      req: request,
      metadata: { table, affectedRows: r.affectedRows },
    })
    return NextResponse.json(r)
  } catch (err) {
    return fail(err)
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  const { id, dbId, table } = await params
  try {
    const { conn, auth } = await resolveTenantDatabase(request, id, dbId)
    const body = z.object({ key: rowMap }).parse(await request.json())
    const r = await deleteRow(conn, table, body.key)
    await logAudit({
      userId: auth.userId,
      action: 'db.row.delete',
      resource: 'database',
      resourceId: dbId,
      req: request,
      metadata: { table, affectedRows: r.affectedRows },
    })
    return NextResponse.json(r)
  } catch (err) {
    return fail(err)
  }
}
