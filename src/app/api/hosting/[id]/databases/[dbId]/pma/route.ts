/**
 * GET /api/hosting/[id]/databases/[dbId]/pma
 *
 * "Open phpMyAdmin" — verifies the caller owns this database, stages a
 * single-use 60s SSO ticket inside the phpMyAdmin container, and sends the
 * browser there. phpMyAdmin logs the customer in as their own non-root DB user,
 * with no database login form and no credentials in the URL.
 *
 * `?json=1` returns `{ url }` instead of redirecting, so the panel UI can open
 * the session in a new tab.
 */
import { NextResponse } from 'next/server'
import { logAudit } from '@/lib/audit'
import { resolveTenantDatabase, DbAccessError } from '@/lib/db-engine'
import { createPmaSession, isPmaConfigured } from '@/lib/db-engine/pma-sso'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; dbId: string }> }
) {
  const { id, dbId } = await params
  const wantsJson = new URL(request.url).searchParams.get('json') === '1'
  try {
    if (!isPmaConfigured()) {
      return NextResponse.json(
        { error: 'phpMyAdmin is not configured on this server' },
        { status: 503 }
      )
    }

    const { conn, auth, project } = await resolveTenantDatabase(request, id, dbId)

    const { url, expiresAt } = await createPmaSession(conn)

    await logAudit({
      userId: auth.userId,
      action: 'db.pma.open',
      resource: 'database',
      resourceId: dbId,
      req: request,
      metadata: { database: conn.database, projectId: project.id, expiresAt },
    })

    if (wantsJson) return NextResponse.json({ url, expiresAt })
    return NextResponse.redirect(url, 302)
  } catch (err) {
    if (err instanceof DbAccessError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    const message = err instanceof Error ? err.message : 'Failed to open phpMyAdmin'
    // `detail` carries the raw docker/stderr cause for support; the customer
    // only ever sees the friendly `message`.
    const detail = (err as { detail?: string })?.detail
    await logAudit({
      action: 'db.pma.open',
      resource: 'database',
      resourceId: dbId,
      req: request,
      status: 'failure',
      metadata: { error: message, detail },
    })
    // 503: the tool is unavailable, not a bad request from the customer.
    return NextResponse.json({ error: message }, { status: detail ? 503 : 500 })
  }
}
