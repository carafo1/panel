import { NextResponse } from 'next/server'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { runUptimeChecks } from '@/lib/monitor'
import { recoverUnhealthyAllServers } from '@/lib/vps/docker-maintenance'
import { requireSecret, isAdmin, safeCompare } from '@/lib/security'
import { recordHeartbeat } from '@/lib/health'

// SECURITY: CRON_API_KEY is required. If unset, the cron-key auth path is
// disabled entirely — only admin JWTs can trigger a sweep. This prevents
// the "deployhub-cron-key" hardcoded default from being exploitable.
const CRON_API_KEY = process.env.CRON_API_KEY && !/^deployhub-cron-key$|^replace-with/.test(process.env.CRON_API_KEY)
  ? process.env.CRON_API_KEY
  : null

/**
 * POST /api/monitors/run
 * Trigger a manual uptime check sweep across all enabled monitors.
 *
 * Auth: either
 *   - a logged-in admin user (Bearer JWT with role="admin" or "super_admin"), or
 *   - a cron job passing `x-cron-key: <CRON_API_KEY>` (no session needed).
 *
 * Response: { checked, up, down, ranAt }
 */
export async function POST(request: Request) {
  try {
    const cronKey = request.headers.get('x-cron-key')

    // Path 1: cron-key auth (only if CRON_API_KEY is properly configured)
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
      // Path 2: admin JWT auth (admin OR super_admin)
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
      // SECURITY: include 'super_admin' (was 'admin' only — excluded super_admin)
      if (!isAdmin(decoded.role)) {
        return NextResponse.json(
          { error: 'Admin privileges required to run a manual sweep' },
          { status: 403 }
        )
      }
    }

    // Restart containers Docker reports unhealthy. Rides the 60s

    // monitor tick so a wedged site is recovered in about a minute

    // rather than waiting for the hourly sweep. Never fails the tick.

    const recovery = await recoverUnhealthyAllServers().catch((err) => {

      console.error('[monitors/run] health recovery failed:', err)

      return { restarted: 0, stillUnhealthy: 0 }

    })

    const result = await runUptimeChecks()

    await recordHeartbeat(
      'monitors',
      `checked=${(result as { checked?: number }).checked ?? 0}`
    )

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
 * POST /api/monitors/run
 * Convenience for cron systems that can't POST. Same auth rules as POST.
 */
export async function GET(request: Request) {
  return POST(request)
}
