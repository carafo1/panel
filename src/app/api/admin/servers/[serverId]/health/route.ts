import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { checkServerHealth } from '@/lib/vps/provisioner'

/**
 * GET /api/admin/servers/[serverId]/health
 *
 * Quick health check — opens an SSH connection and verifies that Docker is
 * responsive and Caddy is active. Updates the server row's `healthStatus`
 * and `lastHealthCheckAt` columns as a side-effect.
 *
 * Response: `{ status, details, lastHealthCheckAt }`
 *   status: 'healthy' | 'degraded' | 'down'
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ serverId: string }> }
) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }
    const decoded = verifyToken(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }
    if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }

    const { serverId } = await params

    // Run the health check (also persists the result back to the server row).
    const result = await checkServerHealth(serverId)

    // Re-read so we can surface the freshly-updated lastHealthCheckAt.
    const updated = await db.server.findUnique({
      where: { id: serverId },
      select: { lastHealthCheckAt: true, healthStatus: true },
    })

    return NextResponse.json({
      status: result.status,
      details: result.details,
      healthStatus: updated?.healthStatus ?? result.status,
      lastHealthCheckAt: updated?.lastHealthCheckAt?.toISOString() ?? null,
    })
  } catch (error) {
    console.error('Admin server health error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: 'Internal server error',
      },
      { status: 500 }
    )
  }
}
