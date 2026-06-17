import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { retrieveSession, isStripeDemoMode } from '@/lib/stripe'
import { processEvent } from '@/lib/automation'
import { createNotification } from '@/lib/notifications'

/**
 * GET /api/billing/success?session_id={CHECKOUT_SESSION_ID}
 *
 * Stripe redirects users here after a successful Checkout. This handler:
 *   1. Retrieves the session from Stripe (verifies payment status)
 *   2. Updates the matching Payment record to 'completed'
 *   3. Activates the user's pending Subscription
 *   4. Drives the automation pipeline (creates project / domain / deployment)
 *   5. Notifies the user
 *   6. Redirects to the dashboard billing tab
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const sessionId = searchParams.get('session_id')

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
    // Note: the app is a single-page app rendered at `/`. The billing tab
    // is controlled by the dashboard store. We pass ?payment=success so
    // the frontend can switch to the billing tab + show a toast.
    const dashboardUrl = `${appUrl}/?tab=billing&payment=success`
    const errorUrl = `${appUrl}/?tab=billing&payment=error`
    const failedUrl = `${appUrl}/?tab=billing&payment=failed`

    if (!sessionId) {
      return NextResponse.redirect(new URL(errorUrl, request.url))
    }

    // ── Demo mode ──────────────────────────────────────────────
    if (isStripeDemoMode()) {
      // In demo mode, payments are already marked as completed at checkout
      // time. We just redirect the user to the dashboard.
      console.log('[billing/success] DEMO MODE: session_id =', sessionId)
      return NextResponse.redirect(new URL(dashboardUrl, request.url))
    }

    // ── Real Stripe mode ───────────────────────────────────────
    const session = await retrieveSession(sessionId)

    if (session.payment_status !== 'paid') {
      console.warn(
        '[billing/success] session not paid:',
        session.id,
        session.payment_status
      )
      return NextResponse.redirect(new URL(failedUrl, request.url))
    }

    const metadata = (session.metadata || {}) as Record<string, string>
    const userId = metadata.userId
    const planId = metadata.planId
    const purchaseType = metadata.purchaseType || metadata.type || 'hosting'
    const domainName = metadata.domainName || null
    const projectName = metadata.projectName || null

    if (!userId) {
      console.warn('[billing/success] session has no userId metadata')
      return NextResponse.redirect(new URL(dashboardUrl, request.url))
    }

    // Find the pending Payment we created at checkout (matched by sessionId)
    let payment = await db.payment.findFirst({
      where: { stripePaymentId: sessionId },
    })

    if (payment) {
      // Update to completed, store the actual payment intent / charge ID
      await db.payment.update({
        where: { id: payment.id },
        data: {
          status: 'completed',
          stripePaymentId:
            (session.payment_intent as string) || payment.stripePaymentId,
        },
      })
    } else {
      // No payment record found — create one from the session data
      const amountTotal =
        typeof session.amount_total === 'number'
          ? session.amount_total / 100
          : 0
      payment = await db.payment.create({
        data: {
          userId,
          amount: amountTotal,
          currency: session.currency || 'usd',
          status: 'completed',
          type: purchaseType,
          stripePaymentId:
            (session.payment_intent as string) || sessionId,
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

    // Drive the automation pipeline (creates project / domain / deployment)
    await processEvent({
      type: 'payment_success',
      userId,
      payload: {
        paymentId: payment.id,
        planId,
        purchaseType,
        domainName,
        subscriptionId: subscription?.id || null,
        projectName,
      },
    })

    // Notify the user
    await createNotification({
      userId,
      title: 'Payment Successful',
      message: `Your payment of $${payment.amount.toFixed(2)} has been processed successfully. Your resources are being provisioned.`,
      type: 'success',
      link: '/?tab=billing',
    })

    return NextResponse.redirect(new URL(dashboardUrl, request.url))
  } catch (error) {
    console.error('Billing success handler error:', error)
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
    return NextResponse.redirect(
      new URL(`${appUrl}/?tab=billing&payment=error`, request.url)
    )
  }
}
