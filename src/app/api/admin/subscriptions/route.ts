import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { createNotification } from '@/lib/notifications'

/**
 * Admin subscription management.
 *
 * With offline payments the admin is the billing system: they need to see
 * who is active/expiring/suspended and be able to extend a period when
 * someone pays late.
 */
function requireAdmin(request: Request): {
  decoded: { userId: string; email: string; role: string }
} | null {
  const token = extractTokenFromHeader(request.headers.get('Authorization'))
  if (!token) return null
  const decoded = verifyToken(token)
  if (!decoded) return null
  if (decoded.role !== 'super_admin' && decoded.role !== 'admin') return null
  return { decoded }
}

/** GET /api/admin/subscriptions?status=active|past_due|suspended|all */
export async function GET(request: Request) {
  try {
    const auth = requireAdmin(request)
    if (!auth) {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const limit = Math.min(Number(searchParams.get('limit')) || 200, 500)

    const subs = await db.subscription.findMany({
      where: { ...(status && status !== 'all' ? { status } : {}) },
      orderBy: { currentPeriodEnd: 'asc' },
      take: limit,
      include: {
        user: { select: { id: true, name: true, email: true } },
        plan: { select: { id: true, name: true, price: true } },
      },
    })

    const now = Date.now()
    const items = subs.map((s) => {
      const end = new Date(s.currentPeriodEnd)
      const daysLeft = Math.ceil((end.getTime() - now) / (24 * 60 * 60 * 1000))
      return {
        id: s.id,
        status: s.status,
        user: s.user,
        plan: s.plan,
        currentPeriodStart: s.currentPeriodStart,
        currentPeriodEnd: s.currentPeriodEnd,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        createdAt: s.createdAt,
        // Stripe-backed subs are driven by Stripe webhooks — the billing
        // sweep skips them and the admin shouldn't hand-edit their periods.
        managedByStripe: Boolean(s.stripeSubId),
        daysLeft,
        expired: end.getTime() <= now,
      }
    })

    return NextResponse.json({
      subscriptions: items,
      counts: {
        active: items.filter((i) => i.status === 'active').length,
        pending: items.filter((i) => i.status === 'pending').length,
        past_due: items.filter((i) => i.status === 'past_due').length,
        suspended: items.filter((i) => i.status === 'suspended').length,
        cancelled: items.filter((i) => i.status === 'cancelled').length,
      },
    })
  } catch (error) {
    console.error('[admin/subscriptions] GET failed:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * PATCH /api/admin/subscriptions
 * Body: { id, action: "extend" | "activate" | "suspend" | "cancel", days?: number }
 *
 * "extend" is the common one: a customer paid by bank transfer, so push the
 * period out and put the subscription back to active.
 */
export async function PATCH(request: Request) {
  try {
    const auth = requireAdmin(request)
    if (!auth) {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }

    const body = (await request.json().catch(() => ({}))) as {
      id?: string
      action?: string
      days?: number
    }
    const id = body.id
    const action = (body.action || '').toLowerCase()
    if (!id || !action) {
      return NextResponse.json(
        { error: 'id and action are required' },
        { status: 400 }
      )
    }

    const sub = await db.subscription.findUnique({
      where: { id },
      include: { plan: { select: { name: true } } },
    })
    if (!sub) {
      return NextResponse.json(
        { error: 'Subscription not found' },
        { status: 404 }
      )
    }
    if (sub.stripeSubId && action !== 'cancel') {
      return NextResponse.json(
        {
          error:
            'This subscription is managed by Stripe — change it in Stripe so the two stay in sync.',
        },
        { status: 400 }
      )
    }

    let data: Record<string, unknown> = {}
    let message = ''

    if (action === 'extend') {
      const days = Number(body.days)
      if (!Number.isFinite(days) || days <= 0 || days > 3650) {
        return NextResponse.json(
          { error: 'days must be between 1 and 3650' },
          { status: 400 }
        )
      }
      // Extend from whichever is later: now, or the existing end date. That
      // way extending an already-expired sub gives a full period from today
      // rather than silently landing in the past.
      const base = Math.max(
        Date.now(),
        new Date(sub.currentPeriodEnd).getTime()
      )
      const newEnd = new Date(base + days * 24 * 60 * 60 * 1000)
      data = {
        currentPeriodEnd: newEnd,
        status: 'active',
        cancelAtPeriodEnd: false,
      }
      message = `Extended by ${days} day${days === 1 ? '' : 's'} — now active until ${newEnd.toDateString()}.`
    } else if (action === 'activate') {
      data = { status: 'active' }
      message = 'Subscription activated.'
    } else if (action === 'suspend') {
      data = { status: 'suspended' }
      message = 'Subscription suspended.'
    } else if (action === 'cancel') {
      data = { status: 'cancelled', cancelAtPeriodEnd: true }
      message = 'Subscription cancelled.'
    } else {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }

    const updated = await db.subscription.update({ where: { id }, data })

    await logAudit({
      userId: auth.decoded.userId,
      action: `subscription.${action}`,
      resource: 'subscription',
      resourceId: id,
      req: request,
      metadata: { days: body.days ?? null, plan: sub.plan?.name ?? null },
    }).catch(() => {})

    await createNotification({
      userId: sub.userId,
      title:
        action === 'suspend'
          ? 'Subscription Suspended'
          : action === 'cancel'
            ? 'Subscription Cancelled'
            : 'Subscription Updated',
      message:
        action === 'extend'
          ? `Your ${sub.plan?.name || 'hosting'} plan is active until ${new Date(updated.currentPeriodEnd).toDateString()}.`
          : message,
      type:
        action === 'suspend' || action === 'cancel' ? 'warning' : 'success',
      link: '/?tab=billing',
    }).catch(() => {})

    return NextResponse.json({
      success: true,
      message,
      subscription: {
        id: updated.id,
        status: updated.status,
        currentPeriodEnd: updated.currentPeriodEnd,
      },
    })
  } catch (error) {
    console.error('[admin/subscriptions] PATCH failed:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
