import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { isStripeDemoMode } from '@/lib/stripe'
import Stripe from 'stripe'

/**
 * POST /api/billing/portal
 *
 * Creates a Stripe Customer Portal session so the user can manage their
 * subscription (update card, cancel, view invoices) directly in Stripe.
 *
 * Returns: { url }
 *
 * In demo mode returns a simple message instead of a redirect URL.
 */
export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }

    const decoded = verifyToken(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    // Find the user's active subscription with a Stripe customer ID
    const subscription = await db.subscription.findFirst({
      where: {
        userId: decoded.userId,
        status: { in: ['active', 'pending', 'past_due', 'trialing'] },
      },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    })

    if (!subscription) {
      return NextResponse.json(
        { error: 'No active subscription found' },
        { status: 404 }
      )
    }

    // ── Demo mode ──────────────────────────────────────────────
    if (isStripeDemoMode()) {
      return NextResponse.json({
        url: null,
        demo: true,
        message:
          'Stripe Customer Portal is not available in demo mode. ' +
          'Set STRIPE_SECRET_KEY to enable self-service subscription management.',
        subscription: {
          id: subscription.id,
          status: subscription.status,
          planName: subscription.plan.name,
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        },
      })
    }

    // ── Real Stripe mode ───────────────────────────────────────
    const customerId = subscription.stripeCustomerId
    if (!customerId) {
      return NextResponse.json(
        {
          error:
            'No Stripe customer ID found for your subscription. ' +
            'Please contact support to manage your subscription.',
        },
        { status: 400 }
      )
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
    const returnUrl = `${appUrl}/?tab=billing`

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion,
    })

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    })

    return NextResponse.json({
      url: session.url,
      demo: false,
    })
  } catch (error) {
    console.error('Portal session error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
