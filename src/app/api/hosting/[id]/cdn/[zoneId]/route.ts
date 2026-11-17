import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { logAudit } from '@/lib/audit'
import { withRateLimit } from '@/lib/rate-limit'
import { refreshCdn, updateCdn, purgeCdn, disableCdn } from '@/lib/cdn'
import { cdnFailure } from '@/lib/cdn-http'

type Ctx = { params: Promise<{ id: string; zoneId: string }> }

/**
 * POST   /api/hosting/[id]/cdn/[zoneId]   { action: 'refresh' | 'purge' }
 * PATCH  /api/hosting/[id]/cdn/[zoneId]   { securityLevel?, developmentMode? }
 * DELETE /api/hosting/[id]/cdn/[zoneId]   take the domain off Cloudflare
 */
async function postHandler(request: Request, { params }: Ctx) {
  const auth = await authenticateRequest(request)
  if (!auth) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  const { id, zoneId } = await params
  const body = (await request.json().catch(() => ({}))) as { action?: string }
  const access = await requireProjectAccess(auth, id, body.action === 'purge' ? 'deploy' : 'view')
  if (!access.ok) return access.response
  try {
    if (body.action === 'refresh') return NextResponse.json({ zone: await refreshCdn(id, zoneId) })
    if (body.action === 'purge') {
      await purgeCdn(id, zoneId)
      await logAudit({ userId: auth.userId, action: 'project.cdn.purge', resource: 'project', resourceId: id, req: request, status: 'success' })
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: "action must be 'refresh' or 'purge'" }, { status: 400 })
  } catch (error) {
    return cdnFailure(error)
  }
}
export const POST = withRateLimit(postHandler, { limit: 20, windowMs: 60_000 })

export async function PATCH(request: Request, { params }: Ctx) {
  const auth = await authenticateRequest(request)
  if (!auth) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  const { id, zoneId } = await params
  const access = await requireProjectAccess(auth, id, 'configure')
  if (!access.ok) return access.response
  try {
    const body = (await request.json().catch(() => ({}))) as { securityLevel?: unknown; developmentMode?: unknown }
    const zone = await updateCdn(id, zoneId, auth, body)
    await logAudit({ userId: auth.userId, action: 'project.cdn.update', resource: 'project', resourceId: id, req: request, status: 'success', metadata: { securityLevel: body.securityLevel, developmentMode: body.developmentMode } })
    return NextResponse.json({ zone })
  } catch (error) {
    return cdnFailure(error)
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  const auth = await authenticateRequest(request)
  if (!auth) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  const { id, zoneId } = await params
  const access = await requireProjectAccess(auth, id, 'configure')
  if (!access.ok) return access.response
  try {
    const r = await disableCdn(id, zoneId)
    await logAudit({ userId: auth.userId, action: 'project.cdn.disable', resource: 'project', resourceId: id, req: request, status: 'success' })
    return NextResponse.json(r)
  } catch (error) {
    return cdnFailure(error)
  }
}
