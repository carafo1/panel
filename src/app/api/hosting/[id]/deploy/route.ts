import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { createMonitor } from '@/lib/monitor'
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

    // Create the Deployment row first so we have a record of the deploy.
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

    // Queue a background job to advance the deployment status. The worker
    // service picks this up within ~10s and transitions the deployment
    // through building → live, appending realistic log lines.
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
        branch,
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
        status: 'building',
        deployUrl: `https://${project.subdomain}`,
        triggeredBy: 'user',
        branch,
        createdAt: deployment.createdAt,
      },
      message: 'Deployment triggered - worker will update status',
    })
  } catch (error) {
    console.error('Deploy error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
