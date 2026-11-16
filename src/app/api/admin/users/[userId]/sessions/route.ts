import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdminRole, revokeAllSessions } from '@/lib/auth'
import { logAudit } from '@/lib/audit'

/**
 * POST /api/admin/users/[userId]/sessions
 *
 * Sign a user out of every device, e.g. when their account looks compromised.
 * Admins may do this for customers; only a super admin may do it to another
 * admin. The account itself stays active — the user can sign in again.
 */
export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const admin = await requireAdminRole(request)
  if (!admin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const { userId } = await params
  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, role: true } })
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const targetIsAdmin = target.role === 'admin' || target.role === 'super_admin'
  if (targetIsAdmin && admin.role !== 'super_admin') {
    return NextResponse.json({ error: 'Only a super admin can sign out an administrator' }, { status: 403 })
  }

  await revokeAllSessions(target.id, 'admin')

  await logAudit({
    userId: admin.userId,
    action: 'admin.user_sessions_revoked',
    resource: 'user',
    resourceId: target.id,
    req: request,
    metadata: { targetEmail: target.email },
  })

  return NextResponse.json({ message: `${target.email} has been signed out on all devices` })
}
