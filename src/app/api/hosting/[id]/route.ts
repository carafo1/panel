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

    const project = await db.project.findFirst({
      where: { id, userId: decoded.userId },
      include: {
        server: true,
        deployments: {
          orderBy: { createdAt: 'desc' },
        },
        domains: {
          include: { dnsRecords: true },
        },
      },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({
      project: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        framework: project.framework,
        status: project.status,
        subdomain: project.subdomain,
        customDomain: project.customDomain,
        repoUrl: project.repoUrl,
        autoDeploy: project.autoDeploy,
        sslEnabled: project.sslEnabled,
        coolifyId: project.coolifyId,
        server: project.server ? {
          id: project.server.id,
          name: project.server.name,
          ip: project.server.ip,
          region: project.server.region,
          status: project.server.status,
        } : null,
        deployments: project.deployments.map((d) => ({
          id: d.id,
          commit: d.commit,
          branch: d.branch,
          status: d.status,
          deployUrl: d.deployUrl,
          duration: d.duration,
          triggeredBy: d.triggeredBy,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
        })),
        domains: project.domains.map((dom) => ({
          id: dom.id,
          name: dom.name,
          status: dom.status,
          dnsRecords: dom.dnsRecords,
        })),
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
    })
  } catch (error) {
    console.error('Get project error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function DELETE(
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

    const project = await db.project.findFirst({
      where: { id, userId: decoded.userId },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    // Stop the project by updating status
    await db.project.update({
      where: { id },
      data: { status: 'stopped' },
    })

    return NextResponse.json({
      message: 'Project stopped successfully',
      project: {
        id: project.id,
        name: project.name,
        status: 'stopped',
      },
    })
  } catch (error) {
    console.error('Delete project error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
