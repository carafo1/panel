import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { logAudit } from '@/lib/audit'
import { withRateLimit } from '@/lib/rate-limit'
import { cdnInfo, enableCdn } from '@/lib/cdn'
import { cdnFailure } from '@/lib/cdn-http'

/**
 * GET  /api/hosting/[id]/cdn   Cloudflare status for this website's domains
 * POST /api/hosting/[id]/cdn   { domain }  put a domain behind Cloudflare
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(request)
  if (!auth) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  const { id } = await params
  const access = await requireProjectAccess(auth, id, 'view')
  if (!access.ok) return access.response
  try {
    return NextResponse.json(await cdnInfo(id, auth), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return cdnFailure(error)
  }
}

async function postHandler(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(request)
  if (!auth) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  const { id } = await params
  const access = await requireProjectAccess(auth, id, 'configure')
  if (!access.ok) return access.response
  try {
    const body = (await request.json().catch(() => ({}))) as { domain?: unknown }
    const zone = await enableCdn(id, auth, body)
    await logAudit({ userId: auth.userId, action: 'project.cdn.enable', resource: 'project', resourceId: id, req: request, status: 'success', metadata: { domain: zone.domain } })
    return NextResponse.json({ zone }, { status: 201 })
  } catch (error) {
    return cdnFailure(error)
  }
}

export const POST = withRateLimit(postHandler, { limit: 5, windowMs: 60_000 })
