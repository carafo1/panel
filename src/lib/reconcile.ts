/**
 * Provisioning reconciliation.
 *
 * Two jobs, both run from the worker tick under a CronLock lease so they
 * never overlap themselves across processes:
 *
 *   - sweepProvisioning ('provision-reconcile', every 5 min): re-drives paid
 *     orders whose provisioning never started, failed before any side effect,
 *     or was abandoned by a crashed run. Everything goes through the same
 *     atomic claim in provisionForPayment, so racing a live run is harmless.
 *
 *   - runReconcile ('reconcile', hourly): the sweep above, read-only registrar
 *     checks (transfers, expiry), the infrastructure checks in
 *     infra-reconcile.ts (containers, certificates, registrar drift), plus a
 *     REPORT of what needs a human. It never sends a registrar purchase
 *     command; besides the sweep it only marks projects whose builds all
 *     ended but which still say 'creating' as 'error', records verified
 *     certificate status, and corrects expiry dates from the registrar.
 *
 * Both are idempotent and safe to run by hand (admin route).
 */
import { db } from '@/lib/db'
import {
  provisionForPayment,
  provisionRetryDelayMs,
  type ProvisionStatus,
} from '@/lib/provision-on-payment'
import { acquireCronLease } from '@/lib/renewals'
import { ACTIVE_DEPLOY_STATUSES, reapStaleDeployments } from '@/lib/deploy-guard'
import { getDomainInfo, isDynadotDemoMode } from '@/lib/dynadot'
import { runInfraReconcile, type InfraDeps, type InfraReconcileSummary } from '@/lib/infra-reconcile'

// ── Domain orders and registrar state ─────────────────────────────────────

/** Read-only registrar lookup. Injectable so tests never reach Dynadot. */
export type DomainInfoReader = (domain: string) => Promise<{ status: string; expiry?: string }>

export interface DomainReconcileDeps {
  getInfo?: DomainInfoReader
  /** Run even when no registrar key is configured (tests with a fake reader). */
  force?: boolean
}

const DOMAIN_BATCH = 25

/**
 * No registrar key, or a test run (Prisma loads the real .env into the test
 * process, so a key may be present): registrar lookups are skipped. Tests
 * that exercise polling inject a fake reader with force.
 */
function registrarPollingDisabled(): boolean {
  return isDynadotDemoMode() || process.env.NODE_ENV === 'test'
}

function parseJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function registrarExpiry(info: { expiry?: string } | null): Date | null {
  if (!info?.expiry) return null
  const d = new Date(info.expiry)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Failed domain orders become retryable ONLY when the registrar was never
 * called for them (registrarCalledAt null): nothing can have been bought, so
 * a retry cannot buy twice. 'manual_review' orders are never touched — they
 * are listed for an operator (reconciliation or refund). The retry itself
 * happens when the order's payment is re-driven (sweep or admin retry).
 */
export async function requeueFailedDomainOrders(): Promise<number> {
  const res = await db.domainOrder.updateMany({
    where: { status: 'failed', registrarCalledAt: null },
    data: { status: 'retry_pending' },
  })
  return res.count
}

export interface TransferPollSummary {
  skipped?: string
  checked: number
  completed: Array<{ domain: string; expiresAt: string }>
  stillPending: string[]
}

/**
 * Finish transfers the registrar has completed. Read-only registrar calls
 * (domain_info): a domain appears in our registrar account, with an expiry,
 * only once its transfer has gone through. No purchase command is ever sent.
 */
export async function pollTransfers(deps: DomainReconcileDeps = {}): Promise<TransferPollSummary> {
  if (!deps.force && registrarPollingDisabled()) {
    return { skipped: 'registrar lookups disabled (no registrar key, or a test run)', checked: 0, completed: [], stillPending: [] }
  }
  const getInfo = deps.getInfo ?? getDomainInfo

  const [orders, domains] = await Promise.all([
    db.domainOrder.findMany({
      where: { status: 'transfer_pending' },
      select: { domainName: true },
      take: DOMAIN_BATCH,
    }),
    db.domain.findMany({
      where: { transferStatus: 'pending', status: { not: 'deleted' } },
      select: { name: true },
      take: DOMAIN_BATCH,
    }),
  ])
  const names = [...new Set([...orders.map((o) => o.domainName), ...domains.map((d) => d.name)])]
    .map((n) => n.toLowerCase())
    .slice(0, DOMAIN_BATCH)

  const summary: TransferPollSummary = { checked: names.length, completed: [], stillPending: [] }
  for (const name of names) {
    let expiry: Date | null = null
    try {
      expiry = registrarExpiry(await getInfo(name))
    } catch {
      expiry = null // not in our account yet: still transferring
    }
    if (!expiry) {
      summary.stillPending.push(name)
      continue
    }
    await db.domain.updateMany({
      where: { name, transferStatus: 'pending' },
      data: { status: 'active', transferStatus: 'completed', expiresAt: expiry },
    })
    await db.domainOrder.updateMany({
      where: { domainName: name, status: 'transfer_pending' },
      data: { status: 'completed' },
    })
    summary.completed.push({ domain: name, expiresAt: expiry.toISOString() })
  }
  return summary
}

export interface ExpiryReconcileSummary {
  skipped?: string
  checked: number
  filled: Array<{ domain: string; expiresAt: string }>
  unresolved: string[]
}

/**
 * Fill expiry dates the registrar could not be read back for at purchase /
 * renewal time. Sources: active Dynadot domains with expiresAt null, orders
 * flagged needsReconciliation:'expiry', and pending 'reconcile_expiry' logs.
 * The value always comes from the registrar (domain_info), never computed.
 */
export async function reconcileDomainExpiry(
  deps: DomainReconcileDeps = {}
): Promise<ExpiryReconcileSummary> {
  if (!deps.force && registrarPollingDisabled()) {
    return { skipped: 'registrar lookups disabled (no registrar key, or a test run)', checked: 0, filled: [], unresolved: [] }
  }
  const getInfo = deps.getInfo ?? getDomainInfo

  const [nullExpiry, flaggedOrders, pendingLogs] = await Promise.all([
    db.domain.findMany({
      where: { provider: 'dynadot', status: 'active', expiresAt: null },
      select: { name: true },
      take: DOMAIN_BATCH,
    }),
    db.domainOrder.findMany({
      where: { metadata: { contains: '"needsReconciliation":"expiry"' } },
      select: { id: true, domainName: true, metadata: true },
      take: DOMAIN_BATCH,
    }),
    db.domainLog.findMany({
      where: { action: 'reconcile_expiry', status: 'pending' },
      select: { id: true, domainId: true, metadata: true, domain: { select: { name: true } } },
      take: DOMAIN_BATCH,
    }),
  ])

  const logName = (l: (typeof pendingLogs)[number]) =>
    l.domain?.name || (typeof parseJson(l.metadata).domain === 'string' ? (parseJson(l.metadata).domain as string) : '')
  const names = [
    ...new Set(
      [
        ...nullExpiry.map((d) => d.name),
        ...flaggedOrders.map((o) => o.domainName),
        ...pendingLogs.map(logName),
      ]
        .filter(Boolean)
        .map((n) => n.toLowerCase())
    ),
  ].slice(0, DOMAIN_BATCH)

  const summary: ExpiryReconcileSummary = { checked: names.length, filled: [], unresolved: [] }
  for (const name of names) {
    let expiry: Date | null = null
    try {
      expiry = registrarExpiry(await getInfo(name))
    } catch {
      expiry = null
    }
    if (!expiry) {
      summary.unresolved.push(name)
      continue
    }
    const domain = await db.domain.findUnique({ where: { name }, select: { id: true, userId: true } })
    if (!domain) {
      summary.unresolved.push(name)
      continue
    }
    await db.domain.update({ where: { id: domain.id }, data: { expiresAt: expiry } })

    for (const o of flaggedOrders.filter((x) => x.domainName.toLowerCase() === name)) {
      const m = parseJson(o.metadata)
      delete m.needsReconciliation
      await db.domainOrder.update({
        where: { id: o.id },
        data: { metadata: JSON.stringify({ ...m, expiryReconciledAt: new Date().toISOString() }) },
      })
    }
    const logIds = pendingLogs.filter((l) => logName(l).toLowerCase() === name).map((l) => l.id)
    if (logIds.length) {
      await db.domainLog.updateMany({ where: { id: { in: logIds } }, data: { status: 'success' } })
    }
    await db.domainLog
      .create({
        data: {
          domainId: domain.id,
          userId: domain.userId,
          action: 'reconcile_expiry',
          status: 'success',
          message: `Expiry set from the registrar: ${expiry.toISOString()}`,
        },
      })
      .catch(() => {})
    summary.filled.push({ domain: name, expiresAt: expiry.toISOString() })
  }
  return summary
}

const MINUTE = 60 * 1000
/** A completed payment gets this long to be provisioned by activation itself. */
export const UNPROVISIONED_GRACE_MS = 5 * MINUTE
export const PROVISION_SWEEP_INTERVAL_MS = 5 * MINUTE
export const RECONCILE_INTERVAL_MS = 60 * MINUTE
const SWEEP_BATCH = 20

/** Exact text activatePayment writes into the metadata JSON. */
const PROVISION_REQUIRED_MARK = '"provisionRequired":true'

export interface SweepSummary {
  examined: number
  outcomes: Array<{ paymentId: string; from: string; status: ProvisionStatus | 'not_claimed'; detail: string }>
}

/**
 * Re-drive provisioning for paid orders that need it:
 *   - completed, marked provisionRequired, never claimed, older than 5 min;
 *   - 'retry_pending' whose backoff (by attempts) has elapsed;
 *   - 'claimed' / 'provisioning' whose lease expired.
 * 'manual_review' and 'failed' are never touched here.
 */
export async function sweepProvisioning(now = new Date()): Promise<SweepSummary> {
  const graceCutoff = new Date(now.getTime() - UNPROVISIONED_GRACE_MS)

  const [neverStarted, retryable, abandoned] = await Promise.all([
    db.payment.findMany({
      where: {
        status: 'completed',
        provisionStatus: 'none',
        provisionClaimedAt: null,
        createdAt: { lt: graceCutoff },
        metadata: { contains: PROVISION_REQUIRED_MARK },
      },
      select: { id: true, provisionStatus: true },
      orderBy: { createdAt: 'asc' },
      take: SWEEP_BATCH,
    }),
    db.payment.findMany({
      where: { status: 'completed', provisionStatus: 'retry_pending' },
      select: { id: true, provisionStatus: true, provisionAttempts: true, provisionClaimedAt: true },
      orderBy: { provisionClaimedAt: 'asc' },
      take: SWEEP_BATCH * 5,
    }),
    db.payment.findMany({
      where: {
        status: 'completed',
        provisionStatus: { in: ['claimed', 'provisioning'] },
        provisionLeaseUntil: { lt: now },
      },
      select: { id: true, provisionStatus: true },
      take: SWEEP_BATCH,
    }),
  ])

  const due = retryable.filter((p) => {
    const last = p.provisionClaimedAt?.getTime() ?? 0
    return last + provisionRetryDelayMs(p.provisionAttempts) <= now.getTime()
  })

  const candidates = [...neverStarted, ...due, ...abandoned].slice(0, SWEEP_BATCH)
  const outcomes: SweepSummary['outcomes'] = []
  for (const p of candidates) {
    try {
      const r = await provisionForPayment(p.id)
      outcomes.push({
        paymentId: p.id,
        from: p.provisionStatus,
        status: r.status ?? 'not_claimed',
        detail: r.detail,
      })
    } catch (err) {
      outcomes.push({
        paymentId: p.id,
        from: p.provisionStatus,
        status: 'not_claimed',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { examined: candidates.length, outcomes }
}

export interface ReconcileSummary {
  ranAt: string
  sweep: SweepSummary
  /** Payments a human must look at. */
  payments: Array<{
    id: string
    userId: string
    amount: number
    currency: string
    provisionStatus: string
    provisionAttempts: number
    provisionError: string | null
  }>
  /** Domain orders needing reconciliation with the registrar (no calls made). */
  domainOrders: Array<{
    id: string
    userId: string
    domainName: string
    status: string
    reason: string
  }>
  /** Projects that sat in 'creating' with no build running. */
  stuckProjects: Array<{ id: string; userId: string; name: string; action: 'marked_error' | 'report_only' }>
  /** Email services still 'pending' after 15 minutes. */
  pendingEmail: Array<{ id: string; userId: string; domain: string; lastError: string | null }>
  reapedDeployments: number
  /** Failed domain orders made retryable (registrar never called). */
  requeuedDomainOrders: number
  transfers: TransferPollSummary
  expiry: ExpiryReconcileSummary
  /** Containers, certificates and registrar state compared with the database. */
  infra: InfraReconcileSummary
}

/** The read-only part: everything that needs attention. Changes nothing. */
export async function reconcileReport(now = new Date()) {
  const hourAgo = new Date(now.getTime() - 60 * MINUTE)
  const quarterAgo = new Date(now.getTime() - 15 * MINUTE)

  const [payments, orders, pendingEmail] = await Promise.all([
    db.payment.findMany({
      where: { provisionStatus: { in: ['failed', 'manual_review', 'retry_pending'] } },
      select: {
        id: true,
        userId: true,
        amount: true,
        currency: true,
        provisionStatus: true,
        provisionAttempts: true,
        provisionError: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    db.domainOrder.findMany({
      where: {
        OR: [
          { status: { in: ['failed', 'manual_review', 'retry_pending'] } },
          { status: 'processing', updatedAt: { lt: hourAgo } },
          { registrarCalledAt: { not: null }, registrarConfirmedAt: null },
        ],
      },
      select: {
        id: true,
        userId: true,
        domainName: true,
        status: true,
        registrarCalledAt: true,
        registrarConfirmedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    }),
    db.emailService.findMany({
      where: { status: 'pending', createdAt: { lt: quarterAgo } },
      select: { id: true, userId: true, domain: true, lastError: true },
      take: 200,
    }),
  ])

  return {
    payments,
    domainOrders: orders.map((o) => ({
      id: o.id,
      userId: o.userId,
      domainName: o.domainName,
      status: o.status,
      reason:
        o.status === 'manual_review'
          ? 'manual review: reconcile with the registrar or refund'
          : o.registrarCalledAt && !o.registrarConfirmedAt
          ? 'registrar called, outcome unconfirmed'
          : o.status === 'processing'
            ? 'processing for over an hour'
            : o.status,
    })),
    pendingEmail,
  }
}

/**
 * Projects left 'creating' for over an hour with no build in progress. Ones
 * whose builds all ended are marked 'error' (so the owner sees it and can
 * redeploy); ones that never had a build are only reported, because a project
 * awaiting its first upload is legitimately 'creating'.
 */
async function settleStuckProjects(now: Date) {
  const hourAgo = new Date(now.getTime() - 60 * MINUTE)
  const stuck = await db.project.findMany({
    where: {
      status: 'creating',
      updatedAt: { lt: hourAgo },
      deployments: { none: { status: { in: ACTIVE_DEPLOY_STATUSES } } },
    },
    select: { id: true, userId: true, name: true, _count: { select: { deployments: true } } },
    take: 200,
  })
  const result: ReconcileSummary['stuckProjects'] = []
  for (const p of stuck) {
    if (p._count.deployments === 0) {
      result.push({ id: p.id, userId: p.userId, name: p.name, action: 'report_only' })
      continue
    }
    // Conditional: a deploy that started since the read keeps its status.
    const res = await db.project.updateMany({
      where: {
        id: p.id,
        status: 'creating',
        deployments: { none: { status: { in: ACTIVE_DEPLOY_STATUSES } } },
      },
      data: { status: 'error' },
    })
    result.push({
      id: p.id,
      userId: p.userId,
      name: p.name,
      action: res.count === 1 ? 'marked_error' : 'report_only',
    })
  }
  return result
}

/** Hourly reconcile: sweep, reap, then report. */
export async function runReconcile(
  now = new Date(),
  deps: DomainReconcileDeps & { infra?: InfraDeps } = {}
): Promise<ReconcileSummary> {
  const requeuedDomainOrders = await requeueFailedDomainOrders()
  const sweep = await sweepProvisioning(now)
  const transfers = await pollTransfers(deps).catch((err) => ({
    skipped: `transfer poll failed: ${err instanceof Error ? err.message : String(err)}`,
    checked: 0,
    completed: [],
    stillPending: [],
  }))
  const expiry = await reconcileDomainExpiry(deps).catch((err) => ({
    skipped: `expiry reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
    checked: 0,
    filled: [],
    unresolved: [],
  }))
  const reapedDeployments = await reapStaleDeployments().catch(() => 0)
  const stuckProjects = await settleStuckProjects(now)
  const infra = await runInfraReconcile({ ...deps.infra, now })
  const report = await reconcileReport(now)
  const summary: ReconcileSummary = {
    ranAt: now.toISOString(),
    sweep,
    reapedDeployments,
    requeuedDomainOrders,
    transfers,
    expiry,
    stuckProjects,
    infra,
    ...report,
  }
  console.log(
    `[reconcile] sweep=${sweep.examined} payments_needing_attention=${report.payments.length} ` +
      `domain_orders=${report.domainOrders.length} stuck_projects=${stuckProjects.length} ` +
      `pending_email=${report.pendingEmail.length} reaped=${reapedDeployments} ` +
      `containers_missing=${infra.containers.missing.length} containers_stopped=${infra.containers.notRunning.length} ` +
      `certs_not_served=${infra.certificates.notServed.length} certs_expiring=${infra.certificates.expiringSoon.length} ` +
      `registrar_expiry_fixed=${infra.registrar.expiryCorrected.length} registrar_lookup_failed=${infra.registrar.lookupFailed.length}`
  )
  return summary
}

/**
 * Called from every worker tick. The lease doubles as the schedule: it is
 * taken for the job's interval and NOT released, so the next tick inside the
 * interval is refused and the job runs at most once per interval across all
 * processes. A crashed run's lease simply expires.
 */
export async function runScheduledReconcile(): Promise<void> {
  if (await acquireCronLease('provision-reconcile', PROVISION_SWEEP_INTERVAL_MS)) {
    await requeueFailedDomainOrders()
    const s = await sweepProvisioning()
    if (s.examined > 0) {
      console.log(`[reconcile] provisioning sweep re-drove ${s.examined} payment(s)`, s.outcomes)
    }
    // Temporary IP bans end on time: disable expired rules and rewrite the
    // proxy for those sites (the Caddyfile is static between regenerations).
    const { expireIpRules } = await import('@/lib/vps/proxy')
    const expired = await expireIpRules().catch((err) => {
      console.error('[reconcile] IP rule expiry failed:', err instanceof Error ? err.message : err)
      return 0
    })
    if (expired > 0) console.log(`[reconcile] disabled ${expired} expired IP rule(s)`)
  }
  if (await acquireCronLease('reconcile', RECONCILE_INTERVAL_MS)) {
    await runReconcile()
  }
}
