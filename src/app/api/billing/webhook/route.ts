import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { processEvent } from '@/lib/automation'
import {
  activatePayment,
  confirmStripeCheckoutSession,
} from '@/lib/payment-activation'
import { recordStripeChargeRefund } from '@/lib/refunds'
import {
  constructWebhookEvent,
  getSubscriptionPeriod,
  getInvoiceSubscriptionId,
  getInvoiceChargeId,
} from '@/lib/stripe'
import { createNotification } from '@/lib/notifications'
import { notifyPaymentFailed } from '@/lib/billing-notifications'
import {
  suspendSubscriptionForNonPayment,
  reactivateSubscriptionIfSettled,
  hasOtherHostingInGoodStanding,
  isEmailPlanSlug,
} from '@/lib/billing-enforcement'
import { stopUserWebsites } from '@/lib/account-suspension'
import type Stripe from 'stripe'

/**
 * Stripe Webhook handler.
 *
 * Verifies the Stripe signature using STRIPE_WEBHOOK_SECRET and handles:
 *   - checkout.session.completed   → mark payment completed, activate subscription
 *   - customer.subscription.updated → update subscription status
 *   - customer.subscription.deleted  → cancel subscription
 *   - invoice.payment_succeeded      → record payment
 *   - invoice.payment_failed         → mark payment failed + notify user
 *
 * Demo mode: when STRIPE_SECRET_KEY (or STRIPE_WEBHOOK_SECRET) is not set,
 * we accept the raw payload without signature verification and log a warning.
 */
export async function POST(request: Request) {
  try {
    const signature = request.headers.get('stripe-signature') || ''
    const rawBody = await request.text()

    let event: Stripe.Event
    try {
      event = await constructWebhookEvent(rawBody, signature)
    } catch (err) {
      console.error('[stripe-webhook] signature verification failed:', err)
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 400 }
      )
    }

    const eventType: string = event.type
    const data = event.data?.object as unknown as Record<string, unknown> | undefined

    // ── checkout.session.completed ──────────────────────────────
    // (async_payment_succeeded is the same confirmation for delayed methods.)
    if (
      eventType === 'checkout.session.completed' ||
      eventType === 'checkout.session.async_payment_succeeded'
    ) {
      const session = data as unknown as Stripe.Checkout.Session

      // A completed session is not necessarily a paid one (delayed payment
      // methods complete with payment_status 'unpaid'). Only money that has
      // arrived activates anything.
      if (session?.payment_status !== 'paid') {
        console.warn(
          `[stripe-webhook] ${eventType} for ${session?.id} not paid (${session?.payment_status}); ignored`
        )
        return NextResponse.json({ received: true })
      }

      // Shared with /api/billing/success: finds the Payment by the checkout
      // session id, refuses mismatches, and activates through the same path
      // as every other gateway (completes the payment, activates ITS
      // subscription, settles ITS invoice, provisions once). No fallback ever
      // creates a Payment or completes a different one.
      const result = await confirmStripeCheckoutSession({
        id: session.id,
        payment_status: session.payment_status,
        payment_intent: session.payment_intent as string | { id?: string } | null,
        amount_total: session.amount_total,
        currency: session.currency,
        metadata: (session.metadata || {}) as Record<string, string>,
      })
      console.log(
        `[stripe-webhook] session ${session.id}: ${result.outcome}${
          result.paymentId ? ` (payment ${result.paymentId})` : ''
        }${result.detail ? ` — ${result.detail}` : ''}`
      )
    }

    // ── customer.subscription.updated ───────────────────────────
    else if (eventType === 'customer.subscription.updated') {
      const sub = data as unknown as Stripe.Subscription
      const subId = sub?.id
      const status = sub?.status

      if (subId) {
        // Find the local subscription by Stripe sub ID
        const local = await db.subscription.findFirst({
          where: { stripeSubId: subId },
        })
        if (local) {
          const mappedStatus = mapStripeSubStatus(status)
          const { start: periodStart, end: periodEnd } =
            getSubscriptionPeriod(sub)
          const cancelAtPeriodEnd = !!sub?.cancel_at_period_end
          // Recovering from past_due/suspended goes through
          // reactivateSubscriptionIfSettled, which needs to see the old
          // status — so leave it in place and let that set 'active'.
          const recovering =
            mappedStatus === 'active' &&
            (local.status === 'past_due' || local.status === 'suspended')

          await db.subscription.update({
            where: { id: local.id },
            data: {
              ...(recovering ? {} : { status: mappedStatus }),
              ...(periodStart ? { currentPeriodStart: periodStart } : {}),
              ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
              cancelAtPeriodEnd,
            },
          })

          // Stripe's status alone changed a label: sites stayed up after
          // Stripe gave up on the card, and stayed down after it recovered.
          if (status === 'unpaid') {
            await suspendSubscriptionForNonPayment(
              local.id,
              'card payments for this plan kept failing'
            )
          } else if (recovering) {
            await reactivateSubscriptionIfSettled(local.id)
          }

          await createNotification({
            userId: local.userId,
            title: 'Subscription Updated',
            message: `Your subscription status is now: ${mappedStatus}.`,
            type: 'info',
            link: '/?tab=billing',
          })
        }
      }
    }

    // ── customer.subscription.deleted ───────────────────────────
    else if (eventType === 'customer.subscription.deleted') {
      const sub = data as unknown as Stripe.Subscription
      const subId = sub?.id

      if (subId) {
        const local = await db.subscription.findFirst({
          where: { stripeSubId: subId },
        })
        if (local) {
          await db.subscription.update({
            where: { id: local.id },
            data: {
              status: 'cancelled',
              cancelAtPeriodEnd: false,
            },
          })

          await processEvent({
            type: 'subscription_cancelled',
            userId: local.userId,
            payload: { subscriptionId: local.id },
          })

          // The plan is gone, so are the websites it paid for — unless
          // another hosting plan still covers them. Stopped, not deleted.
          const plan = await db.plan.findUnique({
            where: { id: local.planId },
            select: { slug: true },
          })
          if (
            !isEmailPlanSlug(plan?.slug) &&
            !(await hasOtherHostingInGoodStanding(local.userId, local.id))
          ) {
            await stopUserWebsites(local.userId).catch((err) =>
              console.error('[stripe-webhook] stopping websites failed:', err)
            )
          }

          await createNotification({
            userId: local.userId,
            title: 'Subscription Cancelled',
            message: 'Your subscription has been cancelled.',
            type: 'warning',
            link: '/?tab=billing',
          })
        }
      }
    }

    // ── invoice.payment_succeeded ───────────────────────────────
    else if (eventType === 'invoice.payment_succeeded') {
      const invoice = data as unknown as Stripe.Invoice
      const customerId =
        (invoice?.customer as string) || (invoice?.customer as unknown as { id?: string })?.id
      const subId = getInvoiceSubscriptionId(invoice)
      const chargeId = getInvoiceChargeId(invoice)
      const amountDue =
        typeof invoice?.amount_paid === 'number' ? invoice.amount_paid / 100 : 0
      const currency = invoice?.currency || 'usd'

      // Try to find the user via their subscription record (by stripe sub ID)
      let userId: string | null = null
      if (subId) {
        const sub = await db.subscription.findFirst({
          where: { stripeSubId: subId },
        })
        if (sub) userId = sub.userId
      }
      // Fall back to customer ID lookup
      if (!userId && customerId) {
        const sub = await db.subscription.findFirst({
          where: { stripeCustomerId: customerId },
        })
        if (sub) userId = sub.userId
      }

      if (userId) {
        // Record a new payment (renewal). Deduplicate on the Stripe invoice
        // id — one invoice is paid once. The charge id is often null on newer
        // API versions, which made every redelivery record another payment.
        const existing = invoice?.id
          ? await db.payment.findFirst({
              where: { stripeInvoiceId: invoice.id, status: 'completed' },
            })
          : chargeId
            ? await db.payment.findFirst({ where: { stripePaymentId: chargeId } })
            : null
        if (!existing) {
          await db.payment.create({
            data: {
              userId,
              amount: amountDue,
              currency,
              status: 'completed',
              type: 'hosting',
              stripePaymentId: chargeId,
              stripeInvoiceId: invoice?.id || null,
              metadata: JSON.stringify({
                invoiceId: invoice?.id,
                subscriptionId: subId,
                customerId,
                recurring: true,
              }),
            },
          })
        }

        await createNotification({
          userId,
          title: 'Payment Received',
          message: `A payment of $${amountDue.toFixed(2)} was successfully processed.`,
          type: 'success',
          link: '/?tab=billing',
        })
      }
    }

    // ── invoice.payment_failed ──────────────────────────────────
    else if (eventType === 'invoice.payment_failed') {
      const invoice = data as unknown as Stripe.Invoice
      const subId = getInvoiceSubscriptionId(invoice)
      const amountDue =
        typeof invoice?.amount_due === 'number' ? invoice.amount_due / 100 : 0
      const attemptCount = invoice?.attempt_count || 1

      let userId: string | null = null
      if (subId) {
        const sub = await db.subscription.findFirst({
          where: { stripeSubId: subId },
        })
        if (sub) userId = sub.userId
      }

      if (userId) {
        // Mark subscription as past_due
        if (subId) {
          await db.subscription.updateMany({
            where: { stripeSubId: subId },
            data: { status: 'past_due' },
          })
        }

        // Record a failed payment
        await db.payment.create({
          data: {
            userId,
            amount: amountDue,
            currency: invoice?.currency || 'usd',
            status: 'failed',
            type: 'hosting',
            stripeInvoiceId: invoice?.id || null,
            metadata: JSON.stringify({
              invoiceId: invoice?.id,
              subscriptionId: subId,
              attemptCount,
              failureReason:
                (invoice as unknown as { last_finalization_error?: { message?: string } })
                  ?.last_finalization_error?.message || 'Payment failed',
            }),
          },
        })

        await processEvent({
          type: 'payment_failed',
          userId,
          payload: { subscriptionId: subId },
        })

        // In-app AND email: a customer whose card fails rarely has the panel
        // open, and only finds out when the site goes down.
        await notifyPaymentFailed({
          userId,
          amount: amountDue,
          currency: (invoice?.currency || 'usd').toUpperCase(),
          method: 'card',
          reason: `attempt #${attemptCount} — please update your payment method`,
        }).catch(() => {})
      }
    }

    // ── charge.refunded ─────────────────────────────────────────
    // A refund made in the Stripe dashboard. Books it against the payment and
    // its invoice (recorded as a gateway refund; the money already moved in
    // Stripe). Services are NOT cancelled automatically — that stays an admin
    // decision.
    else if (eventType === 'charge.refunded') {
      const charge = data as unknown as Stripe.Charge
      const outcome = await recordStripeChargeRefund(charge).catch((err) => {
        console.error('[stripe-webhook] charge.refunded handling failed:', err)
        return 'error'
      })
      console.log(`[stripe-webhook] charge.refunded ${charge?.id}: ${outcome}`)
    }

    // Demo-mode webhook payload (legacy event names)
    else if (
      eventType === 'payment_success' ||
      eventType === 'subscription_cancelled' ||
      eventType === 'payment_failed'
    ) {
      const payload = (data || {}) as Record<string, unknown>
      const userId = (payload.userId as string) || (payload.metadata as Record<string, unknown>)?.userId as string
      const paymentId = payload.paymentId as string
      const planId = payload.planId as string
      const purchaseType =
        (payload.purchaseType as string) ||
        (payload.metadata as Record<string, unknown>)?.purchaseType as string ||
        'hosting'
      const domainName = payload.domainName as string | null

      if (userId) {
        if (eventType === 'payment_success' && paymentId) {
          // Same activation path as every live gateway: only the payer's own
          // pending payment, settled invoice, provisioned once.
          const payment = await db.payment.findUnique({ where: { id: paymentId } })
          if (payment && payment.userId === userId) {
            const result = await activatePayment({ paymentId, method: 'stripe' }).catch(
              (err: unknown) => {
                console.error('[stripe-webhook/legacy] activation failed:', err)
                return { success: false, error: 'activation error' }
              }
            )
            console.log(
              `[stripe-webhook/legacy] activation for ${paymentId}: ${
                result.success ? 'ok' : result.error
              }`
            )
          }
        } else {
          // Cancellation / failure events carry no provisioning work.
          await processEvent({
            type: eventType as 'subscription_cancelled' | 'payment_failed',
            userId,
            payload: { paymentId, planId, purchaseType, domainName },
          })
        }
      }
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error('Webhook error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

function mapStripeSubStatus(status: string | undefined): string {
  if (!status) return 'active'
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active'
    case 'past_due':
      return 'past_due'
    case 'canceled':
      return 'cancelled'
    case 'unpaid':
      return 'past_due'
    case 'incomplete':
    case 'incomplete_expired':
      return 'pending'
    default:
      return 'active'
  }
}
