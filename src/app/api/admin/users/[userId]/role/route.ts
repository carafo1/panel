import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  verifyTokenFresh,
  extractTokenFromHeader,
  invalidateUserAuthCache,
} from '@/lib/auth'
import { logAudit } from '@/lib/audit'

/**
 * Authorisation helper: super admin only. The `admin` role is NOT allowed
 * to change user roles — only `super_admin` can. This prevents privilege
 * escalation by regular admins.
 *
 * Returns the decoded user payload on success, or null when unauthenticated
 * / unauthorised.
 */
async function requireSuperAdmin(request: Request): Promise<{
  decoded: { userId: string; email: string; role: string }
} | null> {
  const authHeader = request.headers.get('Authorization')
  const token = extractTokenFromHeader(authHeader)
  if (!token) return null
  const decoded = await verifyTokenFresh(token)
  if (!decoded) return null
  if (decoded.role !== 'super_admin') return null
  return { decoded }
}

const VALID_ROLES = ['super_admin', 'admin', 'client', 'user'] as const
type ValidRole = (typeof VALID_ROLES)[number]

interface RouteContext {
  params: Promise<{ userId: string }>
}

/**
 * PATCH /api/admin/users/[userId]/role
 *
 * Update a user's role. Body: { role: "super_admin" | "admin" | "client" | "user" }
 *
 * Rules:
 *  - Only `super_admin` callers may change roles (not `admin`).
 *  - A user cannot change their OWN role (prevents self-lockout).
 *  - The requested role must be in the VALID_ROLES list.
 *
 * Returns the refreshed user record (id, name, email, role).
 */
export async function PATCH(request: Request, context: RouteContext) {
  try {
    const auth = await requireSuperAdmin(request)
    if (!auth) {
      return NextResponse.json(
        { error: 'Super admin access required' },
        { status: 403 }
      )
    }

    const { userId } = await context.params
    if (!userId) {
      return NextResponse.json(
        { error: 'userId is required' },
        { status: 400 }
      )
    }

    // Prevent self role-change (lockout protection).
    if (userId === auth.decoded.userId) {
      return NextResponse.json(
        { error: 'You cannot change your own role' },
        { status: 400 }
      )
    }

    const body = await request.json().catch(() => ({}))
    const { role } = body as { role?: string }

    if (!role || typeof role !== 'string') {
      return NextResponse.json(
        { error: 'role is required' },
        { status: 400 }
      )
    }

    if (!VALID_ROLES.includes(role as ValidRole)) {
      return NextResponse.json(
        {
          error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`,
        },
        { status: 400 }
      )
    }

    const targetUser = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, role: true },
    })

    if (!targetUser) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    const previousRole = targetUser.role

    // No-op short-circuit (avoid audit spam).
    if (previousRole === role) {
      return NextResponse.json({
        success: true,
        user: targetUser,
        message: 'Role unchanged',
      })
    }

    const updated = await db.user.update({
      where: { id: userId },
      data: { role: role as ValidRole },
      select: { id: true, name: true, email: true, role: true },
    })

    // AFTER the write, never before: invalidating first would let a
    // concurrent request re-cache the OLD role and keep it alive for the
    // full TTL. Doing it here means the new role applies to the next request.
    invalidateUserAuthCache(userId)

    await logAudit({
      userId: auth.decoded.userId,
      action: 'admin.user.role.update',
      resource: 'user',
      resourceId: userId,
      req: request,
      metadata: {
        targetUserId: userId,
        targetEmail: targetUser.email,
        previousRole,
        newRole: role,
      },
    })

    return NextResponse.json({
      success: true,
      user: updated,
    })
  } catch (error) {
    console.error('Update user role error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
