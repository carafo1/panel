import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { processEvent } from '@/lib/automation'
import { logAudit } from '@/lib/audit'
import { deployProject } from '@/lib/vps'

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export async function POST(request: Request) {
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

    const body = await request.json()
    const { name, framework, planId, repoUrl, branch } = body

    if (!name || !framework) {
      return NextResponse.json(
        { error: 'Name and framework are required' },
        { status: 400 }
      )
    }

    // Check user's project limit based on subscription
    const subscription = await db.subscription.findFirst({
      where: { userId: decoded.userId, status: 'active' },
      include: { plan: true },
    })

    if (subscription && subscription.plan) {
      const projectCount = await db.project.count({
        where: { userId: decoded.userId },
      })
      if (projectCount >= subscription.plan.projects) {
        return NextResponse.json(
          { error: `Project limit reached (${subscription.plan.projects} projects on ${subscription.plan.name} plan)` },
          { status: 403 }
        )
      }
    }

    // Generate slug and subdomain
    const slug = slugify(name)
    const subdomain = `${slug}.deployhub.io`

    // Check if slug is unique
    const existingProject = await db.project.findFirst({ where: { slug } })
    if (existingProject) {
      return NextResponse.json(
        { error: 'A project with this name already exists' },
        { status: 409 }
      )
    }

    // Auto-assign a server: prefer active servers with dockerInstalled=true
    // that have the fewest projects; fall back to any active server. If no
    // active server exists at all, return a 400 so the user knows to add one
    // via the admin panel first.
    const serverCandidates = await db.server.findMany({
      where: { status: 'active' },
      include: { _count: { select: { projects: true } } },
    })
    serverCandidates.sort((a, b) => {
      if (a.dockerInstalled !== b.dockerInstalled) {
        return a.dockerInstalled ? -1 : 1
      }
      const pa = a._count?.projects ?? 0
      const pb = b._count?.projects ?? 0
      if (pa !== pb) return pa - pb
      return a.createdAt.getTime() - b.createdAt.getTime()
    })
    const server = serverCandidates[0] || null

    if (!server) {
      return NextResponse.json(
        {
          error:
            'No active servers available. Add a server in admin panel first.',
        },
        { status: 400 }
      )
    }

    // Create the project (initially in 'creating' status - will be updated
    // to 'running' once the deployment pipeline completes).
    const project = await db.project.create({
      data: {
        userId: decoded.userId,
        name,
        slug,
        framework,
        status: 'creating',
        serverId: server.id,
        subdomain,
        sslEnabled: true,
        autoDeploy: true,
        repoUrl: repoUrl || null,
      },
    })

    // Trigger the rest of the automation pipeline (workspace, ssl, server assignment, etc).
    // Wrapped in try/catch so an automation failure doesn't abort the project
    // creation response - the project is already saved.
    try {
      await processEvent({
        type: 'hosting_requested',
        userId: decoded.userId,
        payload: {
          projectId: project.id,
          projectName: name,
          framework,
          planId: planId || subscription?.planId || null,
          serverId: server.id,
        },
      })
    } catch (automationErr) {
      console.error(
        '[hosting/create] Automation pipeline error (non-fatal):',
        automationErr instanceof Error ? automationErr.message : automationErr
      )
    }

    // Create an initial Deployment row in 'queued' status. The real VPS
    // deployer (fired below) will transition it to 'live' or 'failed' as it
    // runs, streaming build logs into buildLog.
    const deployment = await db.deployment.create({
      data: {
        projectId: project.id,
        userId: decoded.userId,
        commit: `init-${Date.now()}`,
        branch: branch || 'main',
        status: 'queued',
        triggeredBy: 'user',
        buildLog: `🚀 Provisioned project ${project.name}\nTriggering deployment on ${server.name}…`,
      },
    })

    // Fire-and-forget the real VPS deploy so the HTTP response returns
    // immediately. The deployer updates the Deployment row's status + buildLog
    // as it progresses; the UI polls for status.
    void deployProject({
      projectId: project.id,
      deploymentId: deployment.id,
      onLog: (msg) =>
        console.log(`[hosting/create ${deployment.id.slice(0, 8)}] ${msg}`),
    }).catch(async (err) => {
      console.error(
        `[hosting/create ${deployment.id}] Deploy failed:`,
        err
      )
      const errMsg = err instanceof Error ? err.message : String(err)
      try {
        await db.deployment.update({
          where: { id: deployment.id },
          data: {
            status: 'failed',
            buildLog: `❌ Deploy threw: ${errMsg}`,
            duration: 0,
          },
        })
        await db.project.update({
          where: { id: project.id },
          data: { status: 'error' },
        })
      } catch (persistErr) {
        console.error(
          `[hosting/create ${deployment.id}] Failed to persist failure state:`,
          persistErr
        )
      }
    })

    // Refresh the deployment row for the response.
    const finalDeployment = await db.deployment.findUnique({
      where: { id: deployment.id },
    })

    // Audit project creation
    await logAudit({
      userId: decoded.userId,
      action: 'project.create',
      resource: 'project',
      resourceId: project.id,
      req: request,
      metadata: {
        name: project.name,
        framework: project.framework,
        subdomain,
        serverId: server.id,
      },
    })

    return NextResponse.json(
      {
        project: {
          id: project.id,
          name: project.name,
          slug: project.slug,
          framework: project.framework,
          status: project.status,
          subdomain: project.subdomain,
          sslEnabled: project.sslEnabled,
          autoDeploy: project.autoDeploy,
          server: {
            id: server.id,
            name: server.name,
            ip: server.ip,
            region: server.region,
          },
        },
        deployment: finalDeployment
          ? {
              id: finalDeployment.id,
              status: finalDeployment.status,
              deployUrl: finalDeployment.deployUrl || `https://${subdomain}`,
            }
          : null,
        message: 'Project created — deployment started',
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('Create hosting error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
