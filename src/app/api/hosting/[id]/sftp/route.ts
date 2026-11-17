import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { logAudit } from '@/lib/audit'
import { withRateLimit } from '@/lib/rate-limit'
import { sftpInfo, setSftpKeys, disableSftp, SftpError } from '@/lib/sftp-access'

/**
 * GET    /api/hosting/[id]/sftp   status, connection details and granted keys
 * PUT    /api/hosting/[id]/sftp   { keyIds: string[] }  turn on / change keys
 * DELETE /api/hosting/[id]/sftp   turn off
 *
 * Needs 'configure' — the same as the file manager, which SFTP replaces.
 */
function failure(error: unknown) {
  if (error instanceof SftpError) return NextResponse.json({ error: error.message }, { status: error.status })
  console.error('[sftp] failed:', error)
  return NextResponse.json({ error: 'SFTP operation failed' }, { status: 500 })
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(request)
  if (!auth) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  const { id } = await params
  const access = await requireProjectAccess(auth, id, 'configure')
  if (!access.ok) return access.response
  try {
    return NextResponse.json(await sftpInfo(id, auth), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return failure(error)
  }
}

async function putHandler(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(request)
  if (!auth) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  if (auth.impersonatedBy) return NextResponse.json({ error: 'Not available during support access' }, { status: 403 })
  const { id } = await params
  const access = await requireProjectAccess(auth, id, 'configure')
  if (!access.ok) return access.response
  try {
    const body = (await request.json().catch(() => ({}))) as { keyIds?: unknown }
    const info = await setSftpKeys(id, auth, body)
    await logAudit({ userId: auth.userId, action: 'project.sftp.grant', resource: 'project', resourceId: id, req: request, status: 'success', metadata: { keys: info.keys.length } })
    return NextResponse.json(info)
  } catch (error) {
    return failure(error)
  }
}

export const PUT = withRateLimit(putHandler, { limit: 10, windowMs: 60_000 })

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(request)
  if (!auth) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  const { id } = await params
  const access = await requireProjectAccess(auth, id, 'configure')
  if (!access.ok) return access.response
  try {
    const result = await disableSftp(id)
    await logAudit({ userId: auth.userId, action: 'project.sftp.revoke', resource: 'project', resourceId: id, req: request, status: 'success' })
    return NextResponse.json(result)
  } catch (error) {
    return failure(error)
  }
}
