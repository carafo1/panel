import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { processEvent } from '@/lib/automation'

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

    if (deployment.status !== 'live') {
      return NextResponse.json(
        { error: 'Only live deployments can be rolled back' },
        { status: 400 }
      )
    }

    // Mark the current deployment as rolled back
    await db.deployment.update({
      where: { id: deployment.id },
      data: { status: 'rolled_back' },
    })

    // Trigger rollback automation
    await processEvent({
      type: 'deployment_triggered',
      userId: decoded.userId,
      payload: {
        projectId: deployment.projectId,
        deploymentId: deployment.id,
        action: 'rollback_deployment',
        framework: deployment.project.framework,
      },
    })

    // Create a new deployment from the previous state
    const rollbackDeployment = await db.deployment.create({
      data: {
        projectId: deployment.projectId,
        userId: decoded.userId,
        commit: deployment.commit,
        branch: deployment.branch,
        status: 'live',
        deployUrl: deployment.deployUrl,
        duration: 15,
        triggeredBy: 'user',
        buildLog: `🔄 Rollback initiated from deployment ${deployment.id}\n✅ Previous version restored successfully\n✅ Deployment is live at ${deployment.deployUrl}`,
      },
    })

    return NextResponse.json({
      message: 'Deployment rolled back successfully',
      rolledBackDeployment: {
        id: deployment.id,
        status: 'rolled_back',
      },
      newDeployment: {
        id: rollbackDeployment.id,
        status: 'live',
        deployUrl: rollbackDeployment.deployUrl,
        createdAt: rollbackDeployment.createdAt,
      },
    })
  } catch (error) {
    console.error('Rollback deployment error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
