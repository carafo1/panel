import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { logAudit } from '@/lib/audit'
import { withRateLimit } from '@/lib/rate-limit'
import { stagingInfo, createStaging, syncFromLive, pushToLive, deleteStaging, StagingError } from '@/lib/staging'

/**
 * Staging for a live website ([id] is always the LIVE site).
 *
 * GET    /api/hosting/[id]/staging                  what's possible + the staging site
 * POST   /api/hosting/[id]/staging                  { action: 'create', branch? }
 *                                                   { action: 'sync', database? }    refresh staging from live
 *                                                   { action: 'push', database? }    push staging to live
 * DELETE /api/hosting/[id]/staging                  remove the staging site
 *
 * Creating/refreshing/removing needs 'configure'; pushing to live overwrites
 * the live site's content, so it needs 'data' (the same as restoring a backup).
 */
function failure(error: unknown) {
  if (error instanceof StagingError) return NextResponse.json({ error: error.message }, { status: error.status })
  console.error('[staging] failed:', error)
  return NextResponse.json({ error: 'Staging operation failed' }, { status: 500 })
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const decoded = await authenticateRequest(request)
  if (!decoded) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  const { id } = await params
  const access = await requireProjectAccess(decoded, id, 'view')
  if (!access.ok) return access.response
  try {
    return NextResponse.json(await stagingInfo(id, decoded), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return failure(error)
  }
}

async function postHandler(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const decoded = await authenticateRequest(request)
  if (!decoded) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  const { id } = await params
  const body = (await request.json().catch(() => ({}))) as { action?: string; branch?: unknown; database?: unknown }
  const action = body.action
  if (action !== 'create' && action !== 'sync' && action !== 'push') {
    return NextResponse.json({ error: "action must be 'create', 'sync' or 'push'" }, { status: 400 })
  }
  const access = await requireProjectAccess(decoded, id, action === 'push' ? 'data' : 'configure')
  if (!access.ok) return access.response
  try {
    const result =
      action === 'create'
        ? { staging: await createStaging(id, decoded, { branch: body.branch }) }
        : action === 'sync'
          ? await syncFromLive(id, decoded, { database: body.database })
          : await pushToLive(id, decoded, { database: body.database })
    await logAudit({
      userId: decoded.userId,
      action: `project.staging.${action}`,
      resource: 'project',
      resourceId: id,
      req: request,
      status: 'success',
      metadata: { database: body.database === true || (action !== 'push' && body.database !== false) },
    })
    return NextResponse.json(result, { status: action === 'create' ? 201 : 202 })
  } catch (error) {
    return failure(error)
  }
}

export const POST = withRateLimit(postHandler, { limit: 10, windowMs: 60_000 })

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const decoded = await authenticateRequest(request)
  if (!decoded) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  const { id } = await params
  const access = await requireProjectAccess(decoded, id, 'configure')
  if (!access.ok) return access.response
  try {
    const result = await deleteStaging(id)
    await logAudit({ userId: decoded.userId, action: 'project.staging.delete', resource: 'project', resourceId: id, req: request, status: 'success' })
    return NextResponse.json(result)
  } catch (error) {
    return failure(error)
  }
}
