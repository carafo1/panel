import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getProjectAccess, type ProjectPermission } from '@/lib/project-access'
import { purgeProject } from '@/lib/project-teardown'
import { deployProject, stopProject, restartProject } from '@/lib/vps'
import { claimDeploySlot } from '@/lib/deploy-guard'

type BulkAction = 'deploy' | 'stop' | 'restart' | 'delete'

interface BulkRequestBody {
  action?: BulkAction
  projectIds?: string[]
}

interface BulkResultItem {
  id: string
  success: boolean
  error?: string
  /** Set on a successful delete whose server-side cleanup was incomplete. */
  warning?: string
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

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const raw = await request.json().catch(() => null)
    if (!raw || typeof raw !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const body = raw as BulkRequestBody
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

    // ── Check access to each project ─────────────────────────────────
    // Team members may act on their team's projects too, so access is decided
    // per project: deploy/stop/restart need 'deploy', delete is owner-only.
    const required: ProjectPermission = action === 'delete' ? 'owner' : 'deploy'
    const results: BulkResultItem[] = []
    const allowed = new Map<string, string>() // projectId → owner's user id

    for (const id of new Set(projectIds)) {
      const access =
        typeof id === 'string' ? await getProjectAccess(decoded, id) : null
      if (!access) {
        results.push({
          id: String(id),
          success: false,
          error: 'Project not found or access denied',
        })
      } else if (!access.can(required)) {
        results.push({
          id,
          success: false,
          error:
            required === 'owner'
              ? 'Only the project owner can delete this project'
              : 'Your team role does not allow deploying, stopping or restarting this project',
        })
      } else {
        allowed.set(id, access.ownerId)
      }
    }

    const projects = await db.project.findMany({
      where: { id: { in: [...allowed.keys()] } },
      select: {
        id: true,
        name: true,
        framework: true,
        status: true,
        subdomain: true,
        sourceBranch: true,
      },
    })

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

          // Real build on the host. This previously created a deployment row,
          // immediately flipped it to "live" with a hand-written ✅ build log
          // and a Math.random() duration, and never touched the server — so a
          // bulk deploy reported success while shipping nothing.
          //
          // The slot is claimed the same way as a single deploy (check-and-
          // insert in one transaction). Creating the row directly let a bulk
          // deploy start a second concurrent build of a project that was
          // already deploying.
          const claim = await claimDeploySlot({
            projectId: project.id,
            // Deployment.userId is the project owner; the actor is audited below.
            userId: allowed.get(project.id)!,
            branch: project.sourceBranch || 'main',
            commit: `bulk-${Date.now()}`,
            triggeredBy: 'user',
            buildLog: '🚀 Queued by bulk deploy…',
          })
          if (!claim.ok) {
            results.push({
              id: project.id,
              success: false,
              error: 'A deployment is already running for this project',
            })
            continue
          }
          const deployment = { id: claim.deploymentId }

          // deployProject takes minutes and streams its own log; don't hold the
          // request open for every selected project. Failures are written back
          // to the deployment row, which is what the UI polls.
          void deployProject({
            projectId: project.id,
            deploymentId: deployment.id,
            onLog: (m) => console.log(`[bulk-deploy ${deployment.id.slice(0, 8)}] ${m}`),
          }).catch(async (err) => {
            const msg = err instanceof Error ? err.message : String(err)
            console.error(`[bulk-deploy] ${project.id} failed:`, msg)
            await db.deployment
              .update({
                where: { id: deployment.id },
                data: { status: 'failed', buildLog: `❌ Deploy failed: ${msg}` },
              })
              .catch(() => {})
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
              branch: project.sourceBranch || 'main',
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

          // Actually stop the container. This used to set the DB status to
          // "stopped" and nothing else, so the container kept running — still
          // serving traffic and still holding its host port — while the panel
          // showed it as stopped. stopProject runs `docker compose down` and
          // updates the row only once that succeeds.
          const stopped = await stopProject(project.id)
          if (!stopped.ok) {
            results.push({ id: project.id, success: false, error: stopped.message })
            continue
          }

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
        } else if (action === 'restart' && project.status === 'suspended') {
          results.push({
            id: project.id,
            success: false,
            error: 'Suspended for non-payment — pay the outstanding invoice to restore it',
          })
          continue
        } else if (action === 'restart') {
          // Real container restart. This used to flip the status to "running"
          // and write a fabricated "live" deployment with a Math.random()
          // duration, without restarting anything.
          const restarted = await restartProject(project.id)
          if (!restarted.ok) {
            results.push({ id: project.id, success: false, error: restarted.message })
            continue
          }

          await logAudit({
            userId: decoded.userId,
            action: 'project.restart',
            resource: 'project',
            resourceId: project.id,
            req: request,
            metadata: {
              name: project.name,
              bulk: true,
            },
          })

          results.push({ id: project.id, success: true })
        } else if (action === 'delete') {
          // Hard-delete, sharing the exact teardown the single-project
          // DELETE /api/hosting/[id] runs. This block used to drop the row
          // without touching the VPS, which left the container running and
          // holding its host port with no row left to clean it up from.
          const { warnings } = await purgeProject(project.id)

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
              ...(warnings.length > 0 ? { warnings } : {}),
            },
          })

          // The row is gone, so this is a success even when some server-side
          // cleanup could not be confirmed — the warning rides along.
          results.push({
            id: project.id,
            success: true,
            ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
          })
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
