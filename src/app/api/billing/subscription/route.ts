import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import {
  createCustomer,
  createSubscription,
  cancelSubscription,
  isStripeDemoMode, getSubscriptionPeriod } from '@/lib/stripe'
import { createNotification } from '@/lib/notifications'

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

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

    const subscription = await db.subscription.findFirst({
      where: {
        userId: decoded.userId,
        status: { in: ['active', 'pending', 'past_due', 'trialing'] },
      },
      include: {
        plan: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    if (!subscription) {
      return NextResponse.json({ subscription: null })
    }

    return NextResponse.json({
      subscription: {
        id: subscription.id,
        status: subscription.status,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        stripeSubId: subscription.stripeSubId,
        stripeCustomerId: subscription.stripeCustomerId,
        createdAt: subscription.createdAt,
        plan: {
          id: subscription.plan.id,
          name: subscription.plan.name,
          slug: subscription.plan.slug,
          price: subscription.plan.price,
          ram: subscription.plan.ram,
          cpu: subscription.plan.cpu,
          storage: subscription.plan.storage,
          bandwidth: subscription.plan.bandwidth,
          projects: subscription.plan.projects,
          ssl: subscription.plan.ssl,
          customDomain: subscription.plan.customDomain,
        },
      },
    })
  } catch (error) {
    console.error('Get subscription error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/billing/subscription
 *
 * Subscribe the authenticated user to a plan. Creates a Stripe customer
 * (if the user doesn't already have one) and a Stripe subscription.
 *
 * Body:
 *   { planId: string, priceId?: string }
 *
 * In demo mode (STRIPE_SECRET_KEY unset) the Stripe calls are simulated
 * and the subscription is created as 'active' immediately.
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

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const body = await request.json().catch(() => ({}))
    const { planId, priceId } = body as { planId?: string; priceId?: string }

    if (!planId) {
      return NextResponse.json(
        { error: 'Plan ID is required' },
        { status: 400 }
      )
    }

    const plan = await db.plan.findUnique({ where: { id: planId } })
    if (!plan) {
      return NextResponse.json(
        { error: 'Plan not found' },
        { status: 404 }
      )
    }

    const user = await db.user.findUnique({ where: { id: decoded.userId } })
    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    // Look up any existing Stripe customer ID for this user.
    // We fetch all subscriptions for the user and pick the first one with
    // a stripeCustomerId - this avoids issues if the Prisma client hasn't
    // been regenerated to include the new stripeCustomerId column in
    // advanced filter operators.
    let stripeCustomerId: string | null = null
    const userSubs = await db.subscription.findMany({
      where: { userId: decoded.userId },
      orderBy: { createdAt: 'desc' },
    })
    const existingSub = userSubs.find(
      (s) => s.stripeCustomerId != null && s.stripeCustomerId !== ''
    )
    if (existingSub?.stripeCustomerId) {
      stripeCustomerId = existingSub.stripeCustomerId
    }

    const demoMode = isStripeDemoMode()

    // Create a Stripe customer if the user doesn't have one yet
    if (!stripeCustomerId) {
      try {
        const customer = await createCustomer(user.email, user.name)
        stripeCustomerId = customer.customerId
      } catch (err) {
        console.error('[subscription] createCustomer failed:', err)
        // Fall back to a placeholder so we can still proceed in demo mode
        stripeCustomerId = `cus_demo_${Date.now()}`
      }
    }

    // Resolve the Stripe price ID - body > env var keyed by plan slug
    const resolvedPriceId =
      priceId ||
      process.env[`STRIPE_PRICE_ID_${plan.slug.toUpperCase()}`] ||
      process.env.STRIPE_PRICE_ID_DEFAULT ||
      `price_demo_${plan.slug}`

    // Create the Stripe subscription
    let stripeSubId = `sub_sim_${Date.now()}`
    let periodStart = new Date()
    let periodEnd = new Date()
    periodEnd.setFullYear(periodEnd.getFullYear() + 1)

    if (!demoMode) {
      try {
        const stripeSub = await createSubscription({
          customerId: stripeCustomerId,
          priceId: resolvedPriceId,
        })
        stripeSubId = stripeSub.id
        // Period lives on the subscription ITEM in current Stripe API
        // versions; see getSubscriptionPeriod.
        const period = getSubscriptionPeriod(stripeSub)
        if (period.start) periodStart = period.start
        if (period.end) periodEnd = period.end
      } catch (err) {
        console.error('[subscription] createSubscription failed:', err)
        return NextResponse.json(
          { error: 'Failed to create Stripe subscription' },
          { status: 502 }
        )
      }
    }

    // Cancel any existing active subscriptions for the user
    await db.subscription.updateMany({
      where: { userId: decoded.userId, status: 'active' },
      data: { status: 'cancelled', cancelAtPeriodEnd: true },
    })

    // Create the new subscription record.
    // NOTE: We intentionally omit `stripeCustomerId` here because the
    // running dev server may have an older Prisma client cached that
    // doesn't know about the new column. We set it via raw SQL right
    // after, which works regardless of the cached client version.
    const subscription = await db.subscription.create({
      data: {
        userId: decoded.userId,
        planId: plan.id,
        status: demoMode ? 'active' : 'active',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        stripeSubId,
      },
      include: { plan: true },
    })

    // Set stripeCustomerId via raw SQL (handles cached Prisma client)
    if (stripeCustomerId) {
      try {
        await db.$executeRaw`
          UPDATE Subscription SET stripeCustomerId = ${stripeCustomerId} WHERE id = ${subscription.id}
        `
      } catch (err) {
        console.error('[subscription] failed to set stripeCustomerId:', err)
      }
    }

    // Record the payment
    const payment = await db.payment.create({
      data: {
        userId: decoded.userId,
        subscriptionId: subscription.id,
        amount: plan.price,
        currency: 'usd',
        status: demoMode ? 'completed' : 'pending',
        type: 'hosting',
        stripePaymentId: demoMode ? `pay_demo_${Date.now()}` : null,
        stripeInvoiceId: demoMode ? `in_demo_${Date.now()}` : null,
        metadata: JSON.stringify({
          planId: plan.id,
          planName: plan.name,
          planSlug: plan.slug,
          stripeSubId,
          stripeCustomerId,
          demoMode,
        }),
      },
    })

    await createNotification({
      userId: decoded.userId,
      title: 'Subscription Activated',
      message: demoMode
        ? `Your ${plan.name} subscription is now active (demo mode).`
        : `Your ${plan.name} subscription has been activated. Your card will be charged $${plan.price.toFixed(2)}/mo.`,
      type: 'success',
      link: '/?tab=billing',
    })

    // Audit subscription creation
    await logAudit({
      userId: decoded.userId,
      action: 'subscription.create',
      resource: 'subscription',
      resourceId: subscription.id,
      req: request,
      metadata: {
        planId: plan.id,
        planName: plan.name,
        planSlug: plan.slug,
        amount: plan.price,
        currency: 'usd',
        paymentId: payment.id,
        stripeSubId,
        stripeCustomerId,
        demoMode,
      },
    })

    return NextResponse.json(
      {
        subscription: {
          id: subscription.id,
          status: subscription.status,
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          stripeSubId: subscription.stripeSubId,
          stripeCustomerId: subscription.stripeCustomerId,
          createdAt: subscription.createdAt,
          plan: {
            id: subscription.plan.id,
            name: subscription.plan.name,
            slug: subscription.plan.slug,
            price: subscription.plan.price,
          },
        },
        payment: {
          id: payment.id,
          amount: payment.amount,
          status: payment.status,
        },
        demo: demoMode,
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('Create subscription error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/billing/subscription
 *
 * Cancel the user's active subscription. Calls Stripe's
 * cancelSubscription() (cancel at period end) and updates the local
 * Subscription record.
 */
export async function DELETE(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

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

    const subscription = await db.subscription.findFirst({
      where: {
        userId: decoded.userId,
        status: { in: ['active', 'pending', 'past_due', 'trialing'] },
      },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    })

    if (!subscription) {
      return NextResponse.json(
        { error: 'No active subscription to cancel' },
        { status: 404 }
      )
    }

    // Call Stripe to cancel at period end (if we have a real sub ID)
    let cancelledViaStripe = false
    if (subscription.stripeSubId && !isStripeDemoMode()) {
      try {
        await cancelSubscription(subscription.stripeSubId)
        cancelledViaStripe = true
      } catch (err) {
        console.error('[subscription] cancelSubscription failed:', err)
        // Continue with local cancellation even if Stripe fails
      }
    } else if (isStripeDemoMode()) {
      // In demo mode, simulate the cancellation
      try {
        await cancelSubscription(subscription.stripeSubId || `sub_demo_${subscription.id}`)
        cancelledViaStripe = true
      } catch (err) {
        console.error('[subscription] demo cancelSubscription failed:', err)
      }
    }

    // Immediate only when explicitly asked for; the default is to let the
    // paid-for period run out.
    let immediate = false
    try {
      const body = await request.json().catch(() => null)
      immediate = Boolean(body?.immediate)
    } catch {
      /* no body — scheduled cancellation */
    }
    const periodEnded = new Date(subscription.currentPeriodEnd) <= new Date()

    // Update local subscription.
    //
    // Scheduling a cancellation must NOT set status='cancelled'. The customer
    // has paid to the end of the period and is told so in the message below,
    // but `cancelled` is a terminal state: the billing sweep only looks at
    // active/past_due/trialing so the subscription was never revisited, and
    // email-lifecycle suspends mail for any cancelled subscription — so
    // cancelling took the service away within the hour while promising it
    // until the period end. It stays active, flagged, and stops renewing.
    await db.subscription.update({
      where: { id: subscription.id },
      data:
        immediate || periodEnded
          ? { status: 'cancelled', cancelAtPeriodEnd: true, autoRenew: false }
          : { cancelAtPeriodEnd: true, autoRenew: false },
    })

    await createNotification({
      userId: decoded.userId,
      title: immediate || periodEnded ? 'Subscription cancelled' : 'Subscription set to cancel',
      message:
        immediate || periodEnded
          ? `Your ${subscription.plan.name} subscription has been cancelled and the services on it are being wound down.`
          : `Your ${subscription.plan.name} subscription will end on ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}. Everything keeps working until then, and you can undo this at any point before that date.`,
      type: 'warning',
      link: '/?tab=billing',
    })

    await logAudit({
      userId: decoded.userId,
      action: 'subscription.cancel',
      resource: 'subscription',
      resourceId: subscription.id,
      req: request,
      metadata: {
        planId: subscription.planId,
        planName: subscription.plan.name,
        stripeSubId: subscription.stripeSubId,
        cancelledViaStripe,
        immediate: immediate || periodEnded,
      },
    })

    return NextResponse.json({
      cancelled: true,
      // false when the cancellation is scheduled — the UI needs to say
      // "ends on X" rather than "cancelled" for those.
      immediate: immediate || periodEnded,
      cancelAtPeriodEnd: true,
      cancelledViaStripe,
      activeUntil: subscription.currentPeriodEnd,
      canResume: !(immediate || periodEnded),
    })
  } catch (error) {
    console.error('Cancel subscription error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
