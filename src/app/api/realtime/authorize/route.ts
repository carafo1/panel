import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest, extractTokenFromHeader, verifyRealtimeTokenFresh } from '@/lib/auth'
import { getProjectAccess, type ProjectPermission } from '@/lib/project-access'
import { canViewTicket } from '@/lib/support'

/**
 * POST /api/realtime/authorize   { room }   (Authorization: Bearer <user token>)
 *
 * Asked by the realtime service (mini-services/realtime-service) before it
 * lets a browser join a Socket.IO room. The service used to let anyone join
 * any room, so knowing an id was enough to read another customer's live build
 * logs (which can contain secrets), import progress, or notifications.
 *
 * The answer comes from the same rules as the REST API:
 *   user:<id>        only that user
 *   project:<id>     'view' on the project
 *   deployment:<id>  'view' on the deployment's project
 *   migration:<id>   'data' on the import's project (same as its detail page)
 *
 * Response: 200 { ok: true, userId } | 401 | 403 { ok: false, error }.
 * Unknown room shapes are refused.
 */
//   ticket:<id>       the ticket's customer, or staff
//   ticketstaff:<id>  staff only (internal notes)
const ROOM = /^(user|project|deployment|migration|ticket|ticketstaff):([A-Za-z0-9_-]{1,64})$/

export async function POST(request: Request) {
  // Browsers send the realtime token from /api/auth/realtime-token (their
  // session is an httpOnly cookie they cannot read). A session token or API
  // key is still accepted for non-browser clients.
  const bearer = extractTokenFromHeader(request.headers.get('Authorization'))
  const auth = (bearer && (await verifyRealtimeTokenFresh(bearer))) || (await authenticateRequest(request))
  if (!auth) {
    return NextResponse.json({ ok: false, error: 'Invalid or expired token' }, { status: 401 })
  }

  const body = (await request.json().catch(() => null)) as { room?: unknown } | null
  const room = typeof body?.room === 'string' ? body.room : ''
  const match = ROOM.exec(room)
  if (!match) {
    return NextResponse.json({ ok: false, error: 'Unknown room' }, { status: 403 })
  }
  const [, kind, id] = match
  const deny = () => NextResponse.json({ ok: false, error: 'Not allowed' }, { status: 403 })

  if (kind === 'user') {
    return id === auth.userId ? NextResponse.json({ ok: true, userId: auth.userId }) : deny()
  }

  if (kind === 'ticket' || kind === 'ticketstaff') {
    const ok = await canViewTicket(id, { userId: auth.userId, role: auth.role }, kind === 'ticketstaff')
    return ok ? NextResponse.json({ ok: true, userId: auth.userId }) : deny()
  }

  let projectId: string | null = null
  let permission: ProjectPermission = 'view'
  if (kind === 'project') {
    projectId = id
  } else if (kind === 'deployment') {
    const d = await db.deployment.findUnique({ where: { id }, select: { projectId: true } })
    projectId = d?.projectId ?? null
  } else if (kind === 'migration') {
    const m = await db.siteMigration.findUnique({ where: { id }, select: { projectId: true } })
    projectId = m?.projectId ?? null
    permission = 'data'
  }
  if (!projectId) return deny()

  const access = await getProjectAccess(auth, projectId)
  if (!access?.can(permission)) return deny()
  return NextResponse.json({ ok: true, userId: auth.userId })
}
