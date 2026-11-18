import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'

/**
 * POST /api/deployments/[id]/rollback
 *
 * Not implemented yet, and it says so.
 *
 * This endpoint used to mark the deployment 'rolled_back' and insert a NEW
 * deployment with status 'live' and a hand-written "✅ Previous version
 * restored successfully" log — without touching the server. The site kept
 * running whatever it was running, while the panel claimed otherwise.
 *
 * A real rollback needs the deployer to build a specific earlier commit (it
 * currently always deploys the branch head) through claimDeploySlot, so until
 * that exists the honest answer is 501 and no rows are written. Auth and
 * access checks still run first so the endpoint leaks nothing about other
 * tenants' deployments.
 */
export async function POST(
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

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { id } = await params

    const deployment = await db.deployment.findUnique({
      where: { id },
      select: { id: true, projectId: true },
    })

    if (!deployment) {
      return NextResponse.json(
        { error: 'Deployment not found' },
        { status: 404 }
      )
    }

    const access = await requireProjectAccess(decoded, deployment.projectId, 'deploy')
    if (!access.ok) return access.response

    return NextResponse.json(
      {
        error:
          'Rollback is not available yet. To go back to an earlier version, revert the change in your repository and deploy again.',
        code: 'rollback_not_implemented',
      },
      { status: 501 }
    )
  } catch (error) {
    console.error('Rollback deployment error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
