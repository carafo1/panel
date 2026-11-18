/**
 * Shared payment activation.
 *
 * A payment can be confirmed by three different routes:
 *   - Stripe   → webhook (checkout.session.completed)
 *   - Waafi    → provider callback
 *   - Manual   → an admin confirming an offline/bank transfer
 *
 * They all need the same three things to happen, in the same order:
 *   1. flip the Payment to 'completed'
 *   2. activate the Subscription linked to that payment (never a guess)
 *   3. settle the invoice linked to that payment (partial if underpaid)
 *   4. drive the automation pipeline so the service is actually provisioned
 *
 * Keeping that in one place means offline payments provision exactly like
 * card payments — no second, half-implemented path.
 */
import { db } from '@/lib/db'
import { provisionForPayment } from '@/lib/provision-on-payment'
import { resumeEmailForSubscription } from '@/lib/email-lifecycle'
import { createNotification } from '@/lib/notifications'
import { notifyPaymentFailed } from '@/lib/billing-notifications'
import { findInvoiceForPayment, markInvoicePaid } from '@/lib/invoices'

export interface ActivatePaymentOptions {
  paymentId: string
  /** Who/what confirmed it: 'manual' | 'waafi' | 'stripe'. */
  method?: string
  /** Admin user id, when a human confirmed an offline payment. */
  confirmedByUserId?: string | null
  confirmedByEmail?: string | null
  /** Free-text note from the admin (e.g. "Salaam Bank, receipt #123"). */
  note?: string | null
  /** Merged into the payment metadata. */
  extraMetadata?: Record<string, unknown>
  /** Provider payment id to store (Stripe payment_intent). Never the lookup key. */
  stripePaymentId?: string | null
  /** Override the notification shown to the customer. */
  notifyTitle?: string
  notifyMessage?: string
}

export interface ActivatePaymentResult {
  success: boolean
  alreadyCompleted?: boolean
  paymentId?: string
  subscriptionId?: string | null
  automation?: unknown
  error?: string
}

/**
 * Confirm a pending payment and turn the service on.
 *
 * Idempotent: confirming an already-completed payment is a no-op that
 * reports success, so a double-click or a retried webhook can't
 * double-provision.
 */
export async function activatePayment(
  opts: ActivatePaymentOptions
): Promise<ActivatePaymentResult> {
  const payment = await db.payment.findUnique({
    where: { id: opts.paymentId },
  })
  if (!payment) {
    return { success: false, error: 'Payment not found' }
  }

  // Idempotency guard — never provision twice for one payment.
  if (payment.status === 'completed') {
    return {
      success: true,
      alreadyCompleted: true,
      paymentId: payment.id,
      subscriptionId: payment.subscriptionId ?? null,
    }
  }
  // Only a pending payment can be confirmed. A failed / rejected / refunded
  // one stays as it is: completing it would provision on money we either
  // never received or already gave back.
  if (payment.status !== 'pending') {
    return {
      success: false,
      paymentId: payment.id,
      error: `Payment is ${payment.status} and cannot be confirmed.`,
    }
  }

  let metadata: Record<string, unknown> = {}
  try {
    metadata = payment.metadata ? JSON.parse(payment.metadata) : {}
  } catch {
    metadata = {}
  }

  const method = opts.method || payment.method || 'manual'
  const now = new Date()

  // The invoice this payment was raised against, linked at checkout.
  const linkedInvoiceId =
    payment.invoiceId ||
    (typeof metadata.invoiceId === 'string' && metadata.invoiceId
      ? metadata.invoiceId
      : null)

  // Atomic claim: flip pending → completed only if it is STILL pending. The
  // old read-then-update let a webhook and the browser return (or two admin
  // clicks) both get past the status check and both activate.
  const claimed = await db.payment.updateMany({
    where: { id: payment.id, status: 'pending' },
    data: {
      status: 'completed',
      ...(linkedInvoiceId ? { invoiceId: linkedInvoiceId } : {}),
      ...(opts.stripePaymentId ? { stripePaymentId: opts.stripePaymentId } : {}),
      metadata: JSON.stringify({
        ...metadata,
        ...(opts.extraMetadata || {}),
        completedAt: now.toISOString(),
        ...(opts.confirmedByUserId || opts.confirmedByEmail
          ? {
              adminConfirmed: true,
              confirmedBy: opts.confirmedByUserId || null,
              confirmedByEmail: opts.confirmedByEmail || null,
              confirmedAt: now.toISOString(),
              ...(opts.note ? { confirmationNote: opts.note } : {}),
            }
          : {}),
      }),
    },
  })
  if (claimed.count !== 1) {
    const current = await db.payment.findUnique({
      where: { id: payment.id },
      select: { status: true, subscriptionId: true },
    })
    if (current?.status === 'completed') {
      return {
        success: true,
        alreadyCompleted: true,
        paymentId: payment.id,
        subscriptionId: current.subscriptionId ?? null,
      }
    }
    return {
      success: false,
      paymentId: payment.id,
      error: `Payment is ${current?.status ?? 'missing'} and cannot be confirmed.`,
    }
  }
  const updatedPayment = (await db.payment.findUnique({
    where: { id: payment.id },
  }))!

  // ── Activate the payment's own subscription ──────────────────────
  // Only the subscription linked to THIS payment. The old fallback activated
  // "the user's most recent pending subscription", which could be an
  // unrelated order (or a different plan) the customer never paid for.
  let subscriptionId: string | null = null
  const subscription = payment.subscriptionId
    ? await db.subscription.findUnique({ where: { id: payment.subscriptionId } })
    : null

  if (subscription) {
    subscriptionId = subscription.id
    if (subscription.status === 'pending') {
      // An offline payment may be confirmed days after checkout. Don't hand
      // the customer a period that has already partly (or fully) elapsed —
      // shift it to start now, preserving the original length.
      const start = new Date(subscription.currentPeriodStart)
      const end = new Date(subscription.currentPeriodEnd)
      const lengthMs = Math.max(end.getTime() - start.getTime(), 0)
      const periodExpired = end.getTime() <= now.getTime()

      await db.subscription.updateMany({
        where: { id: subscription.id, status: 'pending' },
        data: {
          status: 'active',
          ...(periodExpired && lengthMs > 0
            ? {
                currentPeriodStart: now,
                currentPeriodEnd: new Date(now.getTime() + lengthMs),
              }
            : {}),
        },
      })

      // Bringing the subscription back does not restore the mail server on its
      // own: the domain was deactivated in Mailcow at suspension, so without
      // this the customer pays and still cannot send or receive.
      await resumeEmailForSubscription(subscription.id).catch((err) =>
        console.error('[payment-activation] email resume failed:', err)
      )

      // Websites a lapsed or suspended plan took offline come back with the
      // new plan. Only sites marked 'suspended' are touched, so anything the
      // customer stopped themselves stays stopped. Lazy import: this pulls in
      // the deploy layer.
      const { isEmailPlanSlug } = await import('@/lib/billing-enforcement')
      const plan = await db.plan
        .findUnique({ where: { id: subscription.planId }, select: { slug: true } })
        .catch(() => null)
      if (!isEmailPlanSlug(plan?.slug)) {
        const { restoreUserWebsites } = await import('@/lib/account-suspension')
        await restoreUserWebsites(subscription.userId).catch((err) =>
          console.error('[payment-activation] website restore failed:', err)
        )
      }
    }
  }

  // ── Drive provisioning ───────────────────────────────────────────
  // ── Settle the matching invoice ──────────────────────────────────
  // The customer paid against an invoice; mark it paid and record the
  // money in the ledger. Never let this break the confirmation.
  //
  // A domain order's invoice is settled by its fulfilment (fulfilDomainOrder),
  // which deliberately leaves it unpaid when registration fails so it shows
  // up for reconciliation — so it is not settled here.
  try {
    const isDomainOrder =
      typeof metadata.domainOrderId === 'string' && metadata.domainOrderId
    const invoice = isDomainOrder
      ? null
      : await findInvoiceForPayment({
          userId: payment.userId,
          subscriptionId: payment.subscriptionId,
          invoiceId: linkedInvoiceId,
        })
    if (invoice && !['paid', 'void', 'cancelled', 'refunded'].includes(invoice.status)) {
      if (!linkedInvoiceId) {
        await db.payment.update({
          where: { id: payment.id },
          data: { invoiceId: invoice.id },
        })
      }
      // markInvoicePaid records the REAL amount: less than the balance is
      // booked as a partial payment, not as the invoice paid in full.
      await markInvoicePaid(invoice.id, {
        gateway: method,
        reference: payment.transactionId,
        amount: updatedPayment.amount,
        userId: payment.userId,
      })
    }
  } catch (error) {
    console.error(
      '[payment-activation] could not settle invoice for payment',
      updatedPayment.id,
      error instanceof Error ? error.message : error
    )
  }

  let automation: unknown = null
  try {
    // REAL provisioning (Docker container / Dynadot domain / Mailcow email),
    // not the old simulation. Idempotent via a metadata flag.
    automation = await provisionForPayment(updatedPayment.id)
  } catch (error) {
    // The money is confirmed — never fail the confirmation because
    // provisioning hiccuped. Surface it instead so it can be retried.
    console.error(
      '[payment-activation] provisioning failed after confirming payment',
      updatedPayment.id,
      error instanceof Error ? error.message : error
    )
  }

  try {
    await createNotification({
      userId: payment.userId,
      title: opts.notifyTitle || 'Payment Confirmed',
      message:
        opts.notifyMessage ||
        `Your payment of ${updatedPayment.currency.toUpperCase()} ${updatedPayment.amount.toFixed(
          2
        )} has been confirmed. Your service is being activated.`,
      type: 'success',
      link: '/?tab=billing',
    })
  } catch {
    /* notification failure must not break activation */
  }

  return {
    success: true,
    paymentId: updatedPayment.id,
    subscriptionId,
    automation,
  }
}

/**
 * Mark a pending payment as failed/rejected (e.g. the admin never received
 * the bank transfer). Leaves the subscription pending so the customer can
 * retry without losing their order.
 */
export async function rejectPayment(opts: {
  paymentId: string
  reason?: string | null
  rejectedByUserId?: string | null
}): Promise<{ success: boolean; error?: string }> {
  const payment = await db.payment.findUnique({ where: { id: opts.paymentId } })
  if (!payment) return { success: false, error: 'Payment not found' }
  if (payment.status === 'completed') {
    return {
      success: false,
      error: 'Payment is already completed and cannot be rejected.',
    }
  }

  let metadata: Record<string, unknown> = {}
  try {
    metadata = payment.metadata ? JSON.parse(payment.metadata) : {}
  } catch {
    metadata = {}
  }

  await db.payment.update({
    where: { id: payment.id },
    data: {
      status: 'failed',
      metadata: JSON.stringify({
        ...metadata,
        adminConfirmed: false,
        rejectedBy: opts.rejectedByUserId || null,
        rejectedAt: new Date().toISOString(),
        ...(opts.reason ? { rejectionReason: opts.reason } : {}),
      }),
    },
  })

  // Emails as well as an in-app note: a rejected payment means services are
  // heading for suspension, and the customer may never open the dashboard.
  await notifyPaymentFailed({
    userId: payment.userId,
    amount: payment.amount,
    currency: payment.currency,
    method: payment.method,
    reason: opts.reason || null,
  }).catch(() => {})

  return { success: true }
}

/** The parts of a Stripe Checkout Session this module reads. */
export interface StripeCheckoutSessionLike {
  id: string
  payment_status?: string | null
  payment_intent?: string | { id?: string } | null
  amount_total?: number | null
  currency?: string | null
  metadata?: Record<string, string> | null
}

export type StripeConfirmOutcome =
  | 'activated'
  | 'already_completed'
  | 'not_paid'
  | 'no_payment'
  | 'mismatch'
  | 'refused'

export interface StripeConfirmResult {
  outcome: StripeConfirmOutcome
  paymentId?: string
  userId?: string
  amount?: number
  currency?: string
  detail?: string
}

/**
 * Confirm a paid Stripe Checkout Session. Shared by the webhook
 * (checkout.session.completed) and the browser return (/api/billing/success),
 * so whichever arrives first activates and the other is a no-op.
 *
 * The Payment is found by the CHECKOUT SESSION ID, which checkout stores in
 * `transactionId` and which never changes. The old code looked it up in
 * `stripePaymentId` and then overwrote that column with the payment_intent,
 * so every later lookup missed — and fell back to creating a brand-new
 * completed Payment (another container) or completing the user's most recent
 * unrelated pending payment. Neither fallback exists any more: no matching
 * Payment means nothing is activated.
 */
export async function confirmStripeCheckoutSession(
  session: StripeCheckoutSessionLike
): Promise<StripeConfirmResult> {
  if (!session?.id) return { outcome: 'no_payment', detail: 'session has no id' }
  if (session.payment_status !== 'paid') {
    return { outcome: 'not_paid', detail: `payment_status=${session.payment_status ?? 'n/a'}` }
  }

  const payment = await db.payment.findFirst({
    where: {
      method: 'stripe',
      OR: [{ transactionId: session.id }, { stripePaymentId: session.id }],
    },
    orderBy: { createdAt: 'asc' },
  })
  if (!payment) {
    console.warn(`[stripe-confirm] no Payment for checkout session ${session.id}; nothing activated`)
    return { outcome: 'no_payment' }
  }

  const base = {
    paymentId: payment.id,
    userId: payment.userId,
    amount: payment.amount,
    currency: payment.currency,
  }

  if (payment.status === 'completed') {
    return { outcome: 'already_completed', ...base }
  }

  // The session must belong to the payer and cover what we asked for.
  const sessionUserId = session.metadata?.userId
  if (sessionUserId && sessionUserId !== payment.userId) {
    console.error(`[stripe-confirm] session ${session.id} user does not match payment ${payment.id}`)
    return { outcome: 'mismatch', ...base, detail: 'user mismatch' }
  }
  const expectedCents = Math.round(payment.amount * 100)
  if (typeof session.amount_total === 'number' && session.amount_total < expectedCents) {
    console.error(
      `[stripe-confirm] session ${session.id} paid ${session.amount_total} < expected ${expectedCents} for payment ${payment.id}`
    )
    return { outcome: 'mismatch', ...base, detail: 'amount below expected' }
  }
  if (
    session.currency &&
    payment.currency &&
    session.currency.toLowerCase() !== payment.currency.toLowerCase()
  ) {
    console.error(`[stripe-confirm] session ${session.id} currency ${session.currency} != ${payment.currency}`)
    return { outcome: 'mismatch', ...base, detail: 'currency mismatch' }
  }

  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id || null

  const result = await activatePayment({
    paymentId: payment.id,
    method: 'stripe',
    stripePaymentId: paymentIntentId,
    extraMetadata: {
      checkoutSessionId: session.id,
      ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
    },
    notifyTitle: 'Payment Successful',
  })
  if (!result.success) {
    return { outcome: 'refused', ...base, detail: result.error }
  }
  return {
    outcome: result.alreadyCompleted ? 'already_completed' : 'activated',
    ...base,
  }
}
