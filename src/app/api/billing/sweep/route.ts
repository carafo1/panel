import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { createNotification } from '@/lib/notifications'
import { sendEmail } from '@/lib/email'
import { runAutoRenewals, NOT_STRIPE_MANAGED } from '@/lib/renewals'
import {
  suspendEmailForSubscription,
  runEmailLifecycle,
} from '@/lib/email-lifecycle'
import { collectAllUsage } from '@/lib/usage'
import { pruneAllBackups } from '@/lib/vps/backups'
import { cleanupAllServers, reapOrphansAllServers } from '@/lib/vps/docker-maintenance'
import { recordHeartbeat } from '@/lib/health'

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
async function authorise(request: Request): Promise<boolean> {
  const cronKey = request.headers.get('x-cron-key')
  if (CRON_API_KEY && cronKey && cronKey === CRON_API_KEY) return true

  const token = extractTokenFromHeader(request.headers.get('Authorization'))
  if (!token) return false
  const decoded = await verifyTokenFresh(token)
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
    if (!await authorise(request)) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 403 })
    }

    const now = new Date()
    const remindBefore = new Date(
      now.getTime() + REMIND_DAYS * 24 * 60 * 60 * 1000
    )
    const suspendBefore = new Date(
      now.getTime() - GRACE_DAYS * 24 * 60 * 60 * 1000
    )

    // ── 0. Auto-renew FIRST ──────────────────────────────────────────
    // Must run before the expiry pass, otherwise a subscription that is due
    // to renew would be marked past_due in the same sweep.
    const renewals = await runAutoRenewals().catch((err) => {
      console.error('[billing-sweep] auto-renewals failed:', err)
      return { renewed: 0, failed: 0, skipped: 0 }
    })

    // Capture a usage snapshot for every active customer. Piggy-backing on
    // the hourly sweep avoids adding another scheduler.
    const usage = await collectAllUsage().catch((err) => {
      console.error('[billing-sweep] usage collection failed:', err)
      return { captured: 0, failed: 0, alerted: 0 }
    })

    // Apply each plan's backup retention. backupRetentionDays (7/14/30) and
    // maxBackups were stored on every plan and read by nothing, so archives
    // accumulated forever and the host's disk grew without bound. Runs on the
    // same hourly sweep rather than adding another scheduler.
    const backupPrune = await pruneAllBackups().catch((err) => {
      console.error('[billing-sweep] backup pruning failed:', err)
      return { projects: 0, deleted: 0 }
    })

    // Reclaim Docker garbage. Nothing ever did: measured on the live host,
    // 1.5 GB of dangling images plus 297 MB of build cache with no process
    // that would ever remove them. Conservative — see lib/vps/docker-maintenance.
    const dockerCleanup = await cleanupAllServers().catch((err) => {
      console.error('[billing-sweep] docker cleanup failed:', err)
      return { servers: 0, reclaimedBytes: 0, orphanVolumes: 0 }
    })

    // Docker's own pruning cannot see these: a deleted project's database
    // container is running and its image is tagged, so neither looks like
    // garbage. Left alone they simply accumulate — 172 MB of database and
    // 301 MB of images had been sitting here for weeks.
    const orphanReap = await reapOrphansAllServers().catch((err) => {
      console.error('[billing-sweep] orphan reap failed:', err)
      return { servers: 0, containers: 0, images: 0, refused: 0 }
    })

    const reminded: string[] = []
    const pastDue: string[] = []
    const suspended: string[] = []
    const emailSuspended: string[] = []

    // Only non-Stripe subscriptions — Stripe drives its own lifecycle.
    const subs = await db.subscription.findMany({
      where: {
        status: { in: ['active', 'past_due', 'trialing'] },
        ...NOT_STRIPE_MANAGED,
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

        // Marking the subscription suspended does nothing to the mail server
        // on its own — without this the customer keeps sending and receiving
        // mail indefinitely after they stop paying.
        const stopped = await suspendEmailForSubscription(sub.id).catch(
          (err) => {
            console.error('[billing-sweep] email suspend failed:', err)
            return [] as string[]
          }
        )
        emailSuspended.push(...stopped)
      }
    }

    // ── 4. Email retention ──────────────────────────────────────────
    // Suspended past the retention window → mailboxes destroyed; cancelled
    // subscriptions → suspended so the same window applies from cancellation.
    const emailLifecycle = await runEmailLifecycle()

    const summary = {
      scanned: subs.length,
      renewed: renewals.renewed,
      renewalFailures: renewals.failed,
      usageCaptured: usage.captured,
      overLimitAlerts: usage.alerted,
      backupsPruned: backupPrune.deleted,
      dockerReclaimedMB: Math.round(dockerCleanup.reclaimedBytes / 1024 ** 2),
      orphanVolumes: dockerCleanup.orphanVolumes,
      reminded: reminded.length,
      pastDue: pastDue.length,
      suspended: suspended.length,
      emailSuspended: emailSuspended.length,
      emailWarned: emailLifecycle.warned.length,
      emailTerminated: emailLifecycle.terminated.length,
      at: now.toISOString(),
    }
    if (
      renewals.renewed ||
      renewals.failed ||
      reminded.length ||
      pastDue.length ||
      suspended.length ||
      emailSuspended.length ||
      emailLifecycle.warned.length ||
      emailLifecycle.terminated.length
    ) {
      console.log('[billing-sweep]', JSON.stringify(summary))
    }

    // Liveness beacon. This sweep silently never ran for weeks — first
    // because it filtered out every subscription, then because the worker
    // could not reach the panel at all. Recording each completion makes
    // "renewals have not run since Tuesday" an answerable question.
    await recordHeartbeat(
      'billing',
      `scanned=${subs.length} renewed=${renewals.renewed} usage=${usage.captured}`
    )

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
    if (!await authorise(request)) {
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
        ...NOT_STRIPE_MANAGED,
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
