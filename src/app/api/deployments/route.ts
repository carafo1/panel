import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { accessibleProjectsWhere } from '@/lib/project-access'
import { publicUrlOrNull } from '@/lib/site-address'

export async function GET(request: Request) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const deployments = await db.deployment.findMany({
      // Deployments of every project the caller can see — their own and those
      // of every team they belong to.
      where: { project: accessibleProjectsWhere(decoded.userId) },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            slug: true,
            subdomain: true,
            customDomain: true,
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
        deployUrl: publicUrlOrNull(d.deployUrl),
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
