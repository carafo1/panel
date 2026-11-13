/**
 * /api/deployments/[id]
 *
 *   DELETE — remove one deployment record and its stages.
 *
 * There was no way to delete a deployment at all. Records accumulated for the
 * life of a project, each carrying a buildLog that can run to hundreds of
 * kilobytes, and the only way to clear them was to delete the whole project.
 *
 * Two refusals, both deliberate:
 *
 *   - The LIVE deployment cannot be deleted. It is the record of what is
 *     actually running; removing it would leave the panel unable to say what
 *     is deployed, and the deploy history is what rollback reads.
 *   - The most recent successful deployment cannot be deleted while it is the
 *     only rollback target. Deleting the thing you would roll back TO is a
 *     decision people make at the worst possible moment.
 *
 * DeploymentStage has onDelete: Cascade, so its rows go with it.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { requireProjectAccess } from '@/lib/project-access'
import { withRateLimit } from '@/lib/rate-limit'

async function deleteHandler(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const user = await authenticateRequest(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const { id } = await ctx.params

  const deployment = await db.deployment.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      projectId: true,
      createdAt: true,
      project: { select: { name: true } },
    },
  })
  if (!deployment) {
    return NextResponse.json({ error: 'Deployment not found' }, { status: 404 })
  }

  // Scoped to the project (owner, team members with deploy rights, admins).
  // Without this, any authenticated user could delete another customer's
  // deployment history by guessing an id.
  const access = await requireProjectAccess(user, deployment.projectId, 'deploy')
  if (!access.ok) return access.response

  if (deployment.status === 'live') {
    return NextResponse.json(
      {
        error:
          'This is the deployment currently serving the site. Deploy again first, ' +
          'then this one can be removed.',
        code: 'is_live',
      },
      { status: 409 }
    )
  }

  if (deployment.status === 'building' || deployment.status === 'deploying') {
    return NextResponse.json(
      {
        error: 'This deployment is still running. Wait for it to finish.',
        code: 'in_progress',
      },
      { status: 409 }
    )
  }

  // Keep at least one rollback target. Someone tidying up should not be able to
  // remove the only thing they could roll back to.
  if (deployment.status === 'rolled_back' || deployment.status === 'succeeded') {
    const others = await db.deployment.count({
      where: {
        projectId: deployment.projectId,
        id: { not: deployment.id },
        status: { in: ['live', 'rolled_back', 'succeeded'] },
      },
    })
    if (others === 0) {
      return NextResponse.json(
        {
          error:
            'This is the only successful deployment for this site — it is the ' +
            'one you would roll back to. Deploy again before removing it.',
          code: 'last_good',
        },
        { status: 409 }
      )
    }
  }

  // Stages go with it: DeploymentStage declares onDelete: Cascade.
  await db.deployment.delete({ where: { id } })

  await logAudit({
    userId: user.userId,
    action: 'deployment.deleted',
    resource: 'deployment',
    resourceId: id,
    req: request,
    metadata: {
      projectId: deployment.projectId,
      project: deployment.project?.name,
      status: deployment.status,
      createdAt: deployment.createdAt,
    },
  }).catch(() => {})

  return NextResponse.json({ ok: true, deleted: id, message: 'Deployment removed.' })
}

export const DELETE = withRateLimit(deleteHandler, { limit: 30, windowMs: 60_000 })
