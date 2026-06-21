import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { processEvent } from '@/lib/automation'
import { logAudit } from '@/lib/audit'
import { createJob } from '@/lib/automation'

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

    // Find the least loaded server
    const server = await db.server.findFirst({
      where: { status: 'active' },
      orderBy: { usedRamGB: 'asc' },
    })

    // Create the project (initially in 'creating' status - will be updated
    // to 'running' once the deployment pipeline completes).
    const project = await db.project.create({
      data: {
        userId: decoded.userId,
        name,
        slug,
        framework,
        status: 'creating',
        serverId: server?.id || null,
        subdomain,
        sslEnabled: true,
        autoDeploy: true,
        repoUrl: repoUrl || null,
      },
    })

    await db.project.update({
      where: { id: project.id },
      data: { status: 'building' },
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
          serverId: server?.id || null,
        },
      })
    } catch (automationErr) {
      console.error(
        '[hosting/create] Automation pipeline error (non-fatal):',
        automationErr instanceof Error ? automationErr.message : automationErr
      )
    }

    // Create an initial Deployment row so the UI has something to surface,
    // and queue a status-check job so the worker transitions it through
    // building → live.
    const deployment = await db.deployment.create({
      data: {
        projectId: project.id,
        userId: decoded.userId,
        commit: `init-${Date.now()}`,
        branch: branch || 'main',
        status: 'queued',
        triggeredBy: 'user',
        buildLog: `🚀 Provisioned project ${project.name}\nTriggering deployment...`,
      },
    })

    await createJob('deployment_status_check', {
      deploymentId: deployment.id,
      projectId: project.id,
      userId: decoded.userId,
      attempt: 0,
    })

    // Update project status to 'running' so the dashboard reflects a
    // successful creation. The status-check job will refine this further.
    await db.project.update({
      where: { id: project.id },
      data: { status: 'running' },
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
        serverId: server?.id || null,
      },
    })

    return NextResponse.json({
      project: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        framework: project.framework,
        status: 'running',
        subdomain: project.subdomain,
        sslEnabled: project.sslEnabled,
        autoDeploy: project.autoDeploy,
        server: server ? {
          id: server.id,
          name: server.name,
          ip: server.ip,
          region: server.region,
        } : null,
        deployment: finalDeployment
          ? {
              id: finalDeployment.id,
              status: finalDeployment.status,
              deployUrl: finalDeployment.deployUrl || `https://${subdomain}`,
            }
          : null,
      },
    }, { status: 201 })
  } catch (error) {
    console.error('Create hosting error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
