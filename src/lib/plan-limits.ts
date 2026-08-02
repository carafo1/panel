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

// ─── Measured-resource overage ────────────────────────────────────────────────

export type MeasuredResource = 'disk' | 'bandwidth'

export interface OverageVerdict {
  over: boolean
  resource: MeasuredResource
  usedMB: number
  limitMB: number | null
  planName: string | null
  /** How stale the measurement is, in minutes. */
  measuredMinutesAgo: number | null
  response?: Response
}

const MEASURED_COLUMN: Record<MeasuredResource, string> = {
  disk: 'diskMB',
  bandwidth: 'bandwidthMB',
}

const MEASURED_LABEL: Record<MeasuredResource, string> = {
  disk: 'storage',
  bandwidth: 'bandwidth',
}

function formatMB(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/**
 * Is the customer over their measured allowance for this resource?
 *
 * Returns over:false when there is no plan, no limit, or no usage snapshot yet
 * — an absent measurement must never block a customer, or a worker outage
 * becomes an outage for everyone.
 */
export async function checkOverage(
  userId: string,
  resource: MeasuredResource,
  opts: { role?: string } = {}
): Promise<OverageVerdict> {
  const none: OverageVerdict = {
    over: false,
    resource,
    usedMB: 0,
    limitMB: null,
    planName: null,
    measuredMinutesAgo: null,
  }

  if (opts.role && isAdmin(opts.role)) return none

  const sub = await db.subscription.findFirst({
    where: { userId, status: { in: ['active', 'trialing', 'past_due'] } },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  })
  if (!sub?.plan) return none

  const rawLimit = (sub.plan as unknown as Record<string, unknown>)[
    MEASURED_COLUMN[resource]
  ]
  const limitMB = typeof rawLimit === 'number' && rawLimit > 0 ? rawLimit : null
  if (limitMB === null) return { ...none, planName: sub.plan.name }

  const snapshot = await db.usageRecord.findFirst({
    where: { userId },
    orderBy: { capturedAt: 'desc' },
    select: { diskMB: true, bandwidthMB: true, capturedAt: true },
  })
  if (!snapshot) return { ...none, limitMB, planName: sub.plan.name }

  const usedMB = resource === 'disk' ? snapshot.diskMB : snapshot.bandwidthMB
  const measuredMinutesAgo = Math.round(
    (Date.now() - new Date(snapshot.capturedAt).getTime()) / 60000
  )

  if (usedMB <= limitMB) {
    return {
      over: false,
      resource,
      usedMB,
      limitMB,
      planName: sub.plan.name,
      measuredMinutesAgo,
    }
  }

  return {
    over: true,
    resource,
    usedMB,
    limitMB,
    planName: sub.plan.name,
    measuredMinutesAgo,
    response: Response.json(
      {
        error:
          `You are using ${formatMB(usedMB)} of ${MEASURED_LABEL[resource]} and your ` +
          `${sub.plan.name} plan includes ${formatMB(limitMB)}. Free some space or ` +
          `upgrade your plan before creating anything new.`,
        code: 'plan_overage',
        resource,
        usedMB: Math.round(usedMB),
        limitMB,
      },
      { status: 403 }
    ),
  }
}

/**
 * Convenience wrapper: the 403 Response to return, or null to proceed.
 *
 *   const denied = await enforceOverage(userId, 'disk', { role })
 *   if (denied) return denied
 */
export async function enforceOverage(
  userId: string,
  resource: MeasuredResource,
  opts: { role?: string } = {}
): Promise<Response | null> {
  const verdict = await checkOverage(userId, resource, opts)
  return verdict.over ? verdict.response! : null
}
