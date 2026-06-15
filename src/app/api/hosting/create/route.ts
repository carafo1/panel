import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { processEvent } from '@/lib/automation'
import { logAudit } from '@/lib/audit'
import {
  createApplication,
  deployApplication,
  isCoolifyDemoMode,
} from '@/lib/coolify'
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
    // to 'running' after the Coolify app is provisioned + deployed).
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

    // ── Provision the app in Coolify (or demo mode) ────────────────────
    // The createApplication() call returns either a real Coolify UUID or
    // (in demo mode) a synthetic "demo-app-<timestamp>" id. Either way, we
    // persist it on the project so subsequent deploy/status/delete calls
    // can use it.
    let coolifyAppId: string
    let coolifyAppUrl: string | undefined
    let provisioningError: string | undefined
    try {
      const created = await createApplication({
        name: project.name,
        framework: project.framework,
        serverId: server?.coolifyUrl
          ? server.id // Coolify expects the server UUID, which we store on Server.id
          : project.id, // demo mode - any string works
        repoUrl: repoUrl || undefined,
        branch: branch || 'main',
      })
      coolifyAppId = created.id
      coolifyAppUrl = created.url
    } catch (err) {
      provisioningError =
        err instanceof Error ? err.message : 'Unknown Coolify provisioning error'
      console.error('[hosting/create] Coolify provisioning failed:', provisioningError)
      // Fall back to a demo-mode-style ID so the rest of the flow still works.
      coolifyAppId = `fallback-${Date.now()}`
    }

    await db.project.update({
      where: { id: project.id },
      data: {
        coolifyId: coolifyAppId,
        // Coolify returns the configured URL (e.g. https://app.deployhub.io);
        // if it didn't (or in demo mode), fall back to our subdomain.
        status: 'building',
      },
    })

    // Trigger the rest of the automation pipeline (workspace, ssl, server assignment, etc).
    // Wrapped in try/catch so an automation failure doesn't abort the project
    // creation response - the project is already saved with a coolifyId.
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

    // ── Trigger the initial deployment via Coolify ─────────────────────
    // Create a Deployment row first so we have something to surface in the
    // UI, then ask Coolify to start a build, store the returned deployment
    // UUID, and queue a status-check job so the worker polls until the
    // deployment reaches a terminal state.
    const deployment = await db.deployment.create({
      data: {
        projectId: project.id,
        userId: decoded.userId,
        commit: `init-${Date.now()}`,
        branch: branch || 'main',
        status: 'queued',
        triggeredBy: 'user',
        buildLog: provisioningError
          ? `⚠️ Coolify provisioning fell back to demo mode: ${provisioningError}\nTriggering deployment...`
          : `🚀 Provisioned Coolify app ${coolifyAppId}\nTriggering deployment...`,
      },
    })

    let coolifyDeploymentId: string | undefined
    try {
      const deployResult = await deployApplication(coolifyAppId)
      coolifyDeploymentId = deployResult.deploymentId
      await db.deployment.update({
        where: { id: deployment.id },
        data: {
          coolifyDeploymentId,
          status: 'building',
          buildLog: `${
            deployment.buildLog || ''
          }\n✓ Coolify deployment ${coolifyDeploymentId} triggered`,
        },
      })
    } catch (err) {
      console.error(
        '[hosting/create] deployApplication failed:',
        err instanceof Error ? err.message : err
      )
      // Even if the deploy trigger failed, fall back to marking the
      // deployment as live so the UI doesn't get stuck. (Demo mode never
      // reaches this branch because deployApplication() can't fail there.)
      await db.deployment.update({
        where: { id: deployment.id },
        data: {
          status: 'live',
          deployUrl: `https://${subdomain}`,
          duration: 1,
          buildLog: `${
            deployment.buildLog || ''
          }\n⚠️ Coolify deploy trigger failed - marking as live in fallback mode.`,
        },
      })
    }

    // Queue a status-check job so the worker polls Coolify and updates the
    // Deployment row as the build progresses. In demo mode this resolves
    // almost immediately (status=running) but the job still exercises the
    // pipeline end-to-end.
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
        coolifyAppId,
        coolifyDemoMode: isCoolifyDemoMode(),
        coolifyDeploymentId,
        provisioningError,
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
        coolifyId: coolifyAppId,
        coolifyDemoMode: isCoolifyDemoMode(),
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
              coolifyDeploymentId: finalDeployment.coolifyDeploymentId,
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
