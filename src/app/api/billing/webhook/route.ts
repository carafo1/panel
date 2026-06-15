import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { processEvent } from '@/lib/automation'

export async function POST(request: Request) {
  try {
    const body = await request.json()

    // Simulate Stripe webhook payload
    const {
      type: eventType,
      data,
    } = body

    // Handle different webhook event types
    if (eventType === 'payment_success' || eventType === 'checkout.session.completed') {
      const userId = data?.userId || data?.metadata?.userId
      const paymentId = data?.paymentId

      if (!userId) {
        return NextResponse.json(
          { error: 'Missing userId in webhook data' },
          { status: 400 }
        )
      }

      // Update payment status if paymentId is provided
      if (paymentId) {
        const payment = await db.payment.findUnique({ where: { id: paymentId } })
        if (payment && payment.status === 'pending') {
          await db.payment.update({
            where: { id: paymentId },
            data: { status: 'completed' },
          })
        }
      }

      // Process automation event
      await processEvent({
        type: 'payment_success',
        userId,
        payload: {
          paymentId,
          planId: data?.planId || data?.metadata?.planId,
          purchaseType: data?.purchaseType || data?.metadata?.purchaseType || 'hosting',
          domainName: data?.domainName || data?.metadata?.domainName || null,
        },
      })
    } else if (eventType === 'subscription_cancelled' || eventType === 'customer.subscription.deleted') {
      const userId = data?.userId
      if (userId) {
        await processEvent({
          type: 'subscription_cancelled',
          userId,
          payload: { subscriptionId: data?.subscriptionId },
        })
      }
    } else if (eventType === 'payment_failed' || eventType === 'invoice.payment_failed') {
      const userId = data?.userId
      if (userId) {
        await processEvent({
          type: 'payment_failed',
          userId,
          payload: { paymentId: data?.paymentId },
        })
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
