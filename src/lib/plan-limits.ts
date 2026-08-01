/**
 * Plan limit enforcement.
 *
 * `checkPlanLimits()` in lib/usage.ts computes every quota correctly — and
 * nothing ever blocked on it. It fed a progress bar and an over-limit alert, so
 * a Starter customer could create unlimited databases, FTP accounts, cron jobs
 * and domains: the bar filled past 100% and the create succeeded anyway.
 *
 * This is the enforcement half. One place resolves the plan, counts what the
 * customer already has, and refuses the create when it would exceed the
 * allowance — the same shape as the project-count check that
 * /api/hosting/create has always done correctly.
 *
 * Conventions that matter:
 *   - null or 0 on a limit column means UNLIMITED, matching the rest of the
 *     catalogue. Treating 0 as "none allowed" would lock out every plan whose
 *     unlimited resources are stored as 0.
 *   - No active subscription means no plan to enforce. Free/legacy accounts are
 *     not silently capped at someone else's numbers; that is a business
 *     decision, not something to infer here.
 *   - Admins are never limited.
 */
import { db } from './db'
import { isAdmin } from './security'

/** Resources that can be capped by a plan, mapped to their Plan column. */
export type LimitedResource =
  | 'databases'
  | 'ftpAccounts'
  | 'cronJobs'
  | 'domains'
  | 'subdomains'
  | 'backups'
  | 'websites'

const PLAN_COLUMN: Record<LimitedResource, string> = {
  databases: 'maxDatabases',
  ftpAccounts: 'maxFtpAccounts',
  cronJobs: 'maxCronJobs',
  domains: 'maxDomains',
  subdomains: 'maxSubdomains',
  backups: 'maxBackups',
  websites: 'projects',
}

const LABEL: Record<LimitedResource, string> = {
  databases: 'database',
  ftpAccounts: 'FTP account',
  cronJobs: 'cron job',
  domains: 'domain',
  subdomains: 'subdomain',
  backups: 'backup',
  websites: 'website',
}

export interface LimitVerdict {
  allowed: boolean
  /** Null when the plan does not cap this resource. */
  limit: number | null
  used: number
  planName: string | null
  /** Ready-to-return 403 when `allowed` is false. */
  response?: Response
}

/** Count what the user currently has of one resource, across all their sites. */
async function countUsage(
  userId: string,
  resource: LimitedResource
): Promise<number> {
  switch (resource) {
    case 'websites':
      return db.project.count({ where: { userId } })

    case 'domains':
      // Deleted rows are tombstones, not live domains.
      return db.domain.count({ where: { userId, status: { not: 'deleted' } } })

    case 'databases':
      return db.websiteDatabase.count({ where: { project: { userId } } })

    case 'ftpAccounts':
      return db.ftpAccount.count({ where: { project: { userId } } })

    case 'cronJobs':
      return db.cronJob.count({ where: { project: { userId } } })

    case 'backups':
      return db.websiteBackup.count({ where: { project: { userId } } })

    case 'subdomains':
      // A subdomain is a DNS record under a domain the user owns; the apex
      // ("@") and www are part of the domain itself, not extra subdomains.
      return db.dnsRecord.count({
        where: {
          domain: { userId },
          type: { in: ['A', 'AAAA', 'CNAME'] },
          name: { notIn: ['@', 'www'] },
        },
      })
  }
}

/**
 * Decide whether the user may create one more of `resource`.
 *
 * Call this BEFORE creating anything. `addition` covers bulk creates.
 */
export async function checkLimit(
  userId: string,
  resource: LimitedResource,
  opts: { role?: string; addition?: number } = {}
): Promise<LimitVerdict> {
  const addition = opts.addition ?? 1

  if (opts.role && isAdmin(opts.role)) {
    return { allowed: true, limit: null, used: 0, planName: null }
  }

  const sub = await db.subscription.findFirst({
    where: { userId, status: { in: ['active', 'trialing', 'past_due'] } },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  })

  // No plan, nothing to enforce.
  if (!sub?.plan) {
    return { allowed: true, limit: null, used: 0, planName: null }
  }

  const raw = (sub.plan as unknown as Record<string, unknown>)[PLAN_COLUMN[resource]]
  const limit = typeof raw === 'number' ? raw : null

  // null/0 = unlimited.
  if (limit === null || limit <= 0) {
    return { allowed: true, limit: null, used: 0, planName: sub.plan.name }
  }

  const used = await countUsage(userId, resource)
  if (used + addition <= limit) {
    return { allowed: true, limit, used, planName: sub.plan.name }
  }

  const noun = LABEL[resource]
  return {
    allowed: false,
    limit,
    used,
    planName: sub.plan.name,
    response: Response.json(
      {
        error:
          `Your ${sub.plan.name} plan includes ${limit} ${noun}${limit === 1 ? '' : 's'} ` +
          `and you are using ${used}. Upgrade your plan to add more.`,
        code: 'plan_limit_reached',
        resource,
        limit,
        used,
      },
      { status: 403 }
    ),
  }
}

/**
 * Convenience wrapper: returns the 403 Response to return, or null to proceed.
 *
 *   const denied = await enforceLimit(userId, 'databases', { role })
 *   if (denied) return denied
 */
export async function enforceLimit(
  userId: string,
  resource: LimitedResource,
  opts: { role?: string; addition?: number } = {}
): Promise<Response | null> {
  const verdict = await checkLimit(userId, resource, opts)
  return verdict.allowed ? null : verdict.response!
}
