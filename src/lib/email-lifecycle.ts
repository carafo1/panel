/**
 * Email service lifecycle — tying billing state to the mail server.
 *
 * `email-hosting.ts` knows HOW to suspend, resume and terminate a service.
 * Nothing was calling it: the billing sweep flipped `Subscription.status` to
 * suspended while Mailcow carried on delivering, so a customer who stopped
 * paying kept their mail indefinitely, and a cancelled service kept its
 * mailboxes and storage forever.
 *
 * This module is the join. It is deliberately driven by the subscription that
 * PAYS for a service rather than by the service itself, so email follows the
 * same dunning timeline as everything else the customer bought.
 */
import { db } from '@/lib/db'
import {
  suspendEmailService,
  resumeEmailService,
  terminateEmailService,
} from '@/lib/email-hosting'
import { createNotification } from '@/lib/notifications'
import { sendEmail } from '@/lib/email'

/**
 * How long a suspended service is kept before its mailboxes are destroyed.
 * The customer is warned at suspension and again before the deadline, and any
 * payment in between resumes the service untouched.
 */
export const RETENTION_DAYS = Number(process.env.EMAIL_RETENTION_DAYS || 30)

/** Warn this many days before data is destroyed. */
const WARN_BEFORE_DAYS = 7

export interface LifecycleResult {
  suspended: string[]
  resumed: string[]
  terminated: string[]
  warned: string[]
}

function emptyResult(): LifecycleResult {
  return { suspended: [], resumed: [], terminated: [], warned: [] }
}

/**
 * Stop mail for every service paid for by this subscription.
 *
 * Deactivates the domain in Mailcow — incoming mail is refused and logins
 * stop, but nothing is deleted, so `resumeEmailForSubscription` restores the
 * account intact.
 */
export async function suspendEmailForSubscription(
  subscriptionId: string
): Promise<string[]> {
  const services = await db.emailService.findMany({
    where: { subscriptionId, status: 'active' },
    select: { id: true, domain: true, userId: true },
  })

  const done: string[] = []
  for (const s of services) {
    const res = await suspendEmailService(s.id).catch(() => ({
      success: false,
      error: 'suspend threw',
    }))
    if (!res.success) {
      console.error(`[email-lifecycle] suspend failed for ${s.domain}:`, res.error)
      continue
    }
    done.push(s.id)

    await createNotification({
      userId: s.userId,
      title: 'Email hosting suspended',
      message: `Mail for ${s.domain} has been suspended for non-payment. Your mailboxes and messages are safe and will be restored the moment payment is confirmed — they are kept for ${RETENTION_DAYS} days.`,
      type: 'error',
      link: '/?tab=email',
    }).catch(() => {})

    const user = await db.user
      .findUnique({ where: { id: s.userId }, select: { email: true, name: true } })
      .catch(() => null)
    if (user?.email) {
      await sendEmail({
        to: user.email,
        subject: `Email for ${s.domain} has been suspended`,
        html: `<p>Hi ${user.name || 'there'},</p>
<p>Mail for <strong>${s.domain}</strong> has been suspended because the subscription is unpaid. Incoming messages are currently being refused and sign-in is disabled.</p>
<p><strong>Nothing has been deleted.</strong> Your mailboxes and all stored mail are kept for <strong>${RETENTION_DAYS} days</strong> and are restored as soon as your payment is confirmed.</p>
<p>— Apsamo Technology</p>`,
      }).catch(() => {})
    }
  }
  return done
}

/** Restore mail for every service paid for by this subscription. */
export async function resumeEmailForSubscription(
  subscriptionId: string
): Promise<string[]> {
  const services = await db.emailService.findMany({
    where: { subscriptionId, status: 'suspended' },
    select: { id: true, domain: true, userId: true },
  })

  const done: string[] = []
  for (const s of services) {
    const res = await resumeEmailService(s.id).catch(() => ({
      success: false,
      error: 'resume threw',
    }))
    if (!res.success) {
      console.error(`[email-lifecycle] resume failed for ${s.domain}:`, res.error)
      continue
    }
    done.push(s.id)
    await createNotification({
      userId: s.userId,
      title: 'Email hosting restored',
      message: `Mail for ${s.domain} is active again. Any messages sent while it was suspended were not accepted, so ask senders to retry.`,
      type: 'success',
      link: '/?tab=email',
    }).catch(() => {})
  }
  return done
}

/**
 * Destroy services that have been suspended past the retention window, and
 * warn the ones approaching it.
 *
 * This deletes mail permanently, so it is deliberately conservative: it acts
 * only on services already suspended (never on an active one), it uses
 * `suspendedAt` rather than the subscription date, and setting
 * EMAIL_RETENTION_DAYS=0 disables destruction entirely while still warning.
 */
export async function reapExpiredEmailServices(): Promise<{
  terminated: string[]
  warned: string[]
}> {
  const terminated: string[] = []
  const warned: string[] = []
  if (RETENTION_DAYS <= 0) return { terminated, warned }

  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const killBefore = new Date(now - RETENTION_DAYS * day)
  const warnBefore = new Date(now - (RETENTION_DAYS - WARN_BEFORE_DAYS) * day)

  const suspended = await db.emailService.findMany({
    where: { status: 'suspended', suspendedAt: { not: null } },
    select: { id: true, domain: true, userId: true, suspendedAt: true },
  })

  for (const s of suspended) {
    if (!s.suspendedAt) continue

    // ── Past retention → destroy ──
    if (s.suspendedAt <= killBefore) {
      const res = await terminateEmailService(s.id).catch(() => ({
        success: false,
        error: 'terminate threw',
      }))
      if (!res.success) {
        console.error(
          `[email-lifecycle] terminate failed for ${s.domain}:`,
          res.error
        )
        continue
      }
      terminated.push(s.id)
      await createNotification({
        userId: s.userId,
        title: 'Email hosting closed',
        message: `Email hosting for ${s.domain} has been closed and its mailboxes removed after ${RETENTION_DAYS} days without payment.`,
        type: 'error',
        link: '/?tab=email',
      }).catch(() => {})
      continue
    }

    // ── Approaching retention → warn once ──
    if (s.suspendedAt <= warnBefore) {
      const daysLeft = Math.max(
        1,
        Math.ceil((s.suspendedAt.getTime() + RETENTION_DAYS * day - now) / day)
      )
      const alreadyWarned = await db.notification.findFirst({
        where: {
          userId: s.userId,
          title: 'Email data will be deleted soon',
          createdAt: { gte: new Date(now - (WARN_BEFORE_DAYS + 1) * day) },
        },
      })
      if (alreadyWarned) continue

      warned.push(s.id)
      await createNotification({
        userId: s.userId,
        title: 'Email data will be deleted soon',
        message: `Mail for ${s.domain} is suspended and will be permanently deleted in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Settle the invoice to keep it.`,
        type: 'error',
        link: '/?tab=billing',
      }).catch(() => {})

      const user = await db.user
        .findUnique({ where: { id: s.userId }, select: { email: true, name: true } })
        .catch(() => null)
      if (user?.email) {
        await sendEmail({
          to: user.email,
          subject: `Action needed: mail for ${s.domain} will be deleted in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
          html: `<p>Hi ${user.name || 'there'},</p>
<p>Email hosting for <strong>${s.domain}</strong> has been suspended for non-payment. Unless the outstanding invoice is settled, all mailboxes and stored messages will be <strong>permanently deleted in ${daysLeft} day${daysLeft === 1 ? '' : 's'}</strong>.</p>
<p>Paying restores everything immediately — nothing has been lost yet.</p>
<p>— Apsamo Technology</p>`,
        }).catch(() => {})
      }
    }
  }

  return { terminated, warned }
}

/**
 * Terminate services whose subscription was cancelled outright. The customer
 * asked to stop, so the same retention window applies from cancellation.
 */
export async function terminateCancelledEmailServices(): Promise<string[]> {
  const cancelledSubs = await db.subscription.findMany({
    where: { status: 'cancelled' },
    select: { id: true },
  })
  if (cancelledSubs.length === 0) return []

  const ids = cancelledSubs.map((s) => s.id)
  const services = await db.emailService.findMany({
    where: { subscriptionId: { in: ids }, status: { in: ['active', 'suspended'] } },
    select: { id: true, status: true },
  })

  const suspendedNow: string[] = []
  for (const s of services) {
    // Suspend first so the retention clock starts and the customer keeps the
    // same "pay and it comes back" window as a non-payment suspension.
    if (s.status === 'active') {
      const res = await suspendEmailService(s.id).catch(() => ({ success: false }))
      if (res.success) suspendedNow.push(s.id)
    }
  }
  return suspendedNow
}

/** Everything the billing sweep should run for email, in one call. */
export async function runEmailLifecycle(): Promise<LifecycleResult> {
  const result = emptyResult()
  try {
    result.suspended = await terminateCancelledEmailServices()
    const reaped = await reapExpiredEmailServices()
    result.terminated = reaped.terminated
    result.warned = reaped.warned
  } catch (err) {
    console.error('[email-lifecycle] sweep failed:', err)
  }
  return result
}
