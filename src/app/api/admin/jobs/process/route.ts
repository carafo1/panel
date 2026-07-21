import { NextResponse } from 'next/server'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { processPendingJobs } from '@/lib/worker'
import { isAdmin, safeCompare } from '@/lib/security'

/**
 * CRON_API_KEY for the worker-service to trigger job processing without a
 * user session. SECURITY: no hardcoded default — if unset or set to the
 * placeholder, the cron-key path is disabled entirely (only admin JWTs work).
 */
const CRON_API_KEY = process.env.CRON_API_KEY && !/^deployhub-cron-key$|^replace-with/.test(process.env.CRON_API_KEY)
  ? process.env.CRON_API_KEY
  : null

/**
 * POST /api/admin/jobs/process
 *
 * Manually trigger processing of pending JobQueue rows. Picks up at most
 * `limit` (default 10, max 100) queued/failed jobs whose runAt has elapsed
 * and processes them via the automation engine.
 *
 * Auth: either
 *   - a logged-in admin user (Bearer JWT with role="admin"), or
 *   - a cron job passing `x-cron-key: <CRON_API_KEY>` (no session needed).
 *
 * Response: { processed, succeeded, failed, ranAt }
 */
export async function POST(request: Request) {
  try {
    const cronKey = request.headers.get('x-cron-key')

    // Path 1: cron-key auth (used by the standalone worker-service).
    if (cronKey) {
      if (!CRON_API_KEY) {
        return NextResponse.json(
          { error: 'Cron API key not configured on the server' },
          { status: 401 }
        )
      }
      // Constant-time comparison to prevent timing attacks
      if (!safeCompare(cronKey, CRON_API_KEY)) {
        return NextResponse.json(
          { error: 'Invalid cron API key' },
          { status: 401 }
        )
      }
    } else {
      // Path 2: admin JWT auth (admin OR super_admin).
      const authHeader = request.headers.get('Authorization')
      const token = extractTokenFromHeader(authHeader)
      if (!token) {
        return NextResponse.json(
          { error: 'Authorization required (admin JWT or x-cron-key)' },
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
      if (!isAdmin(decoded.role)) {
        return NextResponse.json(
          { error: 'Admin privileges required to trigger job processing' },
          { status: 403 }
        )
      }
    }

    // Parse ?limit= from the query string (1-100, default 10).
    const url = new URL(request.url)
    const limitParam = parseInt(url.searchParams.get('limit') || '10', 10)
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(limitParam, 100))
      : 10

    const result = await processPendingJobs(limit)

    return NextResponse.json({
      ...result,
      ranAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Process jobs error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * GET /api/admin/jobs/process
 * Convenience for cron systems that can't POST. Same auth rules as POST.
 */
export async function GET(request: Request) {
  return POST(request)
}
