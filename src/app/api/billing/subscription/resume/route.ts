/**
 * POST /api/billing/subscription/resume
 *
 * Undo a scheduled cancellation. Clears `cancelAtPeriodEnd` and turns
 * auto-renew back on, so the subscription simply carries on into the next
 * period.
 *
 * There was no way back from Cancel: a customer who cancelled by mistake — or
 * changed their mind an hour later — had to open a support ticket, and the
 * only alternative was buying the plan again from scratch. Since a scheduled
 * cancellation now leaves the subscription active until the period actually
 * ends, undoing it is just clearing the flag.
 *
 * Deliberately refuses once the subscription has genuinely ended. Resurrecting
 * a terminated subscription would skip payment for the new period and, for
 * email, would have to unwind a suspension the retention sweep may already
 * have acted on — a fresh purchase is the honest path there.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { createNotification } from '@/lib/notifications'

export async function POST(request: Request) {
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

    const subscription = await db.subscription.findFirst({
      where: { userId: decoded.userId, cancelAtPeriodEnd: true },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    })

    if (!subscription) {
      return NextResponse.json(
        { error: 'You have no subscription scheduled to cancel.' },
        { status: 404 }
      )
    }

    if (subscription.status === 'cancelled') {
      return NextResponse.json(
        {
          error:
            'This subscription has already ended and cannot be resumed. Choose a plan to start again.',
          code: 'ALREADY_ENDED',
        },
        { status: 409 }
      )
    }

    if (new Date(subscription.currentPeriodEnd) <= new Date()) {
      return NextResponse.json(
        {
          error:
            'The billing period has already ended, so this cannot be resumed. Choose a plan to start again.',
          code: 'PERIOD_ENDED',
        },
        { status: 409 }
      )
    }

    const updated = await db.subscription.update({
      where: { id: subscription.id },
      data: { cancelAtPeriodEnd: false, autoRenew: true, status: 'active' },
    })

    await createNotification({
      userId: decoded.userId,
      title: 'Subscription resumed',
      message: `Your ${subscription.plan.name} subscription will continue as normal and renew on ${new Date(
        subscription.currentPeriodEnd
      ).toLocaleDateString()}.`,
      type: 'success',
      link: '/?tab=billing',
    }).catch(() => {})

    await logAudit({
      userId: decoded.userId,
      action: 'subscription.resume',
      resource: 'subscription',
      resourceId: subscription.id,
      req: request,
      metadata: { planId: subscription.planId, planName: subscription.plan.name },
    })

    return NextResponse.json({
      resumed: true,
      status: updated.status,
      renewsOn: updated.currentPeriodEnd,
    })
  } catch (error) {
    console.error('Resume subscription error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
