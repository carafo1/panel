/**
 * One deployment per project at a time.
 *
 * The deploy route used to gate on `project.status`, which has two problems:
 *
 *   - it is a check-then-act on a value the deployer sets a moment later, so
 *     two clicks landing together both read a deployable status and both
 *     proceed. Docker then runs two builds of the same image concurrently;
 *     BuildKit dedupes the layers, so the second finishes suspiciously fast
 *     and the stage timings disagree with the build log.
 *
 *   - if the panel restarts mid-build the status stays 'building' forever and
 *     the project can never be deployed again. A lock with no way out is worse
 *     than the duplicate it prevents.
 *
 * So the lock lives on the Deployment row (the thing that actually represents
 * a run), and it expires.
 */
import { db } from './db'

/** Statuses that mean "this deployment is still going". */
export const ACTIVE_DEPLOY_STATUSES = ['queued', 'building', 'deploying']

/**
 * How long a deployment may stay active before we assume its process died.
 *
 * Must exceed the deployer's own build timeout (1800s) with room to spare, or
 * a legitimately slow build would be reaped out from under itself.
 */
export const STALE_DEPLOY_MS = 45 * 60 * 1000

export interface InFlight {
  id: string
  status: string
  createdAt: Date
  ageMs: number
}

/**
 * Mark deployments that outlived their process as failed.
 *
 * Called before the in-flight check so a crashed run cannot block the project
 * indefinitely. Returns how many were reaped.
 */
export async function reapStaleDeployments(projectId?: string): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_DEPLOY_MS)
  const res = await db.deployment.updateMany({
    where: {
      ...(projectId ? { projectId } : {}),
      status: { in: ACTIVE_DEPLOY_STATUSES },
      createdAt: { lt: cutoff },
    },
    data: {
      status: 'failed',
      buildLog:
        '❌ Abandoned: this deployment was still marked active long after the ' +
        'build timeout, so the process running it is gone (most likely the ' +
        'panel restarted mid-build). Marked failed so the project can deploy ' +
        'again.',
    },
  })
  return res.count
}

/** The deployment currently running for this project, if any. */
export async function findInFlightDeployment(
  projectId: string
): Promise<InFlight | null> {
  const row = await db.deployment.findFirst({
    where: { projectId, status: { in: ACTIVE_DEPLOY_STATUSES } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, createdAt: true },
  })
  if (!row) return null
  return { ...row, ageMs: Date.now() - new Date(row.createdAt).getTime() }
}

/**
 * Claim the right to deploy this project, or report who already holds it.
 *
 * The check and the insert run in one transaction. SQLite serialises writers,
 * so two simultaneous requests cannot both come away with a deployment.
 */
export async function claimDeploySlot(input: {
  projectId: string
  userId: string
  branch: string
  commit?: string
  triggeredBy: string
  buildLog: string
}): Promise<
  | { ok: true; deploymentId: string; createdAt: Date }
  | { ok: false; existing: InFlight }
> {
  await reapStaleDeployments(input.projectId)

  return db.$transaction(async (tx) => {
    const row = await tx.deployment.findFirst({
      where: {
        projectId: input.projectId,
        status: { in: ACTIVE_DEPLOY_STATUSES },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, createdAt: true },
    })
    if (row) {
      return {
        ok: false as const,
        existing: {
          ...row,
          ageMs: Date.now() - new Date(row.createdAt).getTime(),
        },
      }
    }
    const created = await tx.deployment.create({
      data: {
        projectId: input.projectId,
        userId: input.userId,
        commit: input.commit || `auto-${Date.now()}`,
        branch: input.branch,
        status: 'building',
        triggeredBy: input.triggeredBy,
        buildLog: input.buildLog,
      },
      select: { id: true, createdAt: true },
    })
    return {
      ok: true as const,
      deploymentId: created.id,
      createdAt: created.createdAt,
    }
  })
}
