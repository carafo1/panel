import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { withRateLimit } from '@/lib/rate-limit'
import { listKeys, addKey, SftpError } from '@/lib/sftp-access'

/**
 * GET  /api/user/ssh-keys   your public SSH keys
 * POST /api/user/ssh-keys   { name?, publicKey }
 *
 * Adding a key is refused during support access: staff viewing an account
 * must not be able to leave themselves a way back in.
 */
export async function GET(request: Request) {
  const auth = await authenticateRequest(request)
  if (!auth) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  return NextResponse.json({ keys: await listKeys(auth.userId) })
}

async function postHandler(request: Request) {
  const auth = await authenticateRequest(request)
  if (!auth) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  if (auth.impersonatedBy) return NextResponse.json({ error: 'Not available during support access' }, { status: 403 })
  try {
    const key = await addKey(auth.userId, await request.json().catch(() => ({})))
    await logAudit({ userId: auth.userId, action: 'user.ssh_key.add', resource: 'user', resourceId: auth.userId, req: request, status: 'success', metadata: { fingerprint: key.fingerprint } })
    return NextResponse.json({ key }, { status: 201 })
  } catch (error) {
    if (error instanceof SftpError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error('[ssh-keys] add failed:', error)
    return NextResponse.json({ error: 'Could not add the key' }, { status: 500 })
  }
}

export const POST = withRateLimit(postHandler, { limit: 10, windowMs: 60_000 })
