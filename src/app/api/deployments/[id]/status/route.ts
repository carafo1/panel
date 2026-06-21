import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'

/**
 * GET /api/deployments/[id]/status
 *
 * Returns the current status of a deployment from the database. The status is
 * updated asynchronously by the deployment_status_check job (queued when a
 * deployment is triggered). Polling this endpoint reflects the latest known
 * state without making any external API calls.
 *
 * Response shape:
 *   {
 *     deploymentId: string,
 *     status: 'queued' | 'building' | 'deploying' | 'live' | 'failed' | 'rolled_back',
 *     dbStatus: string,             // raw persisted status
 *     url: string | null,           // deployment URL
 *     logs: string,                 // build log text from the row
 *     duration: number | null,
 *     updatedAt: string,            // ISO timestamp of the last DB update
 *     createdAt: string
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

    const url =
      deployment.deployUrl ||
      (deployment.project.subdomain
        ? `https://${deployment.project.subdomain}`
        : null)

    return NextResponse.json({
      deploymentId: deployment.id,
      projectId: deployment.projectId,
      status: deployment.status,
      dbStatus: deployment.status,
      url,
      logs: deployment.buildLog || 'No build logs available',
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
