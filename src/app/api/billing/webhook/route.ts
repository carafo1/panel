import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { processEvent } from '@/lib/automation'
import { provisionForPayment } from '@/lib/provision-on-payment'
import {
  constructWebhookEvent,
  isStripeDemoMode,
  getSubscriptionPeriod,
  getInvoiceSubscriptionId,
  getInvoiceChargeId,
} from '@/lib/stripe'
import { createNotification } from '@/lib/notifications'
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

    if (isStripeDemoMode()) {
      console.warn(
        '[stripe-webhook] DEMO MODE: accepting webhook without signature verification'
      )
    }

    const eventType: string = event.type
    const data = event.data?.object as unknown as Record<string, unknown> | undefined

    // ── checkout.session.completed ──────────────────────────────
    if (eventType === 'checkout.session.completed') {
      const session = data as unknown as Stripe.Checkout.Session
      const sessionId = session?.id
      const metadata = (session?.metadata || {}) as Record<string, string>
      const userId = metadata.userId
      const planId = metadata.planId
      const purchaseType =
        (metadata.purchaseType as string) || (metadata.type as string) || 'hosting'
      const domainName = metadata.domainName || null
      const projectName = metadata.projectName || null
      const framework = metadata.framework || 'nextjs'

      if (!userId) {
        console.warn('[stripe-webhook] checkout.session.completed missing userId')
        return NextResponse.json({ received: true })
      }

      // Find the pending Payment we created at checkout (matched by sessionId)
      let payment = sessionId
        ? await db.payment.findFirst({
            where: { stripePaymentId: sessionId },
          })
        : null

      // If we couldn't find by session ID, fall back to user's most recent pending
      if (!payment) {
        payment = await db.payment.findFirst({
          where: { userId, status: 'pending' },
          orderBy: { createdAt: 'desc' },
        })
      }

      if (payment) {
        // Update the payment record to completed
        await db.payment.update({
          where: { id: payment.id },
          data: {
            status: 'completed',
            stripePaymentId:
              (session?.payment_intent as string) || payment.stripePaymentId,
          },
        })
      } else {
        // No payment record found - create one from the session data
        const amountTotal =
          typeof session?.amount_total === 'number'
            ? session.amount_total / 100
            : 0
        payment = await db.payment.create({
          data: {
            userId,
            amount: amountTotal,
            currency: session?.currency || 'usd',
            status: 'completed',
            type: purchaseType,
            stripePaymentId:
              (session?.payment_intent as string) || sessionId || null,
            metadata: JSON.stringify({
              ...metadata,
              checkoutSessionId: sessionId,
            }),
          },
        })
      }

      // Activate the user's pending subscription if one exists
      const subscription = await db.subscription.findFirst({
        where: { userId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
      })
      if (subscription) {
        await db.subscription.update({
          where: { id: subscription.id },
          data: { status: 'active' },
        })
      }

      // REAL provisioning — creates the container / registers the domain.
      //
      // This used to call processEvent('payment_success'), whose actions are
      // simulated: `create_user_workspace` just sends a "workspace created"
      // notification and returns a made-up id without building anything. A
      // customer who paid via Stripe therefore got a success email and no
      // service. provisionForPayment does the real work and is idempotent, so
      // a retried webhook cannot double-provision (or double-register a
      // domain, which costs real registrar balance).
      const provision = await provisionForPayment(payment.id).catch(
        (err: unknown) => {
          console.error('[stripe-webhook] provisioning failed:', err)
          return { provisioned: false, detail: 'provisioning error' }
        }
      )
      console.log(
        `[stripe-webhook] provisioning for ${payment.id}: ${provision.detail}`
      )

      await createNotification({
        userId,
        title: 'Payment Successful',
        message: `Your payment of $${payment.amount.toFixed(2)} has been processed successfully.`,
        type: 'success',
        link: '/?tab=billing',
      })
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

          await db.subscription.update({
            where: { id: local.id },
            data: {
              status: mappedStatus,
              ...(periodStart ? { currentPeriodStart: periodStart } : {}),
              ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
              cancelAtPeriodEnd,
            },
          })

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
        // Record a new payment (renewal)
        const existing = chargeId
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

        await createNotification({
          userId,
          title: 'Payment Failed',
          message: `Your payment of $${amountDue.toFixed(2)} failed (attempt #${attemptCount}). Please update your payment method.`,
          type: 'error',
          link: '/?tab=billing',
        })
      }
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
        if (paymentId) {
          const payment = await db.payment.findUnique({ where: { id: paymentId } })
          if (payment && payment.status === 'pending') {
            await db.payment.update({
              where: { id: paymentId },
              data: { status: 'completed' },
            })
          }
        }

        if (eventType === 'payment_success' && paymentId) {
          // Same switch as the live path above: real provisioning, not the
          // simulated automation actions.
          const provision = await provisionForPayment(paymentId).catch(
            (err: unknown) => {
              console.error('[stripe-webhook/legacy] provisioning failed:', err)
              return { provisioned: false, detail: 'provisioning error' }
            }
          )
          console.log(
            `[stripe-webhook/legacy] provisioning for ${paymentId}: ${provision.detail}`
          )
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
