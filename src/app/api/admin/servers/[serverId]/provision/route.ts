import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { provisionServer } from '@/lib/vps/provisioner'

/**
 * POST /api/admin/servers/[serverId]/provision
 *
 * Runs the full VPS provisioner pipeline (system update → Docker → Caddy →
 * UFW → directories → resource detection). This is a long-running operation
 * (5+ min on a real VPS), so the route awaits it and returns the full result.
 * The UI polls /health or reads the returned `steps` array for progress.
 *
 * Audit: action='server.provision', resource='server', resourceId=serverId.
 */
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

    // Run the full pipeline. The onProgress callback is intentionally a
    // no-op here — the route returns the full result once provisioning
    // completes. The UI can poll GET /health for live status while this
    // request is in flight.
    const result = await provisionServer(serverId, (_step) => {
      // Progress is persisted to the DB by provisionServer itself; nothing
      // to stream back here.
    })

    await logAudit({
      userId: decoded.userId,
      action: 'server.provision',
      resource: 'server',
      resourceId: serverId,
      req: request,
      status: result.ok ? 'success' : 'failure',
      metadata: {
        finalStatus: result.finalStatus,
        dockerVersion: result.dockerVersion,
        caddyVersion: result.caddyVersion,
        osInfo: result.osInfo,
        detectedCpuCores: result.detectedCpuCores,
        detectedRamGB: result.detectedRamGB,
        detectedStorageGB: result.detectedStorageGB,
        stepCount: result.steps.length,
        failedSteps: result.steps
          .filter((s) => s.status === 'failed')
          .map((s) => s.step),
      },
    })

    // Return 200 even on failure so the caller can inspect the per-step
    // breakdown; the `ok` flag indicates overall outcome.
    return NextResponse.json({
      ok: result.ok,
      steps: result.steps,
      finalStatus: result.finalStatus,
      dockerVersion: result.dockerVersion,
      caddyVersion: result.caddyVersion,
      osInfo: result.osInfo,
      detectedCpuCores: result.detectedCpuCores,
      detectedRamGB: result.detectedRamGB,
      detectedStorageGB: result.detectedStorageGB,
    })
  } catch (error) {
    console.error('Admin server provision error:', error)
    return NextResponse.json(
      {
        ok: false,
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}
