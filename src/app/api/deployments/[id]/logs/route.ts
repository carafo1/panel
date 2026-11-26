import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { publicUrlOrNull } from '@/lib/site-address'

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

    const { id } = await params

    const deployment = await db.deployment.findUnique({
      where: { id },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            slug: true,
            subdomain: true,
            framework: true,
          },
        },
      },
    })

    if (!deployment) {
      return NextResponse.json(
        { error: 'Deployment not found' },
        { status: 404 }
      )
    }

    const access = await requireProjectAccess(decoded, deployment.projectId, 'view')
    if (!access.ok) return access.response

    return NextResponse.json({
      deployment: {
        id: deployment.id,
        projectId: deployment.projectId,
        commit: deployment.commit,
        branch: deployment.branch,
        status: deployment.status,
        buildLog: deployment.buildLog,
        deployUrl: publicUrlOrNull(deployment.deployUrl),
        duration: deployment.duration,
        triggeredBy: deployment.triggeredBy,
        createdAt: deployment.createdAt,
        updatedAt: deployment.updatedAt,
        project: deployment.project,
      },
      logs: deployment.buildLog || 'No build logs available',
    })
  } catch (error) {
    console.error('Get deployment logs error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
