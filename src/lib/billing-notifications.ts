/**
 * Billing notification events.
 *
 * Every money event a customer should hear about, in one place. Previously
 * notifications were written ad-hoc at a handful of call sites, so most
 * billing events (invoice raised, payment received, payment failed, refund
 * issued, credit added, plan changed, over-limit) silently produced nothing —
 * the customer's first sign of trouble was a suspended service.
 *
 * Design rules:
 *  - Every function is best-effort: a mail or DB failure NEVER breaks the
 *    billing operation that triggered it. Callers use `.catch(() => {})` and
 *    these helpers swallow internally too.
 *  - In-app notification always; email only for events worth an inbox
 *    interruption (money taken, money failed, money returned, suspension).
 *  - Copy states facts we can prove from the row — no invented dates or
 *    promises about when a gateway refund will land.
 */
import { db } from '@/lib/db'
import { sendEmail } from '@/lib/email'
import { createNotification } from '@/lib/notifications'
import { FROM_NAME, BILLING_EMAIL } from '@/lib/brand-config'

type NotifyType = 'info' | 'success' | 'warning' | 'error'

const BILLING_LINK = '/?tab=billing'

function money(amount: number, currency = 'USD'): string {
  const c = (currency || 'USD').toUpperCase()
  const n = Math.round((amount + Number.EPSILON) * 100) / 100
  return c === 'USD' ? `$${n.toFixed(2)}` : `${n.toFixed(2)} ${c}`
}

/** Shared HTML shell so every billing email looks like it came from us. */
function shell(greetingName: string | null, bodyHtml: string): string {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#1f2430;line-height:1.6">
<p>Hi ${greetingName || 'there'},</p>
${bodyHtml}
<p style="margin-top:24px;color:#6b7280;font-size:13px">
Questions about this? Reply to this email or contact <a href="mailto:${BILLING_EMAIL}">${BILLING_EMAIL}</a>.<br/>
— ${FROM_NAME}
</p>
</div>`
}

async function loadUser(userId: string) {
  return db.user
    .findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true },
    })
    .catch(() => null)
}

/**
 * Deliver one event. `email` is optional — when omitted only the in-app
 * notification is written.
 */
async function deliver(opts: {
  userId: string
  title: string
  message: string
  type?: NotifyType
  link?: string
  email?: { subject: string; body: string }
}): Promise<void> {
  try {
    await createNotification({
      userId: opts.userId,
      title: opts.title,
      message: opts.message,
      type: opts.type || 'info',
      link: opts.link || BILLING_LINK,
    })
  } catch (err) {
    console.error('[billing-notify] in-app failed:', err)
  }

  if (!opts.email) return
  try {
    const user = await loadUser(opts.userId)
    if (!user?.email) return
    await sendEmail({
      to: user.email,
      subject: opts.email.subject,
      html: shell(user.name, opts.email.body),
    })
  } catch (err) {
    console.error('[billing-notify] email failed:', err)
  }
}

/* ────────────────────────────────────────────────────────────────────
 * Invoice events
 * ──────────────────────────────────────────────────────────────────── */

/** A new invoice has been raised and is awaiting payment. */
export async function notifyInvoiceCreated(opts: {
  userId: string
  invoiceNumber: string
  total: number
  currency?: string
  dueDate?: Date | null
  description?: string
}): Promise<void> {
  const amount = money(opts.total, opts.currency)
  const due = opts.dueDate
    ? ` It is due by ${new Date(opts.dueDate).toDateString()}.`
    : ''
  await deliver({
    userId: opts.userId,
    title: 'New Invoice',
    message: `Invoice ${opts.invoiceNumber} for ${amount} has been raised.${due}`,
    type: 'info',
    email: {
      subject: `Invoice ${opts.invoiceNumber} — ${amount} due`,
      body: `<p>We've raised invoice <strong>${opts.invoiceNumber}</strong> for <strong>${amount}</strong>.${due}</p>
${opts.description ? `<p>${opts.description}</p>` : ''}
<p>You can view and pay it from the Billing tab of your dashboard.</p>`,
    },
  })
}

/**
 * Money received against an invoice. Handles the partial case honestly —
 * telling someone "paid in full" when a balance remains causes support load.
 */
export async function notifyPaymentReceived(opts: {
  userId: string
  invoiceNumber: string
  amount: number
  currency?: string
  balanceDue?: number
  method?: string
}): Promise<void> {
  const paid = money(opts.amount, opts.currency)
  const partial = (opts.balanceDue ?? 0) > 0.009
  const remaining = partial ? money(opts.balanceDue!, opts.currency) : null

  await deliver({
    userId: opts.userId,
    title: partial ? 'Partial Payment Received' : 'Payment Received',
    message: partial
      ? `We received ${paid} toward invoice ${opts.invoiceNumber}. ${remaining} is still outstanding.`
      : `Thank you — invoice ${opts.invoiceNumber} is paid in full (${paid}).`,
    type: partial ? 'info' : 'success',
    email: {
      subject: partial
        ? `Part payment received for invoice ${opts.invoiceNumber}`
        : `Payment received — invoice ${opts.invoiceNumber}`,
      body: partial
        ? `<p>We've received <strong>${paid}</strong> toward invoice <strong>${opts.invoiceNumber}</strong>${opts.method ? ` via ${opts.method}` : ''}.</p>
<p><strong>${remaining}</strong> remains outstanding on this invoice.</p>`
        : `<p>We've received your payment of <strong>${paid}</strong>${opts.method ? ` via ${opts.method}` : ''}. Invoice <strong>${opts.invoiceNumber}</strong> is now settled in full.</p>
<p>Thank you.</p>`,
    },
  })
}

/**
 * A payment attempt failed. This is the single most important billing email —
 * without it a customer's first signal is their site going offline.
 */
export async function notifyPaymentFailed(opts: {
  userId: string
  amount: number
  currency?: string
  method?: string
  reason?: string | null
  invoiceNumber?: string | null
}): Promise<void> {
  const amount = money(opts.amount, opts.currency)
  const forInvoice = opts.invoiceNumber ? ` for invoice ${opts.invoiceNumber}` : ''
  await deliver({
    userId: opts.userId,
    title: 'Payment Failed',
    message: `A payment of ${amount}${forInvoice} could not be processed${opts.reason ? `: ${opts.reason}` : ''}. Please try again to keep your services running.`,
    type: 'error',
    email: {
      subject: `Action needed — payment of ${amount} failed`,
      body: `<p>We were unable to process a payment of <strong>${amount}</strong>${forInvoice}${opts.method ? ` via ${opts.method}` : ''}.</p>
${opts.reason ? `<p>Reason given: <em>${opts.reason}</em></p>` : ''}
<p>Please retry the payment from the Billing tab so your services stay online. If the problem continues, contact us and we'll help.</p>`,
    },
  })
}

/**
 * A refund was issued. `settled` distinguishes wallet credit (instant, we
 * control it) from a gateway refund (recorded here, actually moved by the
 * provider) — promising an instant bank refund we can't perform is a lie.
 */
export async function notifyRefundIssued(opts: {
  userId: string
  invoiceNumber: string
  amount: number
  currency?: string
  destination: string
  settled: boolean
  reason?: string | null
}): Promise<void> {
  const amount = money(opts.amount, opts.currency)
  const where =
    opts.destination === 'wallet'
      ? 'your account credit balance'
      : `your original payment method (${opts.destination})`

  await deliver({
    userId: opts.userId,
    title: 'Refund Issued',
    message: opts.settled
      ? `${amount} from invoice ${opts.invoiceNumber} has been added to your account credit.`
      : `A refund of ${amount} for invoice ${opts.invoiceNumber} has been approved and is being returned to ${where}.`,
    type: 'success',
    email: {
      subject: `Refund issued — ${amount} (invoice ${opts.invoiceNumber})`,
      body: `<p>We've issued a refund of <strong>${amount}</strong> against invoice <strong>${opts.invoiceNumber}</strong>.</p>
${opts.reason ? `<p>Reason: <em>${opts.reason}</em></p>` : ''}
<p>${
        opts.settled
          ? `This has been credited to <strong>${where}</strong> and is available to use immediately.`
          : `This is being returned to <strong>${where}</strong>. Depending on your bank or provider it can take several business days to appear.`
      }</p>
<p>A credit note has been added to your invoice history for your records.</p>`,
    },
  })
}

/* ────────────────────────────────────────────────────────────────────
 * Account credit
 * ──────────────────────────────────────────────────────────────────── */

/** Wallet credit added or deducted by an admin or an automated process. */
export async function notifyCreditAdjusted(opts: {
  userId: string
  amount: number // signed: positive = added
  balance: number
  currency?: string
  reason?: string | null
}): Promise<void> {
  const added = opts.amount >= 0
  const amount = money(Math.abs(opts.amount), opts.currency)
  const balance = money(opts.balance, opts.currency)
  await deliver({
    userId: opts.userId,
    title: added ? 'Account Credit Added' : 'Account Credit Adjusted',
    message: `${added ? `${amount} has been added to` : `${amount} has been deducted from`} your account credit. New balance: ${balance}.`,
    type: added ? 'success' : 'info',
    email: added
      ? {
          subject: `${amount} credit added to your account`,
          body: `<p><strong>${amount}</strong> has been added to your account credit${opts.reason ? ` (${opts.reason})` : ''}.</p>
<p>Your balance is now <strong>${balance}</strong>. Credit is applied automatically to your next invoice.</p>`,
        }
      : undefined,
  })
}

/* ────────────────────────────────────────────────────────────────────
 * Subscription lifecycle
 * ──────────────────────────────────────────────────────────────────── */

/** Renewal succeeded — period rolled forward. */
export async function notifySubscriptionRenewed(opts: {
  userId: string
  planName: string
  periodEnd: Date
  invoiceNumber?: string | null
  amount?: number
  currency?: string
  paidFromCredit?: boolean
}): Promise<void> {
  const until = new Date(opts.periodEnd).toDateString()
  const amount =
    opts.amount != null ? money(opts.amount, opts.currency) : null
  await deliver({
    userId: opts.userId,
    title: 'Subscription Renewed',
    message: opts.paidFromCredit
      ? `Your ${opts.planName} plan renewed until ${until}, paid from your account credit.`
      : `Your ${opts.planName} plan has been renewed until ${until}.`,
    type: 'success',
    email: {
      subject: `Your ${opts.planName} plan has been renewed`,
      body: `<p>Your <strong>${opts.planName}</strong> plan has been renewed and is active until <strong>${until}</strong>.</p>
${
  opts.invoiceNumber
    ? `<p>Invoice <strong>${opts.invoiceNumber}</strong>${amount ? ` for <strong>${amount}</strong>` : ''} ${
        opts.paidFromCredit
          ? 'was settled automatically from your account credit.'
          : 'has been raised for this period.'
      }</p>`
    : ''
}`,
    },
  })
}

/** Renewal failed — the customer must act before the grace period ends. */
export async function notifyRenewalFailed(opts: {
  userId: string
  planName: string
  reason?: string | null
}): Promise<void> {
  await deliver({
    userId: opts.userId,
    title: 'Renewal Failed',
    message: `We couldn't renew your ${opts.planName} plan automatically${opts.reason ? `: ${opts.reason}` : ''}. Please renew manually to avoid interruption.`,
    type: 'error',
    email: {
      subject: `Action needed — couldn't renew your ${opts.planName} plan`,
      body: `<p>We tried to renew your <strong>${opts.planName}</strong> plan automatically but the renewal did not go through${opts.reason ? ` (<em>${opts.reason}</em>)` : ''}.</p>
<p>Please renew from the Billing tab so your services aren't interrupted.</p>`,
    },
  })
}

/** Plan upgraded or downgraded. */
export async function notifyPlanChanged(opts: {
  userId: string
  fromPlan: string
  toPlan: string
  direction: 'upgrade' | 'downgrade' | 'change'
  prorationAmount?: number
  currency?: string
  invoiceNumber?: string | null
}): Promise<void> {
  const verb =
    opts.direction === 'upgrade'
      ? 'upgraded'
      : opts.direction === 'downgrade'
        ? 'downgraded'
        : 'changed'
  const charge =
    opts.prorationAmount && opts.prorationAmount > 0
      ? money(opts.prorationAmount, opts.currency)
      : null
  const creditBack =
    opts.prorationAmount && opts.prorationAmount < 0
      ? money(Math.abs(opts.prorationAmount), opts.currency)
      : null

  await deliver({
    userId: opts.userId,
    title: `Plan ${verb.charAt(0).toUpperCase()}${verb.slice(1)}`,
    message: `Your plan has been ${verb} from ${opts.fromPlan} to ${opts.toPlan}.${
      charge ? ` A pro-rated charge of ${charge} applies.` : ''
    }${creditBack ? ` ${creditBack} has been credited to your account.` : ''}`,
    type: 'success',
    email: {
      subject: `Your plan has been ${verb} to ${opts.toPlan}`,
      body: `<p>Your subscription has been ${verb} from <strong>${opts.fromPlan}</strong> to <strong>${opts.toPlan}</strong>.</p>
${charge ? `<p>A pro-rated amount of <strong>${charge}</strong> covers the remainder of your current billing period${opts.invoiceNumber ? ` (invoice <strong>${opts.invoiceNumber}</strong>)` : ''}.</p>` : ''}
${creditBack ? `<p><strong>${creditBack}</strong> has been credited to your account for the unused portion of your previous plan.</p>` : ''}`,
    },
  })
}

/* ────────────────────────────────────────────────────────────────────
 * Usage
 * ──────────────────────────────────────────────────────────────────── */

/**
 * One or more plan limits exceeded. Deduplicated by the caller — this fires
 * from an hourly sweep and nobody wants 24 identical emails a day.
 */
export async function notifyUsageOverLimit(opts: {
  userId: string
  planName: string | null
  breaches: Array<{ label: string; used: number; limit: number }>
}): Promise<void> {
  if (!opts.breaches.length) return
  const list = opts.breaches
    .map((b) => `${b.label}: ${b.used} of ${b.limit}`)
    .join(', ')
  const rows = opts.breaches
    .map(
      (b) =>
        `<li><strong>${b.label}</strong> — using ${b.used}, plan allows ${b.limit}</li>`
    )
    .join('')

  await deliver({
    userId: opts.userId,
    title: 'Plan Limit Exceeded',
    message: `You're over your ${opts.planName || 'plan'} limits — ${list}. Consider upgrading to avoid restrictions.`,
    type: 'warning',
    email: {
      subject: `You've exceeded your ${opts.planName || 'plan'} limits`,
      body: `<p>Your account is currently over the limits included in your <strong>${opts.planName || 'current'}</strong> plan:</p>
<ul>${rows}</ul>
<p>Nothing has been switched off. To keep things running comfortably you can upgrade your plan from the Billing tab, or reduce usage back under the limit.</p>`,
    },
  })
}

/* ────────────────────────────────────────────────────────────────────
 * Account status
 * ──────────────────────────────────────────────────────────────────── */

/** Account suspended, closed or flagged. Always emailed. */
export async function notifyAccountStatusChanged(opts: {
  userId: string
  status: string
  reason?: string | null
}): Promise<void> {
  const copy: Record<string, { title: string; message: string; body: string }> = {
    suspended: {
      title: 'Account Suspended',
      message:
        'Your account has been suspended. Sign-in is disabled until it is restored.',
      body: `<p>Your account has been <strong>suspended</strong> and you will not be able to sign in until it is restored.</p>`,
    },
    fraud: {
      title: 'Account Under Review',
      message:
        'Your account has been flagged for review and access is temporarily disabled.',
      body: `<p>Your account has been flagged for a security review and access is temporarily disabled while we look into it.</p>`,
    },
    closed: {
      title: 'Account Closed',
      message: 'Your account has been closed.',
      body: `<p>Your account has been <strong>closed</strong>.</p>`,
    },
    active: {
      title: 'Account Restored',
      message: 'Your account has been restored — you can sign in again.',
      body: `<p>Good news — your account has been <strong>restored</strong> and you can sign in again.</p>`,
    },
  }
  const c = copy[opts.status]
  if (!c) return

  await deliver({
    userId: opts.userId,
    title: c.title,
    message: c.message,
    type: opts.status === 'active' ? 'success' : 'error',
    link: '/',
    email: {
      subject: c.title,
      body: `${c.body}${opts.reason ? `<p>Reason: <em>${opts.reason}</em></p>` : ''}
<p>If you believe this is a mistake, reply to this email and we'll review it.</p>`,
    },
  })
}
