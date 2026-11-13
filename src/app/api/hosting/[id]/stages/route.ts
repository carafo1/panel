import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'

/**
 * Deployment Stages Endpoint
 * ==========================
 *
 * Returns the ordered DeploymentStage rows for a project's most recent
 * deployment (or a specific deployment when `?deploymentId=` is supplied).
 *
 * Used by the panel's deployment progress UI to render the live checklist
 * of stages (plan → create_directory → … → verify) with status + duration.
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { id: projectId } = await params

    const access = await requireProjectAccess(decoded, projectId, 'view')
    if (!access.ok) return access.response

    const url = new URL(request.url)
    const explicitDeploymentId = url.searchParams.get('deploymentId')

    let deployment: { id: string; status: string; buildLog: string | null } | null
    if (explicitDeploymentId) {
      deployment = await db.deployment.findFirst({
        where: { id: explicitDeploymentId, projectId },
        select: { id: true, status: true, buildLog: true },
      })
    } else {
      deployment = await db.deployment.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, buildLog: true },
      })
    }

    if (!deployment) {
      return NextResponse.json({
        stages: [],
        deployment: null,
      })
    }

    const stages = await db.deploymentStage.findMany({
      where: { deploymentId: deployment.id },
      orderBy: { order: 'asc' },
    })

    return NextResponse.json({
      stages: stages.map((s) => ({
        id: s.id,
        name: s.name,
        label: s.label,
        status: s.status,
        message: s.message,
        log: s.log,
        order: s.order,
        startedAt: s.startedAt?.toISOString() ?? null,
        completedAt: s.completedAt?.toISOString() ?? null,
        durationMs: s.durationMs,
      })),
      deployment: {
        id: deployment.id,
        status: deployment.status,
        buildLog: deployment.buildLog,
      },
    })
  } catch (error) {
    console.error('Get deployment stages error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
