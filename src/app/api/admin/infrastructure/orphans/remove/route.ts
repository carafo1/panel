/**
 * POST /api/admin/infrastructure/orphans/remove
 * Body: { "serverId": string, "name": "deployhub-..." }
 *
 * Removes ONE orphan container (and the volumes it mounted) on one server,
 * only if at this moment it is still a deployhub-* container that no Project
 * or WebsiteDatabase refers to, and is older than 30 minutes. Every attempt
 * past validation is audit-logged, refusals included.
 *
 * Admin only (admin / super_admin, role re-read from the database).
 *   400 invalid body / name    401 no credentials    403 not an admin
 *   404 server or container not found
 *   409 referenced, too recent, or a simulated server
 */
import { NextResponse } from 'next/server'
import { requireAdminRole } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { removeOrphanContainer } from '@/lib/infra-reconcile'
import { invalidateCapacityCache } from '@/app/api/admin/capacity/capacity'

const SERVER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function denied(request: Request) {
  const hasCredentials =
    !!request.headers.get('Authorization') || !!request.headers.get('x-api-key')
  return hasCredentials
    ? NextResponse.json({ error: 'Admin access required', code: 'FORBIDDEN' }, { status: 403 })
    : NextResponse.json({ error: 'Authorization token required', code: 'UNAUTHENTICATED' }, { status: 401 })
}

export async function POST(request: Request) {
  const auth = await requireAdminRole(request)
  if (!auth) return denied(request)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'INVALID_BODY' }, { status: 400 })
  }
  const { serverId, name } = (body ?? {}) as Record<string, unknown>
  if (typeof serverId !== 'string' || !SERVER_ID_RE.test(serverId) || typeof name !== 'string' || name.length > 220) {
    return NextResponse.json(
      { error: 'serverId and name are required', code: 'INVALID_BODY' },
      { status: 400 }
    )
  }

  try {
    const result = await removeOrphanContainer({ serverId, name })
    await logAudit({
      userId: auth.userId,
      action: 'infrastructure.orphan_remove',
      resource: 'server',
      resourceId: serverId,
      req: request,
      status: result.ok ? 'success' : 'failure',
      metadata: result.ok
        ? { container: name, volumesRemoved: result.volumesRemoved, volumesKept: result.volumesKept }
        : { container: name, refused: result.code },
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: result.status })
    }
    invalidateCapacityCache()
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[admin/orphans/remove] failed:', message)
    await logAudit({
      userId: auth.userId,
      action: 'infrastructure.orphan_remove',
      resource: 'server',
      resourceId: serverId,
      req: request,
      status: 'failure',
      metadata: { container: name, error: message.slice(0, 200) },
    })
    return NextResponse.json(
      { error: 'Could not remove the container', code: 'REMOVE_FAILED' },
      { status: 500 }
    )
  }
}
