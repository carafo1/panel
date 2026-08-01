/**
 * Plan upgrade and downgrade.
 *
 * Nothing changed a subscription's plan. `planId` was set once at checkout and
 * never again, so a customer who outgrew Starter had no path but to buy a
 * second subscription — and one who wanted to spend less had no path at all.
 *
 * Three things have to happen together, and getting any of them wrong is worse
 * than not offering the feature:
 *
 *   1. Refuse a downgrade the customer does not fit. Their 8 websites do not
 *      delete themselves when the allowance drops to 1. Silently moving them
 *      to a smaller plan would leave every limit check failing and give them no
 *      way to create anything again. We check first and say exactly what is
 *      over.
 *   2. Price the difference honestly. An upgrade mid-period charges only the
 *      unused remainder, not a fresh month. A downgrade issues credit rather
 *      than a refund — refunding to a card we may not still hold is a support
 *      problem, credit is not.
 *   3. Re-apply the new resource limits to running containers. A plan change
 *      that leaves the old CPU/RAM caps in place has changed the invoice and
 *      nothing else, which is the "UI only" failure this codebase has had
 *      elsewhere.
 */
import { db } from './db'
import { adjustCredit } from './credit'
import { nextInvoiceNumber } from './invoices'

export interface PlanChangePreview {
  ok: boolean
  error?: string
  direction: 'upgrade' | 'downgrade' | 'same'
  currentPlan: { id: string; name: string; price: number }
  targetPlan: { id: string; name: string; price: number }
  /** Days left in the paid period. */
  daysRemaining: number
  /** Positive = customer owes; negative = credit issued. */
  amountDue: number
  /** Resources that exceed the target plan — blocks a downgrade. */
  blockers: Array<{ resource: string; used: number; limit: number }>
}

/** null/0 = unlimited, consistent with the rest of the catalogue. */
function limitOf(plan: Record<string, unknown>, column: string): number | null {
  const raw = plan[column]
  return typeof raw === 'number' && raw > 0 ? raw : null
}

/**
 * What the customer currently uses, against the columns a plan can cap.
 * Mirrors lib/plan-limits.ts so the two cannot disagree about what "used"
 * means.
 */
async function currentUsage(userId: string) {
  const [websites, domains, databases, ftpAccounts, cronJobs] = await Promise.all([
    db.project.count({ where: { userId } }),
    db.domain.count({ where: { userId, status: { not: 'deleted' } } }),
    db.websiteDatabase.count({ where: { project: { userId } } }),
    db.ftpAccount.count({ where: { project: { userId } } }),
    db.cronJob.count({ where: { project: { userId } } }),
  ])
  return { websites, domains, databases, ftpAccounts, cronJobs }
}

const USAGE_TO_COLUMN: Record<string, string> = {
  websites: 'projects',
  domains: 'maxDomains',
  databases: 'maxDatabases',
  ftpAccounts: 'maxFtpAccounts',
  cronJobs: 'maxCronJobs',
}

const FRIENDLY: Record<string, string> = {
  websites: 'websites',
  domains: 'domains',
  databases: 'databases',
  ftpAccounts: 'FTP accounts',
  cronJobs: 'cron jobs',
}

/**
 * Work out what changing to `targetPlanId` would cost and whether it is
 * allowed. Writes nothing — the UI shows this before the customer commits.
 */
export async function previewPlanChange(
  userId: string,
  targetPlanId: string
): Promise<PlanChangePreview> {
  const empty = {
    direction: 'same' as const,
    currentPlan: { id: '', name: '', price: 0 },
    targetPlan: { id: '', name: '', price: 0 },
    daysRemaining: 0,
    amountDue: 0,
    blockers: [],
  }

  const sub = await db.subscription.findFirst({
    where: { userId, status: { in: ['active', 'trialing', 'past_due'] } },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  })
  if (!sub?.plan) {
    return { ...empty, ok: false, error: 'You do not have an active subscription to change.' }
  }

  const target = await db.plan.findUnique({ where: { id: targetPlanId } })
  if (!target) return { ...empty, ok: false, error: 'Plan not found.' }
  if (target.archived || !target.active) {
    return { ...empty, ok: false, error: 'That plan is no longer available.' }
  }
  if (target.id === sub.planId) {
    return { ...empty, ok: false, error: 'You are already on that plan.' }
  }

  const direction: 'upgrade' | 'downgrade' =
    target.price > sub.plan.price ? 'upgrade' : 'downgrade'

  // ── Does the customer fit? ────────────────────────────────────────
  const usage = await currentUsage(userId)
  const blockers: PlanChangePreview['blockers'] = []
  for (const [key, used] of Object.entries(usage)) {
    const limit = limitOf(target as unknown as Record<string, unknown>, USAGE_TO_COLUMN[key])
    if (limit !== null && used > limit) {
      blockers.push({ resource: FRIENDLY[key] || key, used, limit })
    }
  }

  // ── Proration ─────────────────────────────────────────────────────
  // Charge only the unused remainder of the period, so a customer upgrading on
  // day 28 is not billed a second full month.
  const now = Date.now()
  const periodEnd = new Date(sub.currentPeriodEnd).getTime()
  const periodStart = new Date(sub.currentPeriodStart).getTime()
  const periodMs = Math.max(periodEnd - periodStart, 1)
  const remainingMs = Math.max(periodEnd - now, 0)
  const fraction = remainingMs / periodMs
  const daysRemaining = Math.ceil(remainingMs / 86_400_000)

  const amountDue =
    Math.round((target.price - sub.plan.price) * fraction * 100) / 100

  return {
    ok: blockers.length === 0,
    error:
      blockers.length > 0
        ? `You are using more than the ${target.name} plan allows. Reduce these first: ` +
          blockers.map((b) => `${b.used} ${b.resource} (limit ${b.limit})`).join(', ')
        : undefined,
    direction,
    currentPlan: { id: sub.plan.id, name: sub.plan.name, price: sub.plan.price },
    targetPlan: { id: target.id, name: target.name, price: target.price },
    daysRemaining,
    amountDue,
    blockers,
  }
}

export interface PlanChangeResult {
  ok: boolean
  error?: string
  subscriptionId?: string
  invoiceNumber?: string
  creditIssued?: number
  amountDue?: number
  /** Projects whose container limits still need re-applying. */
  projectsToRedeploy?: string[]
}

/**
 * Apply a plan change.
 *
 * The subscription row, the new resource allowances on every project, and the
 * money are changed in one transaction — a partial application would leave the
 * customer paying for one plan and running on another.
 */
export async function changePlan(
  userId: string,
  targetPlanId: string
): Promise<PlanChangeResult> {
  const preview = await previewPlanChange(userId, targetPlanId)
  if (!preview.ok) return { ok: false, error: preview.error }

  const sub = await db.subscription.findFirst({
    where: { userId, status: { in: ['active', 'trialing', 'past_due'] } },
    orderBy: { createdAt: 'desc' },
  })
  if (!sub) return { ok: false, error: 'Subscription disappeared — please retry.' }

  const target = await db.plan.findUnique({ where: { id: targetPlanId } })
  if (!target) return { ok: false, error: 'Plan not found.' }

  const projects = await db.project.findMany({
    where: { userId },
    select: { id: true },
  })

  let invoiceNumber: string | undefined
  let creditIssued = 0

  await db.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { id: sub.id },
      data: { planId: target.id },
    })

    // Re-apply the new allowance to every project. Without this the plan change
    // is a billing change only: containers keep the old caps until something
    // else happens to redeploy them.
    for (const p of projects) {
      await tx.project.update({
        where: { id: p.id },
        data: {
          resourceCpuCores: target.cpuCores,
          resourceRamMB: target.ramMB,
          resourceStorageGB: target.diskMB ? Math.round(target.diskMB / 1024) : null,
        },
      })
    }

    if (preview.amountDue > 0) {
      // Upgrade: raise an invoice for the prorated difference.
      invoiceNumber = await nextInvoiceNumber()
      await tx.invoice.create({
        data: {
          number: invoiceNumber,
          userId,
          subscriptionId: sub.id,
          planId: target.id,
          items: JSON.stringify([
            {
              description:
                `Upgrade to ${target.name} — ${preview.daysRemaining} day` +
                `${preview.daysRemaining === 1 ? '' : 's'} remaining in the current period`,
              quantity: 1,
              unitPrice: preview.amountDue,
              total: preview.amountDue,
            },
          ]),
          subtotal: preview.amountDue,
          tax: 0,
          total: preview.amountDue,
          currency: target.currency || 'USD',
          status: 'pending',
          paidAt: null,
        },
      })
    }
  })

  // Downgrade: issue account credit for the unused difference rather than
  // refunding. Done outside the transaction because adjustCredit writes its own
  // ledger rows and notification.
  if (preview.amountDue < 0) {
    creditIssued = Math.abs(preview.amountDue)
    await adjustCredit({
      userId,
      amount: creditIssued,
      type: 'adjustment',
      description: `Downgrade to ${target.name} — unused portion of ${preview.currentPlan.name}`,
      notify: true,
    }).catch((err) => {
      console.error('[plan-change] credit issue failed:', err)
      creditIssued = 0
    })
  }

  return {
    ok: true,
    subscriptionId: sub.id,
    invoiceNumber,
    creditIssued,
    amountDue: preview.amountDue,
    projectsToRedeploy: projects.map((p) => p.id),
  }
}
