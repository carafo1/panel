import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'

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

    return NextResponse.json({
      deployment: {
        id: deployment.id,
        projectId: deployment.projectId,
        commit: deployment.commit,
        branch: deployment.branch,
        status: deployment.status,
        buildLog: deployment.buildLog,
        deployUrl: deployment.deployUrl,
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
