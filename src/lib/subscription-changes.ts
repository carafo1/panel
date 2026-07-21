/**
 * Subscription lifecycle changes: plan upgrade/downgrade with proration,
 * billing-cycle changes, ownership transfer and immediate cancellation.
 *
 * Proration model (the standard one):
 *   ratio        = daysRemaining / daysInPeriod
 *   unusedCredit = oldPlanPrice * ratio     (what they already paid for and won't use)
 *   newCost      = newPlanPrice * ratio     (what the new plan costs for that same window)
 *   netCharge    = newCost - unusedCredit
 *
 * The period END never moves on a plan change — only the price differs — so the
 * customer's renewal date stays predictable.
 */
import { db } from '@/lib/db'
import { createSubscriptionInvoice, cycleDays } from '@/lib/invoices'
import { createNotification } from '@/lib/notifications'

export interface ProrationResult {
  daysRemaining: number
  daysInPeriod: number
  ratio: number
  unusedCredit: number
  newCost: number
  netCharge: number // > 0 = customer owes; <= 0 = customer is in credit
  prorated: boolean // false for lifetime / non-time-based plans
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

export function calculateProration(
  sub: { currentPeriodStart: Date; currentPeriodEnd: Date },
  oldPrice: number,
  newPrice: number,
  now = new Date()
): ProrationResult {
  const start = new Date(sub.currentPeriodStart).getTime()
  const end = new Date(sub.currentPeriodEnd).getTime()
  const dayMs = 24 * 60 * 60 * 1000

  const daysInPeriod = Math.max(1, Math.round((end - start) / dayMs))
  const daysRemaining = Math.max(0, Math.ceil((end - now.getTime()) / dayMs))

  // A period longer than ~50 years is our "lifetime" sentinel — nothing to prorate.
  if (daysInPeriod > 365 * 50) {
    return {
      daysRemaining,
      daysInPeriod,
      ratio: 0,
      unusedCredit: 0,
      newCost: round2(newPrice),
      netCharge: round2(newPrice),
      prorated: false,
    }
  }

  const ratio = Math.min(1, Math.max(0, daysRemaining / daysInPeriod))
  const unusedCredit = round2(oldPrice * ratio)
  const newCost = round2(newPrice * ratio)

  return {
    daysRemaining,
    daysInPeriod,
    ratio,
    unusedCredit,
    newCost,
    netCharge: round2(newCost - unusedCredit),
    prorated: true,
  }
}

export interface ChangePlanResult {
  success: boolean
  error?: string
  proration?: ProrationResult
  invoiceId?: string
  invoiceNumber?: string
  creditNote?: string
  direction?: 'upgrade' | 'downgrade' | 'same'
}

/**
 * Move a subscription onto a different plan.
 *
 * - Upgrade (net > 0): raises an invoice for the difference, due immediately.
 * - Downgrade (net <= 0): switches the plan and records the credit amount as a
 *   note. NOTE: there is no wallet yet (that's Phase 4), so the credit is not
 *   automatically refunded or applied — it's recorded so an admin can honour it.
 */
export async function changeSubscriptionPlan(opts: {
  subscriptionId: string
  newPlanId: string
  prorate?: boolean
  adminUserId?: string
}): Promise<ChangePlanResult> {
  const sub = await db.subscription.findUnique({
    where: { id: opts.subscriptionId },
    include: { plan: true, user: { select: { id: true, email: true, name: true } } },
  })
  if (!sub) return { success: false, error: 'Subscription not found' }
  if (sub.stripeSubId && !sub.stripeSubId.startsWith('sub_sim_')) {
    return {
      success: false,
      error:
        'This subscription is billed by Stripe — change the plan in Stripe so the two stay in sync.',
    }
  }

  const newPlan = await db.plan.findUnique({ where: { id: opts.newPlanId } })
  if (!newPlan) return { success: false, error: 'Target plan not found' }
  if (newPlan.id === sub.planId) {
    return { success: false, error: 'Subscription is already on that plan' }
  }
  if ((newPlan as { archived?: boolean }).archived) {
    return { success: false, error: 'Cannot move a customer onto an archived plan' }
  }

  const oldPrice = sub.plan?.price ?? 0
  const newPrice = newPlan.price
  const direction: 'upgrade' | 'downgrade' | 'same' =
    newPrice > oldPrice ? 'upgrade' : newPrice < oldPrice ? 'downgrade' : 'same'

  const proration = calculateProration(sub, oldPrice, newPrice)
  const shouldProrate = opts.prorate !== false && proration.prorated

  await db.subscription.update({
    where: { id: sub.id },
    data: { planId: newPlan.id, status: 'active' },
  })

  let invoiceId: string | undefined
  let invoiceNumber: string | undefined
  let creditNote: string | undefined

  if (shouldProrate && proration.netCharge > 0) {
    const inv = await createSubscriptionInvoice({
      userId: sub.userId,
      subscriptionId: sub.id,
      planId: newPlan.id,
      planName: newPlan.name,
      amount: proration.netCharge,
      currency: (newPlan as { currency?: string }).currency || 'USD',
      // Not a new billing period — this covers the remainder of the current one.
      periodStart: null,
      periodEnd: sub.currentPeriodEnd,
      dueInDays: 3,
      description: `${direction === 'upgrade' ? 'Upgrade' : 'Plan change'} to ${newPlan.name} — prorated for ${proration.daysRemaining} remaining day(s)`,
      notes: `Prorated change from ${sub.plan?.name || 'previous plan'}: new cost ${proration.newCost} less unused credit ${proration.unusedCredit}.`,
    })
    invoiceId = inv?.id
    invoiceNumber = inv?.number
  } else if (shouldProrate && proration.netCharge < 0) {
    creditNote = `Customer is in credit ${Math.abs(proration.netCharge).toFixed(2)} for ${proration.daysRemaining} remaining day(s). No wallet exists yet, so this is recorded but not auto-refunded.`
  }

  await createNotification({
    userId: sub.userId,
    title:
      direction === 'upgrade' ? 'Plan upgraded' : direction === 'downgrade' ? 'Plan changed' : 'Plan updated',
    message:
      `Your plan is now ${newPlan.name}.` +
      (invoiceNumber
        ? ` Invoice ${invoiceNumber} for ${proration.netCharge.toFixed(2)} covers the rest of this period.`
        : ''),
    type: 'success',
    link: '/?tab=billing',
  }).catch(() => {})

  return {
    success: true,
    proration,
    invoiceId,
    invoiceNumber,
    creditNote,
    direction,
  }
}

/**
 * Switch billing cycle (e.g. monthly → annual). Re-bases the current period
 * from today using the new cycle length; the next invoice reflects it.
 */
export async function changeBillingCycle(opts: {
  subscriptionId: string
  billingCycle: string
}): Promise<{ success: boolean; error?: string; newPeriodEnd?: Date }> {
  const sub = await db.subscription.findUnique({
    where: { id: opts.subscriptionId },
  })
  if (!sub) return { success: false, error: 'Subscription not found' }

  const days = cycleDays(opts.billingCycle)
  const now = new Date()
  const newPeriodEnd = days
    ? new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
    : new Date(now.getFullYear() + 100, now.getMonth(), now.getDate())

  await db.subscription.update({
    where: { id: sub.id },
    data: {
      currentPeriodStart: now,
      currentPeriodEnd: newPeriodEnd,
      status: 'active',
    },
  })
  return { success: true, newPeriodEnd }
}

/** Move a subscription to a different customer. */
export async function transferSubscription(opts: {
  subscriptionId: string
  newUserId: string
}): Promise<{ success: boolean; error?: string }> {
  const sub = await db.subscription.findUnique({
    where: { id: opts.subscriptionId },
  })
  if (!sub) return { success: false, error: 'Subscription not found' }

  const target = await db.user.findUnique({ where: { id: opts.newUserId } })
  if (!target) return { success: false, error: 'Target user not found' }
  if (target.id === sub.userId) {
    return { success: false, error: 'Subscription already belongs to that user' }
  }

  await db.subscription.update({
    where: { id: sub.id },
    data: { userId: target.id },
  })

  await createNotification({
    userId: target.id,
    title: 'Subscription transferred to you',
    message: 'A subscription has been transferred to your account.',
    type: 'info',
    link: '/?tab=billing',
  }).catch(() => {})

  return { success: true }
}

/**
 * Cancel immediately (as opposed to the existing cancel-at-period-end):
 * ends the period now so the billing sweep won't keep it alive.
 */
export async function forceCancelSubscription(opts: {
  subscriptionId: string
  reason?: string | null
}): Promise<{ success: boolean; error?: string }> {
  const sub = await db.subscription.findUnique({
    where: { id: opts.subscriptionId },
  })
  if (!sub) return { success: false, error: 'Subscription not found' }

  await db.subscription.update({
    where: { id: sub.id },
    data: {
      status: 'cancelled',
      cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date(), // ends now, not at period end
    },
  })

  await createNotification({
    userId: sub.userId,
    title: 'Subscription cancelled',
    message:
      opts.reason ||
      'Your subscription has been cancelled and access has ended.',
    type: 'warning',
    link: '/?tab=billing',
  }).catch(() => {})

  return { success: true }
}
