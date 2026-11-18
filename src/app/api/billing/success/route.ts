import { NextResponse } from 'next/server'
import { retrieveSession, isStripeDemoMode } from '@/lib/stripe'
import { confirmStripeCheckoutSession } from '@/lib/payment-activation'

/**
 * GET /api/billing/success?session_id={CHECKOUT_SESSION_ID}
 *
 * Stripe redirects users here after a successful Checkout. This handler:
 *   1. Retrieves the session from Stripe (verifies payment status)
 *   2. Confirms the Payment created at checkout for THAT session through the
 *      shared activation path (payment-activation.ts), which completes it,
 *      activates its own subscription, settles its invoice and provisions
 *   3. Redirects to the dashboard billing tab
 *
 * The URL is unauthenticated and can be revisited at will, so it must be a
 * no-op the second time: confirmStripeCheckoutSession finds the Payment by
 * the session id (which never changes) and activatePayment claims it
 * atomically. It never creates a Payment and never touches another one.
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

    const result = await confirmStripeCheckoutSession({
      id: session.id,
      payment_status: session.payment_status,
      payment_intent: session.payment_intent as string | { id?: string } | null,
      amount_total: session.amount_total,
      currency: session.currency,
      metadata: (session.metadata || {}) as Record<string, string>,
    })
    console.log(
      `[billing/success] session ${session.id}: ${result.outcome}${
        result.paymentId ? ` (payment ${result.paymentId})` : ''
      }${result.detail ? ` — ${result.detail}` : ''}`
    )

    if (result.outcome === 'activated' || result.outcome === 'already_completed') {
      return NextResponse.redirect(new URL(dashboardUrl, request.url))
    }
    return NextResponse.redirect(new URL(errorUrl, request.url))
  } catch (error) {
    console.error('Billing success handler error:', error)
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
    return NextResponse.redirect(
      new URL(`${appUrl}/?tab=billing&payment=error`, request.url)
    )
  }
}
