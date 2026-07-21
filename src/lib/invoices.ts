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

  const updated = await db.invoice.update({
    where: { id: invoiceId },
    data: { status: 'paid', paidAt: new Date() },
  })

  await db.transaction
    .create({
      data: {
        invoiceId,
        userId: opts.userId || invoice.userId,
        gateway: opts.gateway,
        amount: opts.amount ?? invoice.total,
        currency: invoice.currency,
        status: 'completed',
        reference: opts.reference || null,
      },
    })
    .catch(() => {
      /* the invoice is settled either way — don't fail on the ledger row */
    })

  return updated
}

/**
 * Find the invoice a payment should settle: the newest unpaid invoice for the
 * payment's subscription, else the newest unpaid one for the user.
 */
export async function findInvoiceForPayment(payment: {
  userId: string
  subscriptionId?: string | null
}) {
  if (payment.subscriptionId) {
    const bySub = await db.invoice.findFirst({
      where: { subscriptionId: payment.subscriptionId, status: 'unpaid' },
      orderBy: { createdAt: 'desc' },
    })
    if (bySub) return bySub
  }
  return db.invoice.findFirst({
    where: { userId: payment.userId, status: 'unpaid', subscriptionId: { not: null } },
    orderBy: { createdAt: 'desc' },
  })
}
