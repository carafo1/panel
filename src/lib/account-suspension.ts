/**
 * Account suspension — making it mean something.
 *
 * Setting `User.status` to suspended/fraud/closed blocked the panel login and
 * nothing else. The customer's websites stayed online, their mail kept being
 * delivered and collected, and their subscriptions carried on. For the two
 * cases the status exists for — non-payment and abuse — that is backwards:
 * the panel is the least valuable thing to take away, and the services are the
 * expensive part still being given away for free.
 *
 * This cascades a status change to the actual services. It is deliberately
 * NOT destructive: containers are stopped, mail is deactivated, nothing is
 * deleted. Restoring the account brings it all back, which matters because
 * most suspensions are resolved by the customer paying.
 *
 * Every step is best-effort and independently logged. One unreachable server
 * must not leave the rest of an abusive account running.
 */
import { db } from '@/lib/db'
import { stopProject, deployProject } from '@/lib/vps'
import { suspendEmailService, resumeEmailService } from '@/lib/email-hosting'
import { createNotification } from '@/lib/notifications'

export interface CascadeResult {
  projectsStopped: string[]
  projectsRestored: string[]
  emailSuspended: string[]
  emailRestored: string[]
  failures: string[]
}

function empty(): CascadeResult {
  return {
    projectsStopped: [],
    projectsRestored: [],
    emailSuspended: [],
    emailRestored: [],
    failures: [],
  }
}

/** Statuses that mean the customer should not be receiving service. */
export function isSuspendingStatus(status: string): boolean {
  return status === 'suspended' || status === 'fraud' || status === 'closed'
}

/**
 * Take a suspended customer's services offline.
 *
 * Websites are stopped rather than deleted, and mail is deactivated rather
 * than purged — a suspension is usually a billing dispute, and the customer is
 * expected back. Their data stays exactly where it is.
 */
/**
 * Project status for a site taken offline by a suspension. Distinct from
 * 'stopped' (which the customer chose) so a reinstatement brings back exactly
 * the sites the suspension took down, and the customer cannot simply redeploy
 * a site their unpaid account is no longer entitled to.
 */
export const SUSPENDED_PROJECT_STATUS = 'suspended'

/** Stop every live website a user owns and mark it suspended. */
export async function stopUserWebsites(
  userId: string,
  result: CascadeResult = empty()
): Promise<CascadeResult> {
  const projects = await db.project
    .findMany({
      where: { userId, status: { in: ['running', 'deploying', 'creating', 'error'] } },
      select: { id: true, name: true },
    })
    .catch(() => [])

  for (const p of projects) {
    try {
      const stopped = await stopProject(p.id)
      if (stopped.ok) result.projectsStopped.push(p.id)
      else result.failures.push(`project ${p.name}: ${stopped.message}`)
    } catch (err) {
      result.failures.push(
        `project ${p.name}: ${err instanceof Error ? err.message : 'stop threw'}`
      )
    }
    // Mark it suspended even when the stop failed (no container left, server
    // unreachable): the status is what stops the customer redeploying it and
    // what tells reinstatement to bring it back. The failure is reported.
    await db.project
      .update({ where: { id: p.id }, data: { status: SUSPENDED_PROJECT_STATUS } })
      .catch(() => {})
  }
  return result
}

export async function suspendAccountServices(
  userId: string,
  reason?: string | null
): Promise<CascadeResult> {
  const result = empty()

  // ── Websites ──
  await stopUserWebsites(userId, result)

  // ── Email ──
  const services = await db.emailService
    .findMany({ where: { userId, status: 'active' }, select: { id: true, domain: true } })
    .catch(() => [])

  for (const s of services) {
    try {
      const res = await suspendEmailService(s.id)
      if (res.success) result.emailSuspended.push(s.id)
      else result.failures.push(`email ${s.domain}: ${res.error}`)
    } catch (err) {
      result.failures.push(
        `email ${s.domain}: ${err instanceof Error ? err.message : 'suspend threw'}`
      )
    }
  }

  if (result.projectsStopped.length || result.emailSuspended.length) {
    await createNotification({
      userId,
      title: 'Your services have been suspended',
      message:
        (reason?.trim()
          ? `${reason.trim()} — `
          : 'Your account has been suspended — ') +
        'your websites are offline and email sign-in is disabled. Nothing has been deleted; everything is restored as soon as the account is reinstated.',
      type: 'error',
      link: '/?tab=billing',
    }).catch(() => {})
  }

  return result
}

/**
 * Put a reinstated customer back the way they were.
 *
 * Mail comes back on its own. Websites are re-deployed rather than "started",
 * because stopProject runs `docker compose down` — the container no longer
 * exists to start. Only projects that were previously live are rebuilt, so a
 * project the customer had deliberately stopped stays stopped.
 */
export async function restoreAccountServices(
  userId: string,
  opts: { includeStopped?: boolean } = {}
): Promise<CascadeResult> {
  const result = empty()

  const services = await db.emailService
    .findMany({ where: { userId, status: 'suspended' }, select: { id: true, domain: true } })
    .catch(() => [])

  for (const s of services) {
    try {
      const res = await resumeEmailService(s.id)
      if (res.success) result.emailRestored.push(s.id)
      else result.failures.push(`email ${s.domain}: ${res.error}`)
    } catch (err) {
      result.failures.push(
        `email ${s.domain}: ${err instanceof Error ? err.message : 'resume threw'}`
      )
    }
  }

  await restoreUserWebsites(userId, result, opts)

  if (result.projectsRestored.length || result.emailRestored.length) {
    await createNotification({
      userId,
      title: 'Your services have been restored',
      message:
        'Your account is active again. Email works immediately; any websites are being rebuilt and will be back online shortly.',
      type: 'success',
      link: '/?tab=hosting',
    }).catch(() => {})
  }

  return result
}

/**
 * Rebuild the websites a suspension took offline.
 *
 * `includeStopped` also brings back plain 'stopped' sites. Suspensions made
 * before SUSPENDED_PROJECT_STATUS existed marked their sites 'stopped', so the
 * admin reinstatement path passes it to stay compatible with those accounts.
 */
export async function restoreUserWebsites(
  userId: string,
  result: CascadeResult = empty(),
  opts: { includeStopped?: boolean } = {}
): Promise<CascadeResult> {
  const statuses = opts.includeStopped
    ? [SUSPENDED_PROJECT_STATUS, 'stopped']
    : [SUSPENDED_PROJECT_STATUS]
  // Only projects that actually have something deployed are worth rebuilding.
  const projects = await db.project
    .findMany({
      where: { userId, status: { in: statuses }, deployPath: { not: null } },
      select: { id: true, name: true, sourceBranch: true },
    })
    .catch(() => [])

  for (const p of projects) {
    try {
      const deployment = await db.deployment.create({
        data: {
          projectId: p.id,
          userId,
          commit: `reinstate-${Date.now()}`,
          branch: p.sourceBranch || 'main',
          status: 'queued',
          triggeredBy: 'admin',
          buildLog: '🔄 Account reinstated — bringing this site back online…',
        },
      })
      // Fire-and-forget: a rebuild takes minutes and the admin should not wait.
      void deployProject({
        projectId: p.id,
        deploymentId: deployment.id,
        onLog: (m) => console.log(`[reinstate ${p.id.slice(0, 8)}] ${m}`),
      }).catch((err) =>
        console.error(`[reinstate] redeploy failed for ${p.name}:`, err)
      )
      result.projectsRestored.push(p.id)
    } catch (err) {
      result.failures.push(
        `project ${p.name}: ${err instanceof Error ? err.message : 'redeploy threw'}`
      )
    }
  }

  return result
}
