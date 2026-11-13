/**
 * Billing enforcement — what happens when a renewal invoice is not paid, and
 * what happens when it finally is.
 *
 * Renewal raises the next period's invoice and keeps the service running while
 * that invoice is inside its payment window (the usual hosting model). Before
 * this module nothing ever looked at the invoice again: the next sweep simply
 * renewed the subscription once more, set it back to 'active', and an unpaid
 * customer kept their services forever. Now:
 *
 *   invoice overdue                → subscription past_due (grace starts)
 *   overdue for longer than grace  → suspended: websites stopped, mail paused
 *   invoice paid (any gateway)     → active again, mail and websites restored
 *
 * Nothing here deletes data. Stopping is reversible, and most suspensions end
 * with the customer paying.
 */
import { db } from '@/lib/db'
import { createNotification } from '@/lib/notifications'
import { sendEmail } from '@/lib/email'
import { EMAIL_PLANS } from '@/lib/email-hosting'
import {
  suspendEmailForSubscription,
  resumeEmailForSubscription,
} from '@/lib/email-lifecycle'
import {
  stopUserWebsites,
  restoreUserWebsites,
} from '@/lib/account-suspension'

/** Days an invoice may stay overdue before the subscription is suspended. */
export const OVERDUE_GRACE_DAYS = 7

/** Subscription statuses that still entitle the customer to service. */
const IN_GOOD_STANDING = ['active', 'trialing', 'past_due']

const EMAIL_PLAN_SLUGS = new Set(EMAIL_PLANS.map((p) => p.slug))

/** True for an email-hosting plan, whose suspension must not touch websites. */
export function isEmailPlanSlug(slug: string | null | undefined): boolean {
  return !!slug && EMAIL_PLAN_SLUGS.has(slug)
}

/**
 * The unpaid invoice for a subscription with the earliest due date, if any.
 * Invoices without a due date are skipped: SQLite sorts NULL first, so one of
 * those would otherwise hide a genuinely overdue invoice.
 */
export async function oldestUnpaidInvoice(subscriptionId: string) {
  return db.invoice.findFirst({
    where: { subscriptionId, status: 'unpaid', dueDate: { not: null } },
    orderBy: { dueDate: 'asc' },
    select: { id: true, number: true, total: true, currency: true, dueDate: true },
  })
}

/**
 * Whether the user has a hosting subscription other than `exceptId` that is
 * still in good standing — in which case their websites must stay up.
 */
export async function hasOtherHostingInGoodStanding(
  userId: string,
  exceptId: string
): Promise<boolean> {
  const others = await db.subscription.findMany({
    where: { userId, id: { not: exceptId }, status: { in: IN_GOOD_STANDING } },
    select: { plan: { select: { slug: true } } },
  })
  return others.some((s) => !isEmailPlanSlug(s.plan?.slug))
}

export interface SuspensionResult {
  websitesStopped: number
  emailSuspended: number
  failures: string[]
}

/**
 * Suspend a subscription for non-payment and take its services offline.
 * Safe to call on an already-suspended subscription (it only stops what is
 * still running).
 */
export async function suspendSubscriptionForNonPayment(
  subscriptionId: string,
  reason: string
): Promise<SuspensionResult> {
  const sub = await db.subscription.findUnique({
    where: { id: subscriptionId },
    include: {
      plan: { select: { name: true, slug: true } },
      user: { select: { id: true, name: true, email: true } },
    },
  })
  const result: SuspensionResult = { websitesStopped: 0, emailSuspended: 0, failures: [] }
  if (!sub) return result

  const wasSuspended = sub.status === 'suspended'
  if (!wasSuspended) {
    await db.subscription.update({
      where: { id: sub.id },
      data: { status: 'suspended' },
    })
  }

  const stoppedMail = await suspendEmailForSubscription(sub.id).catch((err) => {
    result.failures.push(`email: ${err instanceof Error ? err.message : String(err)}`)
    return [] as string[]
  })
  result.emailSuspended = stoppedMail.length

  // Websites belong to the user, not to one subscription, so only take them
  // down when no other hosting subscription still pays for them.
  if (
    !isEmailPlanSlug(sub.plan?.slug) &&
    !(await hasOtherHostingInGoodStanding(sub.userId, sub.id))
  ) {
    const cascade = await stopUserWebsites(sub.userId)
    result.websitesStopped = cascade.projectsStopped.length
    result.failures.push(...cascade.failures)
  }

  if (!wasSuspended) {
    const planName = sub.plan?.name || 'hosting'
    await createNotification({
      userId: sub.userId,
      title: 'Subscription Suspended',
      message: `Your ${planName} plan has been suspended: ${reason}. Your websites are offline and email sign-in is paused. Nothing has been deleted — pay the outstanding invoice and everything comes back.`,
      type: 'error',
      link: '/?tab=billing',
    }).catch(() => {})
    if (sub.user?.email) {
      await sendEmail({
        to: sub.user.email,
        subject: `Your ${planName} plan has been suspended`,
        html: `<p>Hi ${escapeHtml(sub.user.name || 'there')},</p>
<p>Your <strong>${escapeHtml(planName)}</strong> plan has been suspended: ${escapeHtml(reason)}.</p>
<p>Your websites are offline and email sign-in is paused. <strong>Nothing has been deleted.</strong> Pay the outstanding invoice from the Billing page and your services are restored automatically.</p>
<p>— Apsamo Technology</p>`,
      }).catch(() => {})
    }
  }

  if (result.failures.length) {
    console.error('[billing-enforcement] suspension incomplete for', sub.id, result.failures)
  }
  return result
}

/**
 * Bring a past-due or suspended subscription back once nothing is overdue.
 * Called whenever an invoice is settled, by whatever route the money arrived.
 */
export async function reactivateSubscriptionIfSettled(
  subscriptionId: string
): Promise<{ reactivated: boolean; websitesRestored: number }> {
  const sub = await db.subscription.findUnique({
    where: { id: subscriptionId },
    include: { plan: { select: { name: true, slug: true } } },
  })
  if (!sub || (sub.status !== 'past_due' && sub.status !== 'suspended')) {
    return { reactivated: false, websitesRestored: 0 }
  }

  // Another invoice still overdue: paying one of two does not clear the debt.
  const stillOverdue = await db.invoice.findFirst({
    where: { subscriptionId, status: 'unpaid', dueDate: { lte: new Date() } },
    select: { id: true },
  })
  if (stillOverdue) return { reactivated: false, websitesRestored: 0 }

  const wasSuspended = sub.status === 'suspended'
  await db.subscription.update({
    where: { id: sub.id },
    data: { status: 'active', renewalAttempts: 0, lastRenewalError: null },
  })

  await resumeEmailForSubscription(sub.id).catch((err) =>
    console.error('[billing-enforcement] email resume failed:', err)
  )

  let websitesRestored = 0
  if (wasSuspended && !isEmailPlanSlug(sub.plan?.slug)) {
    const cascade = await restoreUserWebsites(sub.userId)
    websitesRestored = cascade.projectsRestored.length
  }

  await createNotification({
    userId: sub.userId,
    title: 'Payment received — service restored',
    message: wasSuspended
      ? `Thanks! Your ${sub.plan?.name || 'hosting'} plan is active again. Email works immediately; websites are being rebuilt and will be back online shortly.`
      : `Thanks! Your ${sub.plan?.name || 'hosting'} plan is up to date again.`,
    type: 'success',
    link: '/?tab=billing',
  }).catch(() => {})

  return { reactivated: true, websitesRestored }
}

/** Hook for every place an invoice becomes paid. Never throws. */
export async function onInvoiceSettled(invoiceId: string): Promise<void> {
  try {
    const invoice = await db.invoice.findUnique({
      where: { id: invoiceId },
      select: { subscriptionId: true, status: true },
    })
    if (invoice?.status === 'paid' && invoice.subscriptionId) {
      await reactivateSubscriptionIfSettled(invoice.subscriptionId)
    }
  } catch (err) {
    console.error('[billing-enforcement] onInvoiceSettled failed for', invoiceId, err)
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
