import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'

export async function GET(request: Request) {
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

    const deployments = await db.deployment.findMany({
      where: { userId: decoded.userId },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            slug: true,
            subdomain: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      deployments: deployments.map((d) => ({
        id: d.id,
        projectId: d.projectId,
        commit: d.commit,
        branch: d.branch,
        status: d.status,
        deployUrl: d.deployUrl,
        duration: d.duration,
        triggeredBy: d.triggeredBy,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        project: d.project,
      })),
    })
  } catch (error) {
    console.error('List deployments error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
