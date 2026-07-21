import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'

/**
 * GET /api/audit-logs
 *
 * Returns paginated audit log entries for the authenticated user.
 * Admin users can see ALL users' logs; regular users see only their own.
 *
 * Query params:
 *   - page     (default 1)  - 1-indexed page number
 *   - limit    (default 50) - items per page (capped at 200)
 *   - action   (optional)   - filter by action prefix (e.g. "user.", "project.")
 *   - resource (optional)   - filter by resource type (e.g. "user", "project")
 *   - status   (optional)   - filter by status ("success" | "failure")
 *
 * Response:
 *   {
 *     logs: AuditLog[],
 *     total: number,
 *     page: number,
 *     totalPages: number,
 *     limit: number,
 *     isAdmin: boolean
 *   }
 */
export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    // Fetch the user to determine admin status
    const user = await db.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, role: true },
    })

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    // SECURITY: include 'super_admin' (was 'admin' only — excluded super_admin,
    // which is inconsistent with every other admin route).
    const isAdmin = user.role === 'admin' || user.role === 'super_admin'
    const isSuperAdmin = user.role === 'super_admin'

    // Parse query params
    const url = new URL(request.url)
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50))
    const actionFilter = url.searchParams.get('action')?.trim() || null
    const resourceFilter = url.searchParams.get('resource')?.trim() || null
    const statusFilter = url.searchParams.get('status')?.trim() || null

    // Build the where clause
    // Regular users only see their own logs; admins see all.
    const where: {
      userId?: string
      action?: { startsWith: string }
      resource?: string
      status?: string
    } = {}

    if (!isAdmin) {
      where.userId = user.id
    }

    if (actionFilter) {
      // Support both exact match and prefix match (e.g. "user." matches "user.login")
      where.action = { startsWith: actionFilter }
    }

    if (resourceFilter) {
      where.resource = resourceFilter
    }

    if (statusFilter) {
      where.status = statusFilter
    }

    // Run count + page query in parallel for performance
    const [total, rawLogs] = await Promise.all([
      (db as any).auditLog.count({ where }),
      (db as any).auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        // For admins, include the user's email/name for context
        include: isAdmin
          ? {
              user: {
                select: {
                  id: true,
                  email: true,
                  name: true,
                },
              },
            }
          : undefined,
      }),
    ])

    const totalPages = Math.max(1, Math.ceil(total / limit))

    // Serialize - parse metadata JSON string, format timestamps
    const logs = rawLogs.map((log: any) => {
      let metadata: unknown = null
      if (log.metadata) {
        try {
          metadata = JSON.parse(log.metadata)
        } catch {
          metadata = log.metadata // keep raw string if not JSON
        }
      }
      const serialized: Record<string, unknown> = {
        id: log.id,
        userId: log.userId,
        action: log.action,
        resource: log.resource,
        resourceId: log.resourceId,
        // SECURITY: IP + userAgent are PII — only super_admin can see them.
        // Regular admins see the action but not the network/client info.
        ...(isSuperAdmin ? { ip: log.ip, userAgent: log.userAgent } : {}),
        metadata,
        status: log.status,
        createdAt: log.createdAt instanceof Date
          ? log.createdAt.toISOString()
          : log.createdAt,
      }
      if (log.user) {
        serialized.user = {
          id: log.user.id,
          email: log.user.email,
          name: log.user.name,
        }
      }
      return serialized
    })

    return NextResponse.json({
      logs,
      total,
      page,
      totalPages,
      limit,
      isAdmin,
    })
  } catch (error) {
    console.error('Get audit logs error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
