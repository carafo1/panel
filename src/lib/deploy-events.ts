/**
 * Tell people a deployment changed state: the customer's webhooks always, and
 * the owner by email when it fails.
 *
 * A failed deploy used to be visible only to someone watching the panel. An
 * auto-deploy triggered by a push, or a reinstatement after payment, could
 * fail with nobody ever finding out. Success is not emailed: auto-deploys
 * would turn that into noise, and the site being up is the signal.
 *
 * Never throws — a notification problem must never fail a deployment.
 */
import { db } from '@/lib/db'
import { emitWebhookEvent } from '@/lib/webhook-delivery'
import { sendDeploymentEmail } from '@/lib/email'
import { siteUrl, publicUrlOrNull } from '@/lib/site-address'

export type DeployPhase = 'started' | 'success' | 'failed'

export async function announceDeployment(opts: {
  projectId: string
  deploymentId: string
  phase: DeployPhase
  error?: string | null
  durationMs?: number
}): Promise<void> {
  try {
    const [project, deployment] = await Promise.all([
      db.project.findUnique({
        where: { id: opts.projectId },
        select: {
          id: true,
          name: true,
          userId: true,
          customDomain: true,
          user: { select: { email: true } },
        },
      }),
      db.deployment.findUnique({
        where: { id: opts.deploymentId },
        select: { id: true, branch: true, commit: true, triggeredBy: true, deployUrl: true },
      }),
    ])
    if (!project) return

    // The site's real domain only; null when none is connected.
    const url = publicUrlOrNull(deployment?.deployUrl) || siteUrl(project)

    await emitWebhookEvent(
      project.userId,
      `deployment.${opts.phase}`,
      {
        project: { id: project.id, name: project.name },
        deployment: {
          id: opts.deploymentId,
          branch: deployment?.branch ?? null,
          commit: deployment?.commit ?? null,
          triggeredBy: deployment?.triggeredBy ?? null,
        },
        url,
        ...(opts.durationMs !== undefined ? { durationSeconds: Math.round(opts.durationMs / 1000) } : {}),
        ...(opts.error ? { error: opts.error.slice(0, 500) } : {}),
      },
      { projectId: project.id }
    )

    if (opts.phase === 'failed' && project.user?.email) {
      await sendDeploymentEmail(project.user.email, project.name, 'failed', url ?? undefined)
    }
  } catch (err) {
    console.error('[deploy-events] announce failed:', err)
  }
}
