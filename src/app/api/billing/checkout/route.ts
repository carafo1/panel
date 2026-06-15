import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { processEvent } from '@/lib/automation'

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

    const body = await request.json()
    const { planId, type, domainName } = body // type: hosting, domain, both

    if (!planId || !type) {
      return NextResponse.json(
        { error: 'planId and type (hosting/domain/both) are required' },
        { status: 400 }
      )
    }

    if (!['hosting', 'domain', 'both'].includes(type)) {
      return NextResponse.json(
        { error: 'Type must be hosting, domain, or both' },
        { status: 400 }
      )
    }

    // Get plan
    const plan = await db.plan.findUnique({ where: { id: planId } })
    if (!plan) {
      return NextResponse.json(
        { error: 'Plan not found' },
        { status: 404 }
      )
    }

    // Calculate amount
    let amount = plan.price
    if (type === 'domain') {
      amount = 12.99 // Domain registration fee
    } else if (type === 'both') {
      amount = plan.price + 12.99
    }

    // Create or get active subscription
    let subscription = await db.subscription.findFirst({
      where: {
        userId: decoded.userId,
        status: 'active',
      },
    })

    if (!subscription && type !== 'domain') {
      const now = new Date()
      subscription = await db.subscription.create({
        data: {
          userId: decoded.userId,
          planId: plan.id,
          status: 'active',
          currentPeriodStart: now,
          currentPeriodEnd: new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()),
          stripeSubId: `sub_sim_${Date.now()}`,
        },
      })
    }

    // Create payment record
    const payment = await db.payment.create({
      data: {
        userId: decoded.userId,
        subscriptionId: subscription?.id || null,
        amount,
        currency: 'usd',
        status: 'pending',
        type,
        stripePaymentId: `pay_sim_${Date.now()}`,
        stripeInvoiceId: `in_sim_${Date.now()}`,
        metadata: JSON.stringify({
          planId: plan.id,
          planName: plan.name,
          domainName: domainName || null,
          purchaseType: type,
        }),
      },
    })

    // Simulate Stripe checkout success immediately
    await db.payment.update({
      where: { id: payment.id },
      data: { status: 'completed' },
    })

    // Process automation event
    const automationResult = await processEvent({
      type: 'payment_success',
      userId: decoded.userId,
      payload: {
        paymentId: payment.id,
        planId: plan.id,
        purchaseType: type,
        domainName: domainName || null,
        subscriptionId: subscription?.id || null,
      },
    })

    return NextResponse.json({
      payment: {
        id: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        status: 'completed',
        type: payment.type,
      },
      subscription: subscription ? {
        id: subscription.id,
        status: subscription.status,
        planName: plan.name,
      } : null,
      automation: automationResult,
    }, { status: 201 })
  } catch (error) {
    console.error('Checkout error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
