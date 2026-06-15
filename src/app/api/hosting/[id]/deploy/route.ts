import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { createMonitor } from '@/lib/monitor'
import {
  deployApplication,
  isCoolifyDemoMode,
} from '@/lib/coolify'
import { createJob } from '@/lib/automation'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
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

    if (project.status !== 'running') {
      return NextResponse.json(
        { error: 'Project must be running to deploy' },
        { status: 400 }
      )
    }

    // Parse optional body for branch/commit override.
    let branch = 'main'
    let commit: string | undefined
    try {
      const body = await request.json()
      if (body && typeof body.branch === 'string') branch = body.branch
      if (body && typeof body.commit === 'string') commit = body.commit
    } catch {
      // No body or invalid JSON - that's fine, defaults are used.
    }

    // Create the Deployment row first so we have a record even if the
    // Coolify call below fails.
    const deployment = await db.deployment.create({
      data: {
        projectId: project.id,
        userId: decoded.userId,
        commit: commit || `auto-${Date.now()}`,
        branch,
        status: 'queued',
        triggeredBy: 'user',
        buildLog: `🚀 Deployment triggered by ${decoded.email}\nBranch: ${branch}\nProject: ${project.name} (${project.framework})`,
      },
    })

    // ── Trigger the real Coolify deployment ────────────────────────────
    // If the project has a coolifyId (always true post-Wave-11 create flow,
    // and always present in demo mode), call deployApplication() to start a
    // fresh build in Coolify. Store the returned deployment UUID on the row
    // so /api/deployments/[id]/status can poll it.
    let coolifyDeploymentId: string | undefined
    let deployTriggerError: string | undefined
    if (project.coolifyId) {
      try {
        const result = await deployApplication(project.coolifyId)
        coolifyDeploymentId = result.deploymentId
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
        deployTriggerError =
          err instanceof Error ? err.message : 'Unknown Coolify deploy error'
        console.error('[deploy] deployApplication failed:', deployTriggerError)
        await db.deployment.update({
          where: { id: deployment.id },
          data: {
            status: 'failed',
            buildLog: `${
              deployment.buildLog || ''
            }\n❌ Coolify deploy trigger failed: ${deployTriggerError}`,
          },
        })
        return NextResponse.json(
          {
            error: 'Coolify deployment trigger failed',
            detail: deployTriggerError,
            deploymentId: deployment.id,
          },
          { status: 502 }
        )
      }
    } else {
      // No coolifyId - this should be rare post-Wave-11, but handle it.
      await db.deployment.update({
        where: { id: deployment.id },
        data: {
          status: 'building',
          buildLog: `${
            deployment.buildLog || ''
          }\n⚠️ No Coolify app ID on project - deploying in legacy/demo mode.`,
        },
      })
    }

    // Queue a background job to poll Coolify for the deployment status.
    // The worker-service picks this up within ~10s and will keep polling
    // every ~15s until the deployment reaches a terminal state.
    await createJob('deployment_status_check', {
      deploymentId: deployment.id,
      projectId: project.id,
      userId: decoded.userId,
      attempt: 0,
    })

    // Audit project deploy
    await logAudit({
      userId: decoded.userId,
      action: 'project.deploy',
      resource: 'project',
      resourceId: project.id,
      req: request,
      metadata: {
        name: project.name,
        framework: project.framework,
        deploymentId: deployment.id,
        coolifyDeploymentId,
        branch,
        coolifyDemoMode: isCoolifyDemoMode(),
      },
    })

    // Auto-provision an uptime monitor for the deployed URL so the user gets
    // visibility into the new deployment without manual setup. Skip if one
    // already exists for this project + URL (e.g. on redeploy).
    const monitorUrl = `https://${project.subdomain}`
    try {
      const existing = await db.uptimeMonitor.findFirst({
        where: { projectId: project.id, url: monitorUrl },
        select: { id: true },
      })
      if (!existing) {
        await createMonitor(project.id, monitorUrl, 60)
      }
    } catch (err) {
      // Monitoring is best-effort - never fail a deploy because of it.
      console.error('[deploy] Auto-create monitor failed:', err)
    }

    return NextResponse.json({
      deployment: {
        id: deployment.id,
        projectId: project.id,
        status: deployment.status === 'queued' ? 'building' : deployment.status,
        deployUrl: `https://${project.subdomain}`,
        coolifyDeploymentId,
        triggeredBy: 'user',
        branch,
        createdAt: deployment.createdAt,
      },
      coolifyDemoMode: isCoolifyDemoMode(),
      message: coolifyDeploymentId
        ? 'Deployment triggered - worker will poll for status updates'
        : 'Deployment triggered (no Coolify app ID)',
    })
  } catch (error) {
    console.error('Deploy error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
