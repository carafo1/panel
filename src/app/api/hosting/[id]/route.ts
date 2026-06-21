import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { removeProjectContainer } from '@/lib/vps'

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
          take: 10,
        },
        domains: {
          include: { dnsRecords: true },
        },
        githubIntegration: true,
      },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    // Get last deployment for project card
    const lastDeployment = project.deployments.length > 0
      ? {
          id: project.deployments[0].id,
          status: project.deployments[0].status,
          createdAt: project.deployments[0].createdAt.toISOString(),
          deployUrl: project.deployments[0].deployUrl,
        }
      : null

    return NextResponse.json({
      project: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        framework: project.framework,
        stack: project.stack,
        status: project.status,
        subdomain: project.subdomain,
        customDomain: project.customDomain,
        repoUrl: project.repoUrl,
        autoDeploy: project.autoDeploy,
        sslEnabled: project.sslEnabled,
        // Real VPS deployment fields
        containerId: project.containerId,
        containerName: project.containerName,
        containerPort: project.containerPort,
        externalPort: project.externalPort,
        deployPath: project.deployPath,
        sslCertStatus: project.sslCertStatus,
        sslCertExpiry: project.sslCertExpiry?.toISOString() ?? null,
        lastDeployedAt: project.lastDeployedAt?.toISOString() ?? null,
        lastDeployment,
        server: project.server ? {
          id: project.server.id,
          name: project.server.name,
          ip: project.server.ip,
          region: project.server.region,
          status: project.server.status,
          cpuCores: project.server.cpuCores,
          ramGB: project.server.ramGB,
          storageGB: project.server.storageGB,
        } : null,
        deployments: project.deployments.map((d) => ({
          id: d.id,
          commit: d.commit,
          branch: d.branch,
          status: d.status,
          deployUrl: d.deployUrl,
          duration: d.duration,
          triggeredBy: d.triggeredBy,
          createdAt: d.createdAt.toISOString(),
          updatedAt: d.updatedAt.toISOString(),
        })),
        domains: project.domains.map((dom) => ({
          id: dom.id,
          name: dom.name,
          status: dom.status,
          dnsRecords: dom.dnsRecords.map((r) => ({
            id: r.id,
            type: r.type,
            name: r.name,
            value: r.value,
            ttl: r.ttl,
          })),
        })),
        githubIntegration: project.githubIntegration ? {
          id: project.githubIntegration.id,
          userId: project.githubIntegration.userId,
          projectId: project.githubIntegration.projectId,
          githubId: project.githubIntegration.githubId,
          username: project.githubIntegration.username,
          repoFullName: project.githubIntegration.repoFullName,
          repoUrl: project.githubIntegration.repoUrl,
          branch: project.githubIntegration.branch,
          autoDeploy: project.githubIntegration.autoDeploy,
          webhookId: project.githubIntegration.webhookId,
          // True when the integration was created via real GitHub OAuth
          // (i.e. the stored token is not a demo/simulated value).
          oauthConnected:
            !!project.githubIntegration.accessToken &&
            !project.githubIntegration.accessToken.startsWith('ghp_demo_') &&
            !project.githubIntegration.accessToken.startsWith('ghp_sim_'),
          createdAt: project.githubIntegration.createdAt.toISOString(),
        } : null,
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
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

export async function PATCH(
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
    const body = await request.json()
    const { autoDeploy, sslEnabled, repoUrl, customDomain } = body

    const project = await db.project.findFirst({
      where: { id, userId: decoded.userId },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    const updateData: Record<string, unknown> = {}
    if (typeof autoDeploy === 'boolean') updateData.autoDeploy = autoDeploy
    if (typeof sslEnabled === 'boolean') updateData.sslEnabled = sslEnabled
    if (typeof repoUrl === 'string') updateData.repoUrl = repoUrl || null
    if (typeof customDomain === 'string') updateData.customDomain = customDomain || null

    await db.project.update({
      where: { id },
      data: updateData,
    })

    // Audit project update
    await logAudit({
      userId: decoded.userId,
      action: 'project.update',
      resource: 'project',
      resourceId: id,
      req: request,
      metadata: {
        name: project.name,
        changes: updateData,
      },
    })

    return NextResponse.json({
      message: 'Settings updated successfully',
    })
  } catch (error) {
    console.error('Update project error:', error)
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

    // ── Tear down the real VPS deployment ────────────────────────────
    // removeProjectContainer() gracefully handles demo mode (no sshHost),
    // missing containers, and un-deployed projects. It removes the Caddy
    // proxy entry, runs `docker compose down -v --rmi local` on the VPS,
    // deletes /opt/deployhub/projects/<slug>, and clears the Project's
    // containerId/containerName/containerPort/externalPort/deployPath fields.
    // The Project row is then marked 'stopped'.
    try {
      await removeProjectContainer(id)
    } catch (err) {
      // Don't abort the delete — the user still wants the project gone
      // from the dashboard. Log and fall back to a soft status update.
      console.error(
        `[hosting/delete] removeProjectContainer failed for ${id}:`,
        err instanceof Error ? err.message : err
      )
      await db.project
        .update({
          where: { id },
          data: { status: 'stopped' },
        })
        .catch(() => {})
    }

    // Audit project delete (stop)
    await logAudit({
      userId: decoded.userId,
      action: 'project.delete',
      resource: 'project',
      resourceId: id,
      req: request,
      metadata: {
        name: project.name,
        framework: project.framework,
        subdomain: project.subdomain,
      },
    })

    return NextResponse.json({
      success: true,
      message: 'Project deleted — container removed from VPS',
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
