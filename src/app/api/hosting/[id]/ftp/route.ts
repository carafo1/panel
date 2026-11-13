import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { enforceLimit } from '@/lib/plan-limits'
import { logAudit } from '@/lib/audit'
import { listFtpAccounts, createFtpAccount } from '@/lib/vps'

/**
 * Project FTP Accounts Endpoint (collection)
 * ===========================================
 *
 *   GET  /api/hosting/[id]/ftp          — list all FTP accounts (masked)
 *   POST /api/hosting/[id]/ftp          — create a new FTP account
 *            body: { username, password, directory?, readOnly?, quotaMB? }
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId } = await params
    const access = await requireProjectAccess(decoded, projectId, 'data')
    if (!access.ok) return access.response
    const accounts = await listFtpAccounts(projectId)
    return NextResponse.json({ accounts })
  } catch (error) {
    console.error('List FTP accounts error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId } = await params
    const access = await requireProjectAccess(decoded, projectId, 'data')
    if (!access.ok) return access.response

    // Plan limit. The quota for FTP accounts was computed for the usage bar but
    // never enforced, so a customer could create them without limit while the
    // bar sat past 100%. Checked before creating anything.
    // Counted against the project owner's plan, not the caller's (team members).
    const denied = await enforceLimit(access.ownerId, 'ftpAccounts', { role: decoded.role })
    if (denied) return denied

    const body = await request.json().catch(() => ({}))
    const username = typeof body?.username === 'string' ? body.username.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const directory =
      typeof body?.directory === 'string' && body.directory.trim()
        ? body.directory.trim()
        : '/'
    const readOnly = !!body?.readOnly
    const quotaMB =
      body?.quotaMB === undefined || body?.quotaMB === null || body?.quotaMB === ''
        ? null
        : Number(body.quotaMB)

    if (!username) {
      return NextResponse.json({ error: 'Username is required' }, { status: 400 })
    }
    if (!password) {
      return NextResponse.json({ error: 'Password is required' }, { status: 400 })
    }

    const account = await createFtpAccount(projectId, {
      username,
      password,
      directory,
      readOnly,
      quotaMB,
    })

    await logAudit({
      userId: decoded.userId,
      action: 'project.ftp.create',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { accountId: account.id, username: account.username },
    })

    // Return the row WITH plaintext password ONCE so the UI can show it.
    return NextResponse.json({ account }, { status: 201 })
  } catch (error) {
    const msg = 'Internal server error'
    console.error('Create FTP account error:', error)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
