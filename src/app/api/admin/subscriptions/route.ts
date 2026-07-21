import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { createNotification } from '@/lib/notifications'
import {
  changeSubscriptionPlan,
  changeBillingCycle,
  transferSubscription,
  forceCancelSubscription,
} from '@/lib/subscription-changes'
import { renewSubscription } from '@/lib/renewals'

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

/**
 * True only for subscriptions genuinely billed by Stripe.
 * Checkout stamps `sub_sim_<ts>` on locally-simulated subscriptions — treating
 * those as Stripe-managed would lock the admin out of every subscription.
 */
function isStripeManaged(stripeSubId: string | null): boolean {
  return Boolean(stripeSubId && !stripeSubId.startsWith('sub_sim_'))
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
        // NOTE: checkout stamps a `sub_sim_*` sentinel on locally-simulated
        // subscriptions; those are NOT Stripe-managed and must stay editable.
        managedByStripe: isStripeManaged(s.stripeSubId),
        autoRenew: (s as { autoRenew?: boolean }).autoRenew !== false,
        lastRenewedAt: (s as { lastRenewedAt?: Date | null }).lastRenewedAt ?? null,
        renewalAttempts: (s as { renewalAttempts?: number }).renewalAttempts ?? 0,
        lastRenewalError:
          (s as { lastRenewalError?: string | null }).lastRenewalError ?? null,
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
      planId?: string
      billingCycle?: string
      newUserId?: string
      reason?: string
      prorate?: boolean
      autoRenew?: boolean
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
    if (isStripeManaged(sub.stripeSubId) && action !== 'cancel') {
      return NextResponse.json(
        {
          error:
            'This subscription is managed by Stripe — change it in Stripe so the two stay in sync.',
        },
        { status: 400 }
      )
    }

    // ── Renew now (raises the next period's invoice) ─────────────────
    if (action === 'renew') {
      const result = await renewSubscription({
        subscriptionId: id,
        force: true,
        adminUserId: auth.decoded.userId,
      })
      if (!result.success) {
        return NextResponse.json(
          { error: result.error || result.skipped || 'Renewal failed' },
          { status: 400 }
        )
      }
      await logAudit({
        userId: auth.decoded.userId,
        action: 'subscription.renew',
        resource: 'subscription',
        resourceId: id,
        req: request,
        metadata: {
          invoiceNumber: result.invoiceNumber ?? null,
          paidFromCredit: result.paidFromCredit ?? false,
        },
      }).catch(() => {})
      return NextResponse.json({
        ...result,
        success: true,
        message: result.paidFromCredit
          ? `Renewed — invoice ${result.invoiceNumber} paid from account credit.`
          : `Renewed — invoice ${result.invoiceNumber} raised.`,
      })
    }

    // ── Toggle auto-renew ────────────────────────────────────────────
    if (action === 'auto_renew') {
      const enabled = body.autoRenew !== false
      await db.subscription.update({
        where: { id },
        data: { autoRenew: enabled, ...(enabled ? { renewalAttempts: 0 } : {}) },
      })
      await logAudit({
        userId: auth.decoded.userId,
        action: 'subscription.auto_renew',
        resource: 'subscription',
        resourceId: id,
        req: request,
        metadata: { autoRenew: enabled },
      }).catch(() => {})
      return NextResponse.json({
        success: true,
        message: `Auto-renew ${enabled ? 'enabled' : 'disabled'}.`,
      })
    }

    // ── Lifecycle actions delegated to the shared library ────────────
    if (
      action === 'change_plan' ||
      action === 'change_cycle' ||
      action === 'transfer' ||
      action === 'force_cancel'
    ) {
      let result: { success: boolean; error?: string; [key: string]: unknown }

      if (action === 'change_plan') {
        if (!body.planId) {
          return NextResponse.json(
            { error: 'planId is required' },
            { status: 400 }
          )
        }
        result = { ...(await changeSubscriptionPlan({
          subscriptionId: id,
          newPlanId: body.planId,
          prorate: body.prorate,
          adminUserId: auth.decoded.userId,
        })) }
      } else if (action === 'change_cycle') {
        if (!body.billingCycle) {
          return NextResponse.json(
            { error: 'billingCycle is required' },
            { status: 400 }
          )
        }
        result = await changeBillingCycle({
          subscriptionId: id,
          billingCycle: body.billingCycle,
        })
      } else if (action === 'transfer') {
        if (!body.newUserId) {
          return NextResponse.json(
            { error: 'newUserId is required' },
            { status: 400 }
          )
        }
        result = await transferSubscription({
          subscriptionId: id,
          newUserId: body.newUserId,
        })
      } else {
        result = await forceCancelSubscription({
          subscriptionId: id,
          reason: body.reason,
        })
      }

      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 400 })
      }

      await logAudit({
        userId: auth.decoded.userId,
        action: `subscription.${action}`,
        resource: 'subscription',
        resourceId: id,
        req: request,
        metadata: {
          planId: body.planId ?? null,
          billingCycle: body.billingCycle ?? null,
          newUserId: body.newUserId ?? null,
          proration: result.proration ?? null,
          invoiceNumber: result.invoiceNumber ?? null,
        },
      }).catch(() => {})

      return NextResponse.json(result)
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
