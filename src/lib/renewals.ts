/**
 * Subscription renewal.
 *
 * Before this, the billing sweep only ever *expired* subscriptions and emailed
 * the customer — nothing regenerated an invoice, so recurring revenue silently
 * stopped at the end of every period. This turns the platform into an actual
 * subscription business:
 *
 *   1. roll the period forward by the plan's billing cycle
 *   2. raise the next invoice (re-applying a recurring coupon if set)
 *   3. settle it instantly from wallet credit when the balance covers it
 *   4. otherwise leave it unpaid for the customer to pay / admin to confirm
 *
 * Idempotent per period: `createSubscriptionInvoice` keys on
 * (subscriptionId, periodStart), so a retried sweep can't double-bill.
 */
import { db } from '@/lib/db'
import { createSubscriptionInvoice, cycleDays } from '@/lib/invoices'
import { applyCreditToInvoice } from '@/lib/credit'
import { emailAddonCostForSubscription } from '@/lib/email-hosting'
import {
  notifySubscriptionRenewed,
  notifyRenewalFailed,
} from '@/lib/billing-notifications'

/**
 * Prisma filter for "we own the billing for this subscription".
 *
 * IMPORTANT: checkout stamps a `sub_sim_<ts>` sentinel on every locally
 * created subscription, so filtering on `stripeSubId: null` alone matches
 * NOTHING — which silently made the whole billing sweep a no-op. Only a
 * stripeSubId that is absent, or the simulated sentinel, is ours to bill.
 */
export const NOT_STRIPE_MANAGED: {
  OR: Array<{ stripeSubId: null } | { stripeSubId: { startsWith: string } }>
} = {
  OR: [
    { stripeSubId: null },
    { stripeSubId: { startsWith: 'sub_sim_' } },
  ],
}

export interface RenewResult {
  success: boolean
  error?: string
  skipped?: string
  invoiceId?: string
  invoiceNumber?: string
  paidFromCredit?: boolean
  newPeriodEnd?: Date
}

/**
 * Renew one subscription for its next billing period.
 *
 * `force` lets an admin renew early (a manual "Renew" button); the automatic
 * sweep only calls this once the current period has actually ended.
 */
export async function renewSubscription(opts: {
  subscriptionId: string
  force?: boolean
  adminUserId?: string | null
}): Promise<RenewResult> {
  const sub = await db.subscription.findUnique({
    where: { id: opts.subscriptionId },
    include: {
      plan: true,
      user: { select: { id: true, email: true, name: true } },
    },
  })
  if (!sub) return { success: false, error: 'Subscription not found' }
  if (sub.status === 'cancelled') {
    return { success: false, skipped: 'subscription is cancelled' }
  }
  // A pending cancellation still looks 'active' — that is deliberate, so the
  // customer keeps what they paid for. Renewing it anyway would bill them for
  // a period they explicitly cancelled. `force` still allows an admin to
  // override, for when the customer has changed their mind by phone.
  if (sub.cancelAtPeriodEnd && !opts.force) {
    return { success: false, skipped: 'cancellation scheduled for period end' }
  }

  const days = cycleDays(
    (sub.plan as { billingCycle?: string })?.billingCycle || 'monthly'
  )
  // Lifetime plans never renew — there is no next period to bill.
  if (days === null) {
    return { success: false, skipped: 'lifetime plan — nothing to renew' }
  }

  const now = new Date()
  const currentEnd = new Date(sub.currentPeriodEnd)
  if (!opts.force && currentEnd.getTime() > now.getTime()) {
    return { success: false, skipped: 'period has not ended yet' }
  }

  // Never stack a new period on top of an unpaid one. Renewing again used to
  // reset the subscription to 'active' every period, so a customer who never
  // paid was never suspended. The overdue invoice is the billing sweep's job
  // now (see billing-enforcement); an admin can still force a renewal.
  if (!opts.force) {
    const unpaid = await db.invoice.findFirst({
      where: { subscriptionId: sub.id, status: { in: ['unpaid', 'partially_paid'] } },
      select: { number: true },
    })
    if (unpaid) {
      return { success: false, skipped: `invoice ${unpaid.number} is still unpaid` }
    }
  }

  // Roll forward from the old period end so periods stay contiguous — unless
  // it lapsed long ago, in which case start from today rather than
  // back-dating a period the customer never had.
  const base =
    currentEnd.getTime() > now.getTime() - days * 24 * 60 * 60 * 1000
      ? currentEnd
      : now
  const newStart = base
  const newEnd = new Date(base.getTime() + days * 24 * 60 * 60 * 1000)

  // Email add-ons (extra mailboxes / storage) are recurring, so they belong on
  // every renewal invoice. Billing plan.price alone charged for them once at
  // purchase and then gave them away for the life of the subscription.
  const addons = await emailAddonCostForSubscription(sub.id).catch(() => ({
    total: 0,
    lines: [] as string[],
  }))
  const amount = (sub.plan?.price ?? 0) + addons.total
  const currency = (sub.plan as { currency?: string })?.currency || 'USD'

  // ── Claim this period atomically ─────────────────────────────────
  // Two overlapping sweeps (a worker retry after its fetch timed out, or an
  // admin "Renew" during the sweep) both read the same period above and both
  // raised an invoice. Rolling the period forward is now a conditional update
  // on the period we read: only one caller matches; the other skips.
  const nextStatus =
    sub.status === 'past_due' || sub.status === 'suspended' ? sub.status : 'active'
  const claimed = await db.subscription.updateMany({
    where: {
      id: sub.id,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
    },
    data: {
      currentPeriodStart: newStart,
      currentPeriodEnd: newEnd,
      status: nextStatus,
      lastRenewedAt: now,
    },
  })
  if (claimed.count !== 1) {
    return { success: false, skipped: 'already renewed by a concurrent run' }
  }

  try {
    // 1. Raise the invoice for the new period (idempotent).
    const invoice = await createSubscriptionInvoice({
      userId: sub.userId,
      subscriptionId: sub.id,
      planId: sub.planId,
      planName: sub.plan?.name,
      amount,
      currency,
      periodStart: newStart,
      periodEnd: newEnd,
      // Only a coupon marked `recurring` is stored on the subscription, so
      // re-applying it here is correct; one-time coupons never get here.
      couponCode: (sub as { couponCode?: string | null }).couponCode || null,
      description:
        `${sub.plan?.name || 'Hosting'} — renewal ${newStart.toDateString()} to ${newEnd.toDateString()}` +
        (addons.lines.length ? ` (incl. add-ons — ${addons.lines.join('; ')})` : ''),
    })

    // 2. The period was moved forward by the claim above. The service
    // carries on while the new invoice is inside its payment window, but a
    // past-due or suspended subscription is NOT reinstated by raising an
    // invoice — only by paying it (billing-enforcement.onInvoiceSettled).
    // Reset the failure counter now that the invoice exists.
    await db.subscription.update({
      where: { id: sub.id },
      data: {
        renewalAttempts: 0,
        lastRenewalError: null,
      },
    })

    // 3. Auto-settle from wallet credit when they have the balance.
    // Settling triggers onInvoiceSettled, which restores mail and websites.
    let paidFromCredit = false
    if (invoice) {
      const credit = await applyCreditToInvoice({
        invoiceId: invoice.id,
        adminUserId: opts.adminUserId,
      }).catch(() => null)
      if (credit?.success && (credit.applied ?? 0) > 0) {
        const fresh = await db.invoice.findUnique({ where: { id: invoice.id } })
        paidFromCredit = fresh?.status === 'paid'
      }
    }

    await notifySubscriptionRenewed({
      userId: sub.userId,
      planName: sub.plan?.name || 'hosting',
      periodEnd: newEnd,
      invoiceNumber: invoice?.number ?? null,
      amount: invoice?.total,
      currency,
      paidFromCredit,
    }).catch(() => {})

    return {
      success: true,
      invoiceId: invoice?.id,
      invoiceNumber: invoice?.number,
      paidFromCredit,
      newPeriodEnd: newEnd,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Record the failure so repeated breakage is visible rather than silent,
    // and put the period back if no invoice was raised for it — otherwise the
    // customer would get a period for free and the retry would never come.
    const raised = await db.invoice
      .findFirst({
        where: { subscriptionId: sub.id, periodStart: newStart },
        select: { id: true },
      })
      .catch(() => null)
    await db.subscription
      .update({
        where: { id: sub.id },
        data: {
          renewalAttempts: { increment: 1 },
          lastRenewalError: msg.slice(0, 500),
          ...(raised
            ? {}
            : {
                currentPeriodStart: sub.currentPeriodStart,
                currentPeriodEnd: sub.currentPeriodEnd,
                status: sub.status,
                lastRenewedAt: sub.lastRenewedAt,
              }),
        },
      })
      .catch(() => {})
    console.error('[renewals] renew failed for', sub.id, msg)
    // Tell the customer too — a silent renewal failure ends in a suspension
    // they never saw coming.
    await notifyRenewalFailed({
      userId: sub.userId,
      planName: sub.plan?.name || 'hosting',
      reason: null, // internal error text isn't useful or safe to surface
    }).catch(() => {})
    return { success: false, error: msg }
  }
}

/**
 * Renew every subscription whose period has ended and which has autoRenew on.
 * Called by the billing sweep before it starts expiring things, so a renewable
 * subscription is never marked past_due.
 */
export async function runAutoRenewals(): Promise<{
  renewed: number
  failed: number
  skipped: number
}> {
  const now = new Date()
  const due = await db.subscription.findMany({
    where: {
      status: { in: ['active', 'trialing', 'past_due'] },
      autoRenew: true,
      ...NOT_STRIPE_MANAGED, // Stripe drives its own renewals
      currentPeriodEnd: { lte: now },
      // Stop retrying a subscription that keeps failing; it needs a human.
      renewalAttempts: { lt: 3 },
    },
    select: { id: true },
    take: 200,
  })

  let renewed = 0
  let failed = 0
  let skipped = 0
  for (const s of due) {
    const r = await renewSubscription({ subscriptionId: s.id })
    if (r.success) renewed++
    else if (r.skipped) skipped++
    else failed++
  }
  return { renewed, failed, skipped }
}

// ── Scheduled-job lease ─────────────────────────────────────────────────────

/**
 * Claim a named server-side lease (CronLock row) for `ttlMs`. Returns a holder
 * token when this caller got it, or null when another run still holds it.
 *
 * The worker calls the billing sweep with a timeout and retries quickly after
 * a failure, so a slow sweep could be re-entered while it was still renewing
 * and invoicing. The claim is atomic: a conditional update that only matches
 * an expired lease, or the insert of a missing row (the primary key makes a
 * concurrent second insert fail). An expired lease is taken over, so a crashed
 * run cannot block the job forever.
 */
export async function acquireCronLease(name: string, ttlMs: number): Promise<string | null> {
  const holder = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date()
  const until = new Date(now.getTime() + ttlMs)

  const taken = await db.cronLock.updateMany({
    where: { name, lockedUntil: { lte: now } },
    data: { holder, lockedUntil: until },
  })
  if (taken.count === 1) return holder

  try {
    await db.cronLock.create({ data: { name, holder, lockedUntil: until } })
    return holder
  } catch {
    // The row exists and its lease has not expired: someone else holds it.
    return null
  }
}

/** Release a lease this caller holds (no-op if it was already taken over). */
export async function releaseCronLease(name: string, holder: string): Promise<void> {
  await db.cronLock
    .updateMany({ where: { name, holder }, data: { lockedUntil: new Date(0), holder: null } })
    .catch(() => {})
}
