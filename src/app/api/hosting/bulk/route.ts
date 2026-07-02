import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'

type BulkAction = 'deploy' | 'stop' | 'restart' | 'delete'

interface BulkRequestBody {
  action?: BulkAction
  projectIds?: string[]
}

interface BulkResultItem {
  id: string
  success: boolean
  error?: string
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

    const body = (await request.json()) as BulkRequestBody
    const { action, projectIds } = body

    // ── Validate input ────────────────────────────────────────────────
    if (!action || !['deploy', 'stop', 'restart', 'delete'].includes(action)) {
      return NextResponse.json(
        { error: 'Invalid action. Must be one of: deploy, stop, restart, delete' },
        { status: 400 }
      )
    }

    if (!Array.isArray(projectIds) || projectIds.length === 0) {
      return NextResponse.json(
        { error: 'projectIds must be a non-empty array' },
        { status: 400 }
      )
    }

    if (projectIds.length > 100) {
      return NextResponse.json(
        { error: 'Cannot perform bulk action on more than 100 projects at once' },
        { status: 400 }
      )
    }

    // ── Verify ownership of all projects in a single query ───────────
    const projects = await db.project.findMany({
      where: {
        id: { in: projectIds },
        userId: decoded.userId,
      },
      select: {
        id: true,
        name: true,
        framework: true,
        status: true,
        subdomain: true,
      },
    })

    const ownedIds = new Set(projects.map((p) => p.id))
    const notFoundIds = projectIds.filter((id) => !ownedIds.has(id))

    const results: BulkResultItem[] = []

    // Mark projects that don't belong to the user as failed
    for (const id of notFoundIds) {
      results.push({
        id,
        success: false,
        error: 'Project not found or access denied',
      })
    }

    // ── Execute the requested action on each owned project ───────────
    for (const project of projects) {
      try {
        if (action === 'deploy') {
          // Project must be running to be deployable
          if (project.status !== 'running') {
            results.push({
              id: project.id,
              success: false,
              error: `Project is ${project.status}, must be running to deploy`,
            })
            continue
          }

          // Create a new deployment record
          const deployment = await db.deployment.create({
            data: {
              projectId: project.id,
              userId: decoded.userId,
              commit: `auto-${Date.now()}`,
              branch: 'main',
              status: 'building',
              triggeredBy: 'user',
            },
          })

          // Simulate deployment completing
          await db.deployment.update({
            where: { id: deployment.id },
            data: {
              status: 'live',
              deployUrl: `https://${project.subdomain}`,
              duration: Math.floor(Math.random() * 120) + 30,
              buildLog: `✅ Build started at ${new Date().toISOString()}\n✅ Installing dependencies...\n✅ Building ${project.framework} application...\n✅ Build completed successfully\n✅ Deployment is live at https://${project.subdomain}`,
            },
          })

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
              branch: 'main',
              bulk: true,
            },
          })

          results.push({ id: project.id, success: true })
        } else if (action === 'stop') {
          // Only running projects can be stopped
          if (project.status !== 'running') {
            results.push({
              id: project.id,
              success: false,
              error: `Project is ${project.status}, must be running to stop`,
            })
            continue
          }

          await db.project.update({
            where: { id: project.id },
            data: { status: 'stopped' },
          })

          await logAudit({
            userId: decoded.userId,
            action: 'project.stop',
            resource: 'project',
            resourceId: project.id,
            req: request,
            metadata: {
              name: project.name,
              bulk: true,
            },
          })

          results.push({ id: project.id, success: true })
        } else if (action === 'restart') {
          // Restart: set status back to running and create a new deployment
          await db.project.update({
            where: { id: project.id },
            data: { status: 'running' },
          })

          const deployment = await db.deployment.create({
            data: {
              projectId: project.id,
              userId: decoded.userId,
              commit: `restart-${Date.now()}`,
              branch: 'main',
              status: 'building',
              triggeredBy: 'user',
            },
          })

          await db.deployment.update({
            where: { id: deployment.id },
            data: {
              status: 'live',
              deployUrl: `https://${project.subdomain}`,
              duration: Math.floor(Math.random() * 120) + 30,
              buildLog: `✅ Restart triggered at ${new Date().toISOString()}\n✅ Build completed successfully\n✅ Deployment is live at https://${project.subdomain}`,
            },
          })

          await logAudit({
            userId: decoded.userId,
            action: 'project.restart',
            resource: 'project',
            resourceId: project.id,
            req: request,
            metadata: {
              name: project.name,
              deploymentId: deployment.id,
              bulk: true,
            },
          })

          results.push({ id: project.id, success: true })
        } else if (action === 'delete') {
          // Hard-delete: cascade removes env vars, analytics events,
          // pipelines, uptime monitors, website databases/backups/domains
          // (those relations have onDelete: Cascade in the schema).
          // The relations below are NOT cascaded (FK is nullable or required
          // without cascade), so we have to clean them up explicitly before
          // removing the Project row, otherwise SQLite raises a FK violation.
          await db.deployment.deleteMany({ where: { projectId: project.id } })
          await db.automationLog.deleteMany({ where: { projectId: project.id } })
          await db.githubIntegration.deleteMany({ where: { projectId: project.id } })
          await db.webhook.deleteMany({ where: { projectId: project.id } })
          // Domains keep their projectId nullable but reference the project —
          // detach them rather than deleting (the user may still own the domain).
          await db.domain.updateMany({
            where: { projectId: project.id },
            data: { projectId: null },
          })
          // Teams can own projects — detach.
          await db.project.update({
            where: { id: project.id },
            data: { teamId: null },
          })
          // Finally, remove the project row.
          await db.project.delete({
            where: { id: project.id },
          })

          await logAudit({
            userId: decoded.userId,
            action: 'project.delete',
            resource: 'project',
            resourceId: project.id,
            req: request,
            metadata: {
              name: project.name,
              framework: project.framework,
              subdomain: project.subdomain,
              bulk: true,
            },
          })

          results.push({ id: project.id, success: true })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        results.push({ id: project.id, success: false, error: message })
      }
    }

    const successCount = results.filter((r) => r.success).length
    const failedCount = results.length - successCount

    return NextResponse.json({
      success: failedCount === 0,
      action,
      results,
      summary: {
        total: results.length,
        succeeded: successCount,
        failed: failedCount,
      },
    })
  } catch (error) {
    console.error('Bulk action error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
