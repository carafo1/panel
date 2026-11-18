/**
 * Invoice generation for subscriptions.
 *
 * Invoices previously only existed for domain orders, so hosting customers —
 * especially the ones paying by bank transfer — had nothing to pay against and
 * no record afterwards. This raises a proper invoice per billing period and
 * settles it when the payment is confirmed.
 */
import { db } from '@/lib/db'
import { validateCoupon, redeemCoupon } from '@/lib/coupons'
import { calculateTax } from '@/lib/tax'
import {
  notifyInvoiceCreated,
  notifyPaymentReceived,
} from '@/lib/billing-notifications'

function round2(n: number) {
  return Math.round(n * 100) / 100
}

export interface InvoiceLineItem {
  description: string
  quantity: number
  unitPrice: number
  total: number
}

/** How many days one billing cycle covers. "lifetime" never renews. */
export function cycleDays(billingCycle: string): number | null {
  switch ((billingCycle || 'monthly').toLowerCase()) {
    case 'monthly':
      return 30
    case 'quarterly':
      return 91
    case 'annual':
      return 365
    case 'biennial':
      return 730
    case 'lifetime':
      return null
    default:
      return 30
  }
}

/**
 * Sequential, collision-safe invoice number: INV-<year>-<0001>.
 *
 * The previous helper used Math.random() over 90k values on a @unique column —
 * by the birthday bound that collides with ~50% probability after only ~350
 * invoices. This derives the next number from the highest existing one for the
 * year and retries on the unique constraint.
 */
export async function nextInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `INV-${year}-`
  const last = await db.invoice.findFirst({
    where: { number: { startsWith: prefix } },
    orderBy: { number: 'desc' },
    select: { number: true },
  })
  let seq = 1
  if (last?.number) {
    const parsed = parseInt(last.number.slice(prefix.length), 10)
    if (Number.isFinite(parsed)) seq = parsed + 1
  }
  return `${prefix}${String(seq).padStart(4, '0')}`
}

export interface CreateSubscriptionInvoiceOptions {
  userId: string
  subscriptionId?: string | null
  planId?: string | null
  planName?: string
  amount: number
  currency?: string
  periodStart?: Date | null
  periodEnd?: Date | null
  /** Days until due (default 7). */
  dueInDays?: number
  description?: string
  notes?: string | null
  /** Create it already settled (e.g. payment confirmed at the same moment). */
  paid?: boolean
  /** Optional coupon code to apply to this invoice. */
  couponCode?: string | null
  /** Skip tax (e.g. internal adjustments). */
  skipTax?: boolean
  /**
   * Suppress the "new invoice" notification. Used by callers that send their
   * own message about the same event (e.g. a plan change) so the customer
   * doesn't get two notifications for one action.
   */
  notify?: boolean
}

/**
 * Raise an invoice for a subscription period. Returns the created invoice, or
 * the existing one if this period has already been invoiced (idempotent, so a
 * retried renewal can't double-bill).
 */
export async function createSubscriptionInvoice(
  opts: CreateSubscriptionInvoiceOptions
) {
  const currency = (opts.currency || 'USD').toUpperCase()
  const amount = Math.round(Number(opts.amount || 0) * 100) / 100

  // Idempotency: one invoice per (subscription, periodStart).
  if (opts.subscriptionId && opts.periodStart) {
    const existing = await db.invoice.findFirst({
      where: {
        subscriptionId: opts.subscriptionId,
        periodStart: opts.periodStart,
      },
    })
    if (existing) return existing
  }

  const label =
    opts.description ||
    `${opts.planName || 'Hosting plan'}${
      opts.periodStart && opts.periodEnd
        ? ` — ${opts.periodStart.toDateString()} to ${opts.periodEnd.toDateString()}`
        : ''
    }`

  const items: InvoiceLineItem[] = [
    { description: label, quantity: 1, unitPrice: amount, total: amount },
  ]

  const dueDate = new Date(
    Date.now() + (opts.dueInDays ?? 7) * 24 * 60 * 60 * 1000
  )

  // ── Coupon ────────────────────────────────────────────────────────
  let discount = 0
  let couponId: string | null = null
  let couponCode: string | null = null
  if (opts.couponCode) {
    const check = await validateCoupon({
      code: opts.couponCode,
      userId: opts.userId,
      subtotal: amount,
      planId: opts.planId,
    })
    if (check.valid && check.discount) {
      discount = check.discount
      couponId = check.couponId || null
      couponCode = check.code || null
    }
  }

  // ── Tax (charged on the discounted base) ──────────────────────────
  const taxable = Math.max(0, round2(amount - discount))
  const taxResult = opts.skipTax
    ? { total: 0, label: null }
    : await calculateTax({ base: taxable, userId: opts.userId })

  const total = round2(taxable + taxResult.total)

  // Retry once on a unique-number race.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const created = await db.invoice.create({
        data: {
          number: await nextInvoiceNumber(),
          userId: opts.userId,
          subscriptionId: opts.subscriptionId || null,
          planId: opts.planId || null,
          periodStart: opts.periodStart || null,
          periodEnd: opts.periodEnd || null,
          notes: opts.notes || null,
          items: JSON.stringify(items),
          subtotal: amount,
          discount,
          couponId,
          couponCode,
          tax: taxResult.total,
          taxName: taxResult.label,
          total,
          currency,
          status: opts.paid ? 'paid' : 'unpaid',
          paidAt: opts.paid ? new Date() : null,
          dueDate,
        },
      })

      // Only count the redemption once the invoice actually exists.
      if (couponId) {
        await redeemCoupon({
          couponId,
          userId: opts.userId,
          invoiceId: created.id,
          amount: discount,
        }).catch(() => {
          /* discount already applied — don't fail the invoice over the counter */
        })
      }

      // Tell the customer an invoice is waiting. Already-paid invoices (e.g.
      // raised and settled in the same checkout) don't need a "please pay"
      // message — the payment-received notification covers those.
      if (!opts.paid && opts.notify !== false) {
        await notifyInvoiceCreated({
          userId: opts.userId,
          invoiceNumber: created.number,
          total: created.total,
          currency: created.currency,
          dueDate: created.dueDate,
          description: items[0]?.description,
        }).catch(() => {})
      }

      return created
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (attempt === 2 || !/unique/i.test(msg)) throw err
    }
  }
  throw new Error('Could not allocate an invoice number')
}

/**
 * Settle an invoice and record the money against it.
 * Idempotent — re-marking a paid invoice is a no-op.
 */
export async function markInvoicePaid(
  invoiceId: string,
  opts: {
    gateway: string
    reference?: string | null
    amount?: number
    userId?: string
  }
) {
  const invoice = await db.invoice.findUnique({ where: { id: invoiceId } })
  if (!invoice) return null
  if (invoice.status === 'paid') return invoice

  // What is still owed. `amountPaid` may already hold earlier partial
  // payments, so the balance is total − credit − already received.
  const alreadyPaid = round2(invoice.amountPaid || 0)
  const outstanding = Math.max(
    0,
    round2(invoice.total - (invoice.creditApplied || 0) - alreadyPaid)
  )

  // A payment smaller than the balance is a PARTIAL payment. It used to mark
  // the invoice fully paid regardless of the amount received; record it as
  // partial instead (lazy import: refunds.ts imports this module).
  if (
    typeof opts.amount === 'number' &&
    Number.isFinite(opts.amount) &&
    opts.amount > 0 &&
    opts.amount < outstanding - 0.009
  ) {
    const { recordInvoicePayment } = await import('@/lib/refunds')
    const partial = await recordInvoicePayment({
      invoiceId,
      amount: opts.amount,
      gateway: opts.gateway,
      reference: opts.reference || null,
      userId: opts.userId || invoice.userId,
    })
    if (!partial.success) {
      console.error('[invoices] partial payment not recorded for', invoiceId, partial.error)
    }
    return db.invoice.findUnique({ where: { id: invoiceId } })
  }

  // Record the money against the invoice too, not just the status — refunds
  // and partial-payment tracking read `amountPaid`, so leaving it at 0 would
  // make a paid invoice look like nothing was ever received.
  const settled = outstanding

  // Atomic flip: only the caller whose update still sees the invoice as it was
  // read settles it. A concurrent webhook + browser return used to both pass
  // the status check above and write two ledger rows / two notifications.
  const flipped = await db.invoice.updateMany({
    where: {
      id: invoiceId,
      status: invoice.status,
      amountPaid: invoice.amountPaid,
    },
    data: {
      status: 'paid',
      paidAt: new Date(),
      amountPaid: round2(alreadyPaid + settled),
    },
  })
  if (flipped.count !== 1) {
    return db.invoice.findUnique({ where: { id: invoiceId } })
  }
  const updated = (await db.invoice.findUnique({ where: { id: invoiceId } }))!

  await db.transaction
    .create({
      data: {
        invoiceId,
        userId: opts.userId || invoice.userId,
        gateway: opts.gateway,
        amount: opts.amount ?? settled,
        currency: invoice.currency,
        status: 'completed',
        reference: opts.reference || null,
      },
    })
    .catch(() => {
      /* the invoice is settled either way — don't fail on the ledger row */
    })

  await notifyPaymentReceived({
    userId: invoice.userId,
    invoiceNumber: invoice.number,
    amount: opts.amount ?? Math.max(0, settled),
    currency: invoice.currency,
    balanceDue: 0,
    method: opts.gateway,
  }).catch(() => {})

  // A first real payment is what rewards whoever referred this customer.
  if (opts.gateway !== 'credit' && settled > 0) {
    const { qualifyReferral } = await import('@/lib/referrals')
    await qualifyReferral(invoice.userId, settled).catch((err) => console.error('[referrals] qualify failed:', err))
  }

  // A paid renewal invoice is what brings a past-due or suspended
  // subscription back. Imported lazily: enforcement pulls in the server and
  // mail layers, which must not load whenever an invoice is touched.
  const { onInvoiceSettled } = await import('@/lib/billing-enforcement')
  await onInvoiceSettled(invoiceId)

  return updated
}

/** Invoice statuses that still expect money. */
export const OPEN_INVOICE_STATUSES = ['unpaid', 'partially_paid']

/**
 * Find the invoice a payment should settle.
 *
 *   1. the invoice explicitly linked to the payment at checkout
 *      (`Payment.invoiceId`, or `invoiceId` in its metadata), when it belongs
 *      to the same user;
 *   2. otherwise the oldest open invoice of the payment's OWN subscription.
 *
 * There is deliberately no user-wide fallback any more: "the newest unpaid
 * invoice for this user" settled whatever bill happened to be latest — another
 * subscription's renewal, say — with money paid for something else.
 */
export async function findInvoiceForPayment(payment: {
  userId: string
  subscriptionId?: string | null
  invoiceId?: string | null
}) {
  if (payment.invoiceId) {
    const linked = await db.invoice.findUnique({ where: { id: payment.invoiceId } })
    if (linked && linked.userId === payment.userId) return linked
    return null
  }
  if (payment.subscriptionId) {
    return db.invoice.findFirst({
      where: {
        subscriptionId: payment.subscriptionId,
        userId: payment.userId,
        status: { in: OPEN_INVOICE_STATUSES },
        type: 'standard',
      },
      orderBy: { createdAt: 'asc' },
    })
  }
  return null
}
