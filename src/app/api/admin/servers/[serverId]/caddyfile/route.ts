import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getServerCaddyfile, reloadCaddy } from '@/lib/vps/proxy'

/**
 * /api/admin/servers/[serverId]/caddyfile
 *
 * GET  — return the current Caddyfile content from the server (or the
 *        simulated one in demo mode).
 * POST — reload Caddy so the current Caddyfile takes effect.
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
    const caddyfile = await getServerCaddyfile(serverId)

    return NextResponse.json({ caddyfile, serverId })
  } catch (error) {
    console.error('Admin caddyfile GET error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}

export async function POST(
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
    const result = await reloadCaddy(serverId)

    await logAudit({
      userId: decoded.userId,
      action: 'server.caddy_reload',
      resource: 'server',
      resourceId: serverId,
      req: request,
      status: result.ok ? 'success' : 'failure',
      metadata: { ok: result.ok, message: result.message },
    })

    return NextResponse.json({
      ok: result.ok,
      message: result.message,
      serverId,
    })
  } catch (error) {
    console.error('Admin caddyfile POST error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}
