import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { deleteKey, SftpError } from '@/lib/sftp-access'

/** DELETE /api/user/ssh-keys/[id] — remove a key; it stops working on every website at once. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(request)
  if (!auth) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  const { id } = await params
  try {
    const result = await deleteKey(auth.userId, id)
    await logAudit({ userId: auth.userId, action: 'user.ssh_key.delete', resource: 'user', resourceId: auth.userId, req: request, status: 'success', metadata: { keyId: id } })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof SftpError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error('[ssh-keys] delete failed:', error)
    return NextResponse.json({ error: 'Could not remove the key' }, { status: 500 })
  }
}
