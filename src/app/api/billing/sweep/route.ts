import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { createNotification } from '@/lib/notifications'
import { sendEmail } from '@/lib/email'

/**
 * Billing sweep — subscription lifecycle enforcement.
 *
 * Without this nothing in the system ever compares `currentPeriodEnd` to the
 * current time, so a subscription stays "active" forever. Stripe drives its
 * own lifecycle via webhooks, but offline (manual/bank transfer) and Waafi
 * subscriptions have no such driver — a customer would pay once and keep the
 * service indefinitely.
 *
 * Run periodically (worker-service calls this hourly):
 *   1. REMIND  — active subs expiring within REMIND_DAYS get one reminder.
 *   2. PAST DUE — subs past currentPeriodEnd become 'past_due' (grace period).
 *   3. SUSPEND  — subs past_due for longer than GRACE_DAYS become 'suspended'.
 *
 * Stripe-backed subscriptions are skipped: Stripe is the source of truth for
 * those and we must not fight its webhooks.
 */

const REMIND_DAYS = 5 // notify this many days before expiry
const GRACE_DAYS = 7 // days after expiry before suspending

const CRON_API_KEY =
  process.env.CRON_API_KEY &&
  !/^deployhub-cron-key$|^replace-with/.test(process.env.CRON_API_KEY)
    ? process.env.CRON_API_KEY
    : null

/** Cron key, or an authenticated admin (so it can be run manually). */
function authorise(request: Request): boolean {
  const cronKey = request.headers.get('x-cron-key')
  if (CRON_API_KEY && cronKey && cronKey === CRON_API_KEY) return true

  const token = extractTokenFromHeader(request.headers.get('Authorization'))
  if (!token) return false
  const decoded = verifyToken(token)
  if (!decoded) return false
  return decoded.role === 'super_admin' || decoded.role === 'admin'
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

export async function POST(request: Request) {
  try {
    if (!authorise(request)) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 403 })
    }

    const now = new Date()
    const remindBefore = new Date(
      now.getTime() + REMIND_DAYS * 24 * 60 * 60 * 1000
    )
    const suspendBefore = new Date(
      now.getTime() - GRACE_DAYS * 24 * 60 * 60 * 1000
    )

    const reminded: string[] = []
    const pastDue: string[] = []
    const suspended: string[] = []

    // Only non-Stripe subscriptions — Stripe drives its own lifecycle.
    const subs = await db.subscription.findMany({
      where: {
        status: { in: ['active', 'past_due', 'trialing'] },
        stripeSubId: null,
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        plan: { select: { id: true, name: true, price: true } },
      },
    })

    for (const sub of subs) {
      const end = new Date(sub.currentPeriodEnd)

      // ── 1. Expiring soon → remind once ──────────────────────────
      if (
        (sub.status === 'active' || sub.status === 'trialing') &&
        end > now &&
        end <= remindBefore
      ) {
        const alreadyReminded = await db.notification.findFirst({
          where: {
            userId: sub.userId,
            title: 'Subscription Renewal Due',
            createdAt: { gte: new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000) },
          },
        })
        if (!alreadyReminded) {
          const days = Math.max(
            1,
            Math.ceil((end.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
          )
          await createNotification({
            userId: sub.userId,
            title: 'Subscription Renewal Due',
            message: `Your ${sub.plan?.name || 'hosting'} plan expires in ${days} day${days === 1 ? '' : 's'}. Please renew to keep your services running.`,
            type: 'warning',
            link: '/?tab=billing',
          }).catch(() => {})

          if (sub.user?.email) {
            await sendEmail({
              to: sub.user.email,
              subject: `Your ${sub.plan?.name || 'hosting'} plan expires in ${days} day${days === 1 ? '' : 's'}`,
              html: `<p>Hi ${sub.user.name || 'there'},</p>
<p>Your <strong>${sub.plan?.name || 'hosting'}</strong> plan expires on <strong>${end.toDateString()}</strong>.</p>
<p>To avoid interruption, please renew before then. If you pay by bank transfer, send your payment and we'll confirm it.</p>
<p>— Apsamo Technology</p>`,
            }).catch(() => {})
          }
          reminded.push(sub.id)
        }
        continue
      }

      // ── 2. Expired → past_due (grace period starts) ─────────────
      if (
        (sub.status === 'active' || sub.status === 'trialing') &&
        end <= now
      ) {
        await db.subscription.update({
          where: { id: sub.id },
          data: { status: 'past_due' },
        })
        await createNotification({
          userId: sub.userId,
          title: 'Subscription Expired',
          message: `Your ${sub.plan?.name || 'hosting'} plan expired on ${end.toDateString()}. Services stay online for ${GRACE_DAYS} days — please renew to avoid suspension.`,
          type: 'warning',
          link: '/?tab=billing',
        }).catch(() => {})
        if (sub.user?.email) {
          await sendEmail({
            to: sub.user.email,
            subject: `Your ${sub.plan?.name || 'hosting'} plan has expired`,
            html: `<p>Hi ${sub.user.name || 'there'},</p>
<p>Your <strong>${sub.plan?.name || 'hosting'}</strong> plan expired on <strong>${end.toDateString()}</strong>.</p>
<p>Your services remain online for <strong>${GRACE_DAYS} days</strong>. Please renew to avoid suspension.</p>
<p>— Apsamo Technology</p>`,
          }).catch(() => {})
        }
        pastDue.push(sub.id)
        continue
      }

      // ── 3. Past due beyond grace → suspend ──────────────────────
      if (sub.status === 'past_due' && end <= suspendBefore) {
        await db.subscription.update({
          where: { id: sub.id },
          data: { status: 'suspended' },
        })
        await createNotification({
          userId: sub.userId,
          title: 'Subscription Suspended',
          message: `Your ${sub.plan?.name || 'hosting'} plan has been suspended for non-payment. Renew to restore your services.`,
          type: 'error',
          link: '/?tab=billing',
        }).catch(() => {})
        suspended.push(sub.id)
      }
    }

    const summary = {
      scanned: subs.length,
      reminded: reminded.length,
      pastDue: pastDue.length,
      suspended: suspended.length,
      at: now.toISOString(),
    }
    if (reminded.length || pastDue.length || suspended.length) {
      console.log('[billing-sweep]', JSON.stringify(summary))
    }

    return NextResponse.json({ success: true, ...summary })
  } catch (error) {
    console.error('[billing-sweep] failed:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/** GET → dry-run summary of what the next sweep would do. */
export async function GET(request: Request) {
  try {
    if (!authorise(request)) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 403 })
    }
    const now = new Date()
    const remindBefore = new Date(
      now.getTime() + REMIND_DAYS * 24 * 60 * 60 * 1000
    )
    const suspendBefore = new Date(
      now.getTime() - GRACE_DAYS * 24 * 60 * 60 * 1000
    )
    const subs = await db.subscription.findMany({
      where: {
        status: { in: ['active', 'past_due', 'trialing'] },
        stripeSubId: null,
      },
      select: { id: true, status: true, currentPeriodEnd: true },
    })
    return NextResponse.json({
      dryRun: true,
      config: { remindDays: REMIND_DAYS, graceDays: GRACE_DAYS },
      scanned: subs.length,
      wouldRemind: subs.filter(
        (s) =>
          (s.status === 'active' || s.status === 'trialing') &&
          new Date(s.currentPeriodEnd) > now &&
          new Date(s.currentPeriodEnd) <= remindBefore
      ).length,
      wouldMarkPastDue: subs.filter(
        (s) =>
          (s.status === 'active' || s.status === 'trialing') &&
          new Date(s.currentPeriodEnd) <= now
      ).length,
      wouldSuspend: subs.filter(
        (s) =>
          s.status === 'past_due' &&
          new Date(s.currentPeriodEnd) <= suspendBefore
      ).length,
    })
  } catch (error) {
    console.error('[billing-sweep] dry-run failed:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
