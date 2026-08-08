/**
 * PATCH /api/billing/subscription/auto-renew  { autoRenew: boolean }
 *
 * Turn automatic renewal on or off without cancelling.
 *
 * `autoRenew` already drove the billing sweep — it is the flag that decides
 * whether the next period's invoice is raised — but nothing let a customer
 * change it. Their only way to stop being billed was Cancel, which is a
 * heavier decision than "I'll decide again next month".
 *
 * The distinction that matters:
 *   - auto-renew OFF → the subscription runs to the end of the period and
 *     then lapses unpaid. Nothing is scheduled to end it, and turning it back
 *     on resumes normal billing.
 *   - cancel        → the customer has said they are leaving. The end date is
 *     fixed and the services are wound down when it arrives.
 *
 * Stripe-managed subscriptions are refused: Stripe owns their renewal
 * lifecycle via webhooks, and flipping a local flag would silently disagree
 * with what Stripe actually does.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'

export async function PATCH(request: Request) {
  try {
    const token = extractTokenFromHeader(request.headers.get('Authorization'))
    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }
    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const body = await request.json().catch(() => null)
    if (typeof body?.autoRenew !== 'boolean') {
      return NextResponse.json(
        { error: 'autoRenew must be true or false' },
        { status: 400 }
      )
    }

    const subscription = await db.subscription.findFirst({
      where: {
        userId: decoded.userId,
        status: { in: ['active', 'trialing', 'past_due'] },
      },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    })
    if (!subscription) {
      return NextResponse.json(
        { error: 'No active subscription' },
        { status: 404 }
      )
    }

    if (subscription.stripeSubId) {
      return NextResponse.json(
        {
          error:
            'This subscription renews through Stripe. Manage renewal from the billing portal so the two cannot disagree.',
          code: 'STRIPE_MANAGED',
        },
        { status: 409 }
      )
    }

    if (subscription.cancelAtPeriodEnd) {
      return NextResponse.json(
        {
          error:
            'This subscription is already set to cancel. Resume it first if you want it to keep renewing.',
          code: 'CANCELLATION_PENDING',
        },
        { status: 409 }
      )
    }

    const updated = await db.subscription.update({
      where: { id: subscription.id },
      data: { autoRenew: body.autoRenew },
    })

    await logAudit({
      userId: decoded.userId,
      action: body.autoRenew
        ? 'subscription.autorenew.enable'
        : 'subscription.autorenew.disable',
      resource: 'subscription',
      resourceId: subscription.id,
      req: request,
      metadata: { planName: subscription.plan.name },
    })

    return NextResponse.json({
      autoRenew: updated.autoRenew,
      currentPeriodEnd: updated.currentPeriodEnd,
      message: body.autoRenew
        ? 'Automatic renewal is on. Your plan will renew as normal.'
        : `Automatic renewal is off. Your plan stays active until ${new Date(
            updated.currentPeriodEnd
          ).toLocaleDateString()} and will not be billed again unless you turn this back on.`,
    })
  } catch (error) {
    console.error('Auto-renew toggle error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
