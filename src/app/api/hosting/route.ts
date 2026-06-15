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

    const projects = await db.project.findMany({
      where: { userId: decoded.userId },
      include: {
        server: true,
        deployments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        domains: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description,
        framework: p.framework,
        status: p.status,
        subdomain: p.subdomain,
        customDomain: p.customDomain,
        sslEnabled: p.sslEnabled,
        autoDeploy: p.autoDeploy,
        server: p.server ? {
          id: p.server.id,
          name: p.server.name,
          ip: p.server.ip,
          region: p.server.region,
        } : null,
        lastDeployment: p.deployments[0] || null,
        domains: p.domains,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
    })
  } catch (error) {
    console.error('List hosting error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
