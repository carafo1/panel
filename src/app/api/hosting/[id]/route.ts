import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { deleteApplication, isCoolifyDemoMode } from '@/lib/coolify'

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
        status: project.status,
        subdomain: project.subdomain,
        customDomain: project.customDomain,
        repoUrl: project.repoUrl,
        autoDeploy: project.autoDeploy,
        sslEnabled: project.sslEnabled,
        coolifyId: project.coolifyId,
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

    // ── Clean up the Coolify app before touching the DB ────────────────
    // We always attempt to delete the Coolify app (if a coolifyId exists)
    // so the server-side resource is released. If the call fails (e.g. the
    // app was already deleted, network error, demo mode off), we log the
    // error but continue with the DB-side stop so the user can still clean
    // up their project from the dashboard.
    if (project.coolifyId) {
      try {
        await deleteApplication(project.coolifyId)
        console.log(
          `[hosting/delete] Coolify app ${project.coolifyId} deleted (demo=${isCoolifyDemoMode()})`
        )
      } catch (err) {
        // Log but don't fail - the DB record still needs to be updated.
        console.error(
          '[hosting/delete] Coolify deleteApplication failed (continuing with DB cleanup):',
          err instanceof Error ? err.message : err
        )
      }
    }

    // Stop the project by updating status
    await db.project.update({
      where: { id },
      data: { status: 'stopped' },
    })

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
        coolifyId: project.coolifyId,
        coolifyDemoMode: isCoolifyDemoMode(),
      },
    })

    return NextResponse.json({
      message: 'Project stopped successfully',
      project: {
        id: project.id,
        name: project.name,
        status: 'stopped',
        coolifyId: project.coolifyId,
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
