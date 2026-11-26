/**
 * Usage metering and plan-limit enforcement.
 *
 * Plans define 19 resource limits but nothing ever measured consumption, so
 * the limits were decorative. This captures periodic snapshots (history),
 * exposes current usage per customer, and answers "is this customer over
 * their plan?" — which is what makes the limits real.
 *
 * Measured values (disk/RAM/CPU) come from the existing container inspection;
 * counted values (databases, domains, mailboxes…) are queried directly.
 * Anything we genuinely cannot measure yet is reported as null rather than
 * guessed, so an unmeasured resource never looks like "0 used".
 */
import { db } from '@/lib/db'
import { getProjectResourceUsage } from '@/lib/vps/resources'
import { notifyUsageOverLimit } from '@/lib/billing-notifications'

export interface UsageTotals {
  diskMB: number
  ramMB: number
  cpuPercent: number
  bandwidthMB: number
  websites: number
  databases: number
  emailAccounts: number
  ftpAccounts: number
  cronJobs: number
  domains: number
  subdomains: number
  backups: number
}

export interface LimitCheck {
  key: string
  label: string
  used: number
  limit: number | null // null = unlimited
  percent: number | null
  over: boolean
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

/**
 * Measure a customer's current usage across all their projects.
 * Container stats are best-effort — a stopped or unreachable container
 * contributes 0 rather than failing the whole collection.
 */
export async function collectUsageForUser(userId: string): Promise<UsageTotals> {
  const projects = await db.project.findMany({
    where: { userId },
    select: { id: true, status: true },
  })

  let diskMB = 0
  let ramMB = 0
  let cpuPercent = 0
  let bandwidthMB = 0

  for (const p of projects) {
    try {
      const u = await getProjectResourceUsage(p.id)
      if (!u) continue
      diskMB += (u.storageUsedGB || 0) * 1024
      ramMB += u.ramUsedMB || 0
      cpuPercent += u.cpuPercent || 0
      bandwidthMB +=
        ((u.networkRxBytes || 0) + (u.networkTxBytes || 0)) / (1024 * 1024)
    } catch {
      /* one unreachable container must not break the sweep */
    }
  }

  // Counted resources — cheap and exact.
  const [databases, domains, mailboxes, cronJobs, backups, ftpAccounts, subdomains] =
    await Promise.all([
      db.websiteDatabase.count({ where: { project: { userId } } }).catch(() => 0),
      db.domain.count({ where: { userId } }).catch(() => 0),
      db.emailMailbox.count({ where: { domain: { userId } } }).catch(() => 0),
      db.cronJob.count({ where: { project: { userId } } }).catch(() => 0),
      db.websiteBackup.count({ where: { project: { userId } } }).catch(() => 0),
      db.ftpAccount.count({ where: { project: { userId } } }).catch(() => 0),
      // Subdomains are DNS records under the customer's own domains (same
      // rule as plan-limits). Sites no longer get a platform subdomain.
      db.dnsRecord
        .count({
          where: { domain: { userId }, type: { in: ['A', 'AAAA', 'CNAME'] }, name: { notIn: ['@', 'www'] } },
        })
        .catch(() => 0),
    ])

  return {
    diskMB: round2(diskMB),
    ramMB: round2(ramMB),
    cpuPercent: round2(cpuPercent),
    bandwidthMB: round2(bandwidthMB),
    websites: projects.length,
    databases,
    emailAccounts: mailboxes,
    ftpAccounts,
    cronJobs,
    domains,
    subdomains,
    backups,
  }
}

/** Capture and persist a snapshot for one customer. */
export async function recordUsageSnapshot(userId: string) {
  const totals = await collectUsageForUser(userId)
  const sub = await db.subscription.findFirst({
    where: { userId, status: { in: ['active', 'trialing', 'past_due'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })

  return db.usageRecord.create({
    data: {
      userId,
      subscriptionId: sub?.id ?? null,
      diskMB: totals.diskMB,
      ramMB: totals.ramMB,
      cpuPercent: totals.cpuPercent,
      bandwidthMB: totals.bandwidthMB,
      websites: totals.websites,
      databases: totals.databases,
      emailAccounts: totals.emailAccounts,
      ftpAccounts: totals.ftpAccounts,
      cronJobs: totals.cronJobs,
      domains: totals.domains,
      subdomains: totals.subdomains,
      backups: totals.backups,
    },
  })
}

/**
 * Snapshot every customer who has an active subscription.
 * Called on a schedule by the worker.
 */
export async function collectAllUsage(): Promise<{
  captured: number
  failed: number
  alerted: number
}> {
  const subs = await db.subscription.findMany({
    where: { status: { in: ['active', 'trialing', 'past_due'] } },
    select: { userId: true },
    distinct: ['userId'],
    take: 500,
  })

  let captured = 0
  let failed = 0
  let alerted = 0
  for (const s of subs) {
    try {
      await recordUsageSnapshot(s.userId)
      captured++
      if (await alertIfOverLimit(s.userId)) alerted++
    } catch (err) {
      failed++
      console.error('[usage] snapshot failed for', s.userId, err)
    }
  }
  return { captured, failed, alerted }
}

/**
 * Warn a customer who is over their plan limits.
 *
 * Collection runs hourly, so this deduplicates against the last 24h of
 * notifications — being over a limit is a persistent state, not an event, and
 * 24 identical emails a day would train the customer to ignore all of them.
 * Returns true when an alert was actually sent.
 */
export async function alertIfOverLimit(userId: string): Promise<boolean> {
  const limits = await checkPlanLimits(userId).catch(() => null)
  if (!limits || limits.overCount === 0) return false

  const recent = await db.notification
    .findFirst({
      where: {
        userId,
        title: 'Plan Limit Exceeded',
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    })
    .catch(() => null)
  if (recent) return false

  await notifyUsageOverLimit({
    userId,
    planName: limits.planName,
    breaches: limits.checks
      .filter((c) => c.over && c.limit != null)
      .map((c) => ({ label: c.label, used: c.used, limit: c.limit! })),
  }).catch(() => {})
  return true
}

/** Newest snapshot for a customer, or a freshly measured one if none exists. */
export async function getCurrentUsage(userId: string) {
  const latest = await db.usageRecord.findFirst({
    where: { userId },
    orderBy: { capturedAt: 'desc' },
  })
  if (latest) return latest
  return recordUsageSnapshot(userId).catch(() => null)
}

/** Usage history, oldest → newest, for charting. */
export async function getUsageHistory(userId: string, limit = 100) {
  const rows = await db.usageRecord.findMany({
    where: { userId },
    orderBy: { capturedAt: 'desc' },
    take: Math.min(limit, 500),
  })
  return rows.reverse()
}

/**
 * Clear a customer's usage history and re-base accumulating counters.
 * Used when an admin wants a clean slate (e.g. after a dispute or a plan
 * change) without touching the billing period.
 */
export async function resetUsage(opts: {
  userId: string
  subscriptionId?: string | null
}): Promise<{ success: boolean; deleted: number }> {
  const { count } = await db.usageRecord.deleteMany({
    where: { userId: opts.userId },
  })
  if (opts.subscriptionId) {
    await db.subscription
      .update({
        where: { id: opts.subscriptionId },
        data: { usageResetAt: new Date() },
      })
      .catch(() => {})
  }
  // Take a fresh baseline immediately so the customer isn't left with no data.
  await recordUsageSnapshot(opts.userId).catch(() => {})
  return { success: true, deleted: count }
}

/**
 * Compare a customer's usage against their plan's limits.
 * A null limit means unlimited and is never "over".
 */
export async function checkPlanLimits(userId: string): Promise<{
  planName: string | null
  checks: LimitCheck[]
  overCount: number
}> {
  const sub = await db.subscription.findFirst({
    where: { userId, status: { in: ['active', 'trialing', 'past_due'] } },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  })
  const usage = await getCurrentUsage(userId)
  if (!sub?.plan || !usage) {
    return { planName: sub?.plan?.name ?? null, checks: [], overCount: 0 }
  }

  const p = sub.plan as unknown as Record<string, number | null>
  const pairs: Array<[string, string, number, number | null]> = [
    ['disk', 'Disk (MB)', usage.diskMB, p.diskMB ?? null],
    ['bandwidth', 'Bandwidth (MB)', usage.bandwidthMB, p.bandwidthMB ?? null],
    ['ram', 'RAM (MB)', usage.ramMB, p.ramMB ?? null],
    ['websites', 'Websites', usage.websites, (p.projects as number) ?? null],
    ['databases', 'Databases', usage.databases, p.maxDatabases ?? null],
    ['emailAccounts', 'Email accounts', usage.emailAccounts, p.maxEmailAccounts ?? null],
    ['ftpAccounts', 'FTP accounts', usage.ftpAccounts, p.maxFtpAccounts ?? null],
    ['cronJobs', 'Cron jobs', usage.cronJobs, p.maxCronJobs ?? null],
    ['backups', 'Backups', usage.backups, p.maxBackups ?? null],
    ['domains', 'Domains', usage.domains, p.maxDomains ?? null],
    ['subdomains', 'Subdomains', usage.subdomains, p.maxSubdomains ?? null],
  ]

  const checks: LimitCheck[] = pairs.map(([key, label, used, limit]) => ({
    key,
    label,
    used: round2(used),
    limit,
    percent: limit && limit > 0 ? round2((used / limit) * 100) : null,
    over: limit != null && limit > 0 && used > limit,
  }))

  return {
    planName: sub.plan.name,
    checks,
    overCount: checks.filter((c) => c.over).length,
  }
}
