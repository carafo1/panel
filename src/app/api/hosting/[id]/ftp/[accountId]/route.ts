import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { logAudit } from '@/lib/audit'
import { getFtpAccount, updateFtpAccount, deleteFtpAccount } from '@/lib/vps'

/**
 * Project FTP Account Endpoint (single)
 * ======================================
 *
 *   GET    /api/hosting/[id]/ftp/[accountId]?reveal=true  — single account (reveal password)
 *   PATCH  /api/hosting/[id]/ftp/[accountId]              — update account
 *              body: { password?, directory?, readOnly?, quotaMB?, enabled? }
 *   DELETE /api/hosting/[id]/ftp/[accountId]              — delete account
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; accountId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, accountId } = await params
    const access = await requireProjectAccess(decoded, projectId, 'data')
    if (!access.ok) return access.response
    const url = new URL(request.url)
    const reveal = url.searchParams.get('reveal') === 'true'
    const account = await getFtpAccount(projectId, accountId, reveal)
    if (!account) {
      return NextResponse.json({ error: 'FTP account not found' }, { status: 404 })
    }
    return NextResponse.json({ account })
  } catch (error) {
    console.error('Get FTP account error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; accountId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, accountId } = await params
    const access = await requireProjectAccess(decoded, projectId, 'data')
    if (!access.ok) return access.response

    const body = await request.json().catch(() => ({}))
    const patch: Record<string, unknown> = {}
    if (body?.password !== undefined) patch.password = body.password
    if (body?.directory !== undefined) patch.directory = body.directory
    if (body?.readOnly !== undefined) patch.readOnly = !!body.readOnly
    if (body?.quotaMB !== undefined) {
      patch.quotaMB =
        body.quotaMB === null || body.quotaMB === ''
          ? null
          : Number(body.quotaMB)
    }
    if (body?.enabled !== undefined) patch.enabled = !!body.enabled

    const account = await updateFtpAccount(projectId, accountId, patch)

    await logAudit({
      userId: decoded.userId,
      action: 'project.ftp.update',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { accountId, fields: Object.keys(patch) },
    })

    return NextResponse.json({ account })
  } catch (error) {
    const msg = 'Internal server error'
    console.error('Update FTP account error:', error)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; accountId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, accountId } = await params
    const access = await requireProjectAccess(decoded, projectId, 'data')
    if (!access.ok) return access.response
    const existing = await db.ftpAccount.findFirst({
      where: { id: accountId, projectId },
    })
    if (!existing) {
      return NextResponse.json({ error: 'FTP account not found' }, { status: 404 })
    }

    await deleteFtpAccount(projectId, accountId)

    await logAudit({
      userId: decoded.userId,
      action: 'project.ftp.delete',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { accountId, username: existing.username },
    })

    return NextResponse.json({ message: 'FTP account deleted' })
  } catch (error) {
    console.error('Delete FTP account error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
