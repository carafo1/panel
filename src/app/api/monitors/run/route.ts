import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { runUptimeChecks } from '@/lib/monitor'

/**
 * Cron API key. Set CRON_API_KEY in the environment to lock this down in
 * production; in dev we fall back to a constant so the endpoint is callable
 * out of the box for testing.
 */
const CRON_API_KEY = process.env.CRON_API_KEY || 'deployhub-cron-key'

/**
 * POST /api/monitors/run
 * Trigger a manual uptime check sweep across all enabled monitors.
 *
 * Auth: either
 *   - a logged-in admin user (Bearer JWT with role="admin"), or
 *   - a cron job passing `x-cron-key: <CRON_API_KEY>` (no session needed).
 *
 * Response: { checked, up, down, ranAt }
 */
export async function POST(request: Request) {
  try {
    const cronKey = request.headers.get('x-cron-key')

    // Path 1: cron-key auth.
    if (cronKey) {
      if (cronKey !== CRON_API_KEY) {
        return NextResponse.json(
          { error: 'Invalid cron API key' },
          { status: 401 }
        )
      }
    } else {
      // Path 2: admin JWT auth.
      const authHeader = request.headers.get('Authorization')
      const token = extractTokenFromHeader(authHeader)
      if (!token) {
        return NextResponse.json(
          { error: 'Authorization required (admin JWT or x-cron-key)' },
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
      if (decoded.role !== 'admin') {
        return NextResponse.json(
          { error: 'Admin privileges required to run a manual sweep' },
          { status: 403 }
        )
      }
    }

    const result = await runUptimeChecks()

    return NextResponse.json({
      ...result,
      ranAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Run monitors error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * GET /api/monitors/run
 * Convenience for cron systems that can't POST (or just want a healthcheck
 * trigger). Same auth rules as POST.
 */
export async function GET(request: Request) {
  return POST(request)
}
