import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import {
  getApplicationStatus,
  getDeploymentLogs,
  isCoolifyDemoMode,
} from '@/lib/coolify'

/**
 * GET /api/deployments/[id]/status
 *
 * Returns the live status of a deployment by polling Coolify (or returning
 * simulated data in demo mode). The response is sourced from:
 *   1. The Deployment row in our DB (our view of the world)
 *   2. A fresh getApplicationStatus() call against Coolify for the parent
 *      project's coolifyId - this gives us the true live status & URL.
 *   3. The latest build log lines from Coolify (best-effort).
 *
 * Response shape:
 *   {
 *     deploymentId: string,
 *     status: 'queued' | 'building' | 'deploying' | 'live' | 'failed' | 'rolled_back',
 *     coolifyStatus: string,       // raw Coolify status (e.g. 'running', 'building')
 *     url: string | null,          // live deployment URL
 *     logs: string,                // build log text (existing DB log + Coolify logs if available)
 *     coolifyDeploymentId: string | null,
 *     projectId: string,
 *     updatedAt: string            // ISO timestamp of the last DB update
 *   }
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
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

    const { id } = await params

    const deployment = await db.deployment.findFirst({
      where: { id, userId: decoded.userId },
      include: { project: true },
    })

    if (!deployment) {
      return NextResponse.json(
        { error: 'Deployment not found' },
        { status: 404 }
      )
    }

    // Pull the freshest status from Coolify if we have an app id.
    // In demo mode this always returns { status: 'running', url: ... } so
    // the UI will reflect a "live" state.
    let coolifyStatus: { status: string; url?: string } = {
      status: deployment.status,
    }
    let coolifyLogs: string | undefined
    if (deployment.project.coolifyId) {
      try {
        coolifyStatus = await getApplicationStatus(deployment.project.coolifyId)
      } catch (err) {
        console.error(
          '[deployments/status] getApplicationStatus failed:',
          err instanceof Error ? err.message : err
        )
        // Fall back to the DB-persisted status so the UI still renders.
      }

      // Best-effort: pull live build logs from Coolify. Requires both the
      // app id and a Coolify deployment UUID (stored on the row).
      if (deployment.coolifyDeploymentId) {
        try {
          coolifyLogs = await getDeploymentLogs(
            deployment.project.coolifyId,
            deployment.coolifyDeploymentId
          )
        } catch (err) {
          console.error(
            '[deployments/status] getDeploymentLogs failed:',
            err instanceof Error ? err.message : err
          )
        }
      }
    }

    // Map Coolify's vocabulary onto our internal status vocabulary so the
    // client gets a single, consistent value.
    const raw = (coolifyStatus.status || '').toLowerCase()
    let mappedStatus = deployment.status
    if (raw === 'running' || raw === 'healthy' || raw === 'ready') {
      mappedStatus = 'live'
    } else if (raw.includes('error') || raw === 'exited' || raw === 'failed') {
      mappedStatus = 'failed'
    } else if (raw === 'building' || raw === 'deploying' || raw === 'in_progress') {
      mappedStatus = raw
    } else if (raw === 'queued') {
      mappedStatus = 'building'
    }

    // Assemble the final log text: prefer the live Coolify logs if we got
    // them; otherwise fall back to the buildLog stored on the row.
    const finalLogs =
      coolifyLogs && coolifyLogs.trim().length > 0
        ? coolifyLogs
        : deployment.buildLog || 'No build logs available'

    return NextResponse.json({
      deploymentId: deployment.id,
      projectId: deployment.projectId,
      status: mappedStatus,
      dbStatus: deployment.status, // our last persisted view
      coolifyStatus: raw || 'unknown',
      url:
        coolifyStatus.url ||
        deployment.deployUrl ||
        (deployment.project.subdomain
          ? `https://${deployment.project.subdomain}`
          : null),
      logs: finalLogs,
      coolifyDeploymentId: deployment.coolifyDeploymentId,
      coolifyDemoMode: isCoolifyDemoMode(),
      duration: deployment.duration,
      updatedAt: deployment.updatedAt.toISOString(),
      createdAt: deployment.createdAt.toISOString(),
    })
  } catch (error) {
    console.error('Get deployment status error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
