/**
 * GET /api/hosting/[id]/databases/[dbId]/pgadmin
 *
 * "Open pgAdmin" — verifies the caller owns this database, provisions their
 * pgAdmin account with EVERY PostgreSQL database they own (so the tree always
 * reflects reality), then hands off to pgAdmin with a short-lived token.
 *
 * `?json=1` returns `{ url }` so the panel can open it in a new tab.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { isAdmin } from '@/lib/security'
import { decrypt } from '@/lib/encryption'
import { logAudit } from '@/lib/audit'
import {
  provisionPgAdminTenant,
  mintHandoffToken,
  pgAdminUsernameFor,
  pgAdminBaseUrl,
  isPgAdminConfigured,
  type PgServerSpec,
} from '@/lib/db-engine/pgadmin-sso'

const isPostgres = (t: string) => ['postgres', 'postgresql'].includes((t || '').toLowerCase())

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; dbId: string }> }
) {
  const { id: projectId, dbId } = await params
  const wantsJson = new URL(request.url).searchParams.get('json') === '1'

  try {
    if (!isPgAdminConfigured()) {
      return NextResponse.json(
        { error: 'pgAdmin is not configured on this server' },
        { status: 503 }
      )
    }

    const auth = await authenticateRequest(request)
    if (!auth) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    // Ownership: admins may open any project's database, everyone else only
    // their own.
    const project = await db.project.findFirst({
      where: isAdmin(auth.role)
        ? { id: projectId }
        : { id: projectId, userId: auth.userId },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const target = await db.websiteDatabase.findFirst({ where: { id: dbId, projectId } })
    if (!target) {
      return NextResponse.json({ error: 'Database not found' }, { status: 404 })
    }
    if (!isPostgres(target.type)) {
      return NextResponse.json(
        { error: 'pgAdmin manages PostgreSQL databases only' },
        { status: 400 }
      )
    }

    // Register every PostgreSQL database owned by the database's owner, so the
    // tenant sees their whole estate rather than one server at a time.
    const ownerId = project.userId
    const rows = await db.websiteDatabase.findMany({
      where: { project: { userId: ownerId } },
      include: { project: { select: { name: true, slug: true } } },
      orderBy: { createdAt: 'asc' },
    })

    const servers: PgServerSpec[] = []
    for (const r of rows) {
      if (!isPostgres(r.type)) continue
      const host = r.externalRef || r.host
      if (!host) continue
      let password = ''
      try {
        password = decrypt(r.password)
      } catch {
        // A row whose secret cannot be decrypted would only produce a broken
        // entry with a password prompt — skip it rather than mislead.
        continue
      }
      servers.push({
        name: `${r.project?.name || r.name} (${r.name})`.slice(0, 60),
        host,
        port: r.port || 5432,
        database: r.name,
        user: r.username,
        password,
      })
    }

    if (servers.length === 0) {
      return NextResponse.json(
        { error: 'No PostgreSQL database credentials available to open' },
        { status: 409 }
      )
    }

    const username = pgAdminUsernameFor(ownerId)
    const prov = await provisionPgAdminTenant(username, servers)
    if (!prov.ok) {
      await logAudit({
        userId: auth.userId,
        action: 'db.pgadmin.open',
        resource: 'database',
        resourceId: dbId,
        req: request,
        status: 'failure',
        metadata: { error: prov.message },
      })
      return NextResponse.json({ error: prov.message }, { status: 500 })
    }

    const token = mintHandoffToken(username, ownerId)
    const url = `${pgAdminBaseUrl()}/apsamo-sso?token=${encodeURIComponent(token)}`

    await logAudit({
      userId: auth.userId,
      action: 'db.pgadmin.open',
      resource: 'database',
      resourceId: dbId,
      req: request,
      metadata: { database: target.name, projectId, servers: servers.length },
    })

    if (wantsJson) return NextResponse.json({ url, servers: servers.length })
    return NextResponse.redirect(url, 302)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to open pgAdmin' },
      { status: 500 }
    )
  }
}
