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
 *   2. activate the user's pending Subscription
 *   3. drive the automation pipeline so the service is actually provisioned
 *
 * Keeping that in one place means offline payments provision exactly like
 * card payments — no second, half-implemented path.
 */
import { db } from '@/lib/db'
import { provisionForPayment } from '@/lib/provision-on-payment'
import { createNotification } from '@/lib/notifications'

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

  let metadata: Record<string, unknown> = {}
  try {
    metadata = payment.metadata ? JSON.parse(payment.metadata) : {}
  } catch {
    metadata = {}
  }

  const method = opts.method || payment.method || 'manual'
  const now = new Date()

  const updatedPayment = await db.payment.update({
    where: { id: payment.id },
    data: {
      status: 'completed',
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

  // ── Activate the pending subscription ────────────────────────────
  let subscriptionId: string | null = null
  const subscription = payment.subscriptionId
    ? await db.subscription.findUnique({ where: { id: payment.subscriptionId } })
    : await db.subscription.findFirst({
        where: { userId: payment.userId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
      })

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

      await db.subscription.update({
        where: { id: subscription.id },
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
    }
  }

  // ── Drive provisioning ───────────────────────────────────────────
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

  try {
    await createNotification({
      userId: payment.userId,
      title: 'Payment Not Confirmed',
      message:
        opts.reason ||
        `We could not confirm your payment of ${payment.currency.toUpperCase()} ${payment.amount.toFixed(
          2
        )}. Please contact support or try again.`,
      type: 'error',
      link: '/?tab=billing',
    })
  } catch {
    /* ignore */
  }

  return { success: true }
}
