/**
 * Refunds and partial payments.
 *
 * Two capabilities the billing engine was missing:
 *
 *  1. PARTIAL PAYMENTS — an invoice can now receive several payments. We track
 *     `amountPaid` and only mark it `paid` once the balance is cleared;
 *     in between it sits at `partially_paid` instead of pretending to be unpaid.
 *
 *  2. REFUNDS — full or partial, against a paid (or partially paid) invoice.
 *     Money goes back to the customer's WALLET by default, which we can
 *     actually do instantly and verifiably. A `gateway` refund is *recorded*
 *     only: we never claim to have moved money at a PSP whose credentials we
 *     don't hold — the admin performs that in the gateway dashboard and this
 *     keeps the books straight.
 */
import { db } from '@/lib/db'
import { moveCredit, CreditError } from '@/lib/credit'
import {
  notifyPaymentReceived,
  notifyRefundIssued,
} from '@/lib/billing-notifications'
import { nextInvoiceNumber } from '@/lib/invoices'

function round2(n: number) {
  return Math.round(n * 100) / 100
}

export interface PaymentResult {
  success: boolean
  error?: string
  amountPaid?: number
  balanceDue?: number
  status?: string
  fullySettled?: boolean
}

/**
 * Record money received against an invoice. Handles partial payments and is
 * safe to call repeatedly; over-payment is rejected rather than silently
 * creating a negative balance.
 */
export async function recordInvoicePayment(opts: {
  invoiceId: string
  amount: number
  gateway: string
  reference?: string | null
  userId?: string | null
  note?: string | null
}): Promise<PaymentResult> {
  const invoice = await db.invoice.findUnique({ where: { id: opts.invoiceId } })
  if (!invoice) return { success: false, error: 'Invoice not found' }
  if (invoice.status === 'void' || invoice.status === 'cancelled') {
    return { success: false, error: `Cannot pay a ${invoice.status} invoice` }
  }

  const amount = round2(Number(opts.amount || 0))
  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, error: 'Amount must be greater than 0' }
  }

  const alreadyPaid = round2(invoice.amountPaid || 0)
  const due = round2(invoice.total - invoice.creditApplied - alreadyPaid)
  if (due <= 0) {
    return { success: false, error: 'Invoice is already settled' }
  }
  if (amount > due + 0.009) {
    return {
      success: false,
      error: `Amount exceeds the ${due.toFixed(2)} still due. Record ${due.toFixed(2)} or less.`,
    }
  }

  const newPaid = round2(alreadyPaid + amount)
  const remaining = round2(invoice.total - invoice.creditApplied - newPaid)
  const fullySettled = remaining <= 0.009

  // Conditional on the amount we read: two payments recorded at the same
  // moment must not both compute from the same `amountPaid` and lose one.
  const written = await db.invoice.updateMany({
    where: { id: invoice.id, amountPaid: invoice.amountPaid, status: invoice.status },
    data: {
      amountPaid: newPaid,
      status: fullySettled ? 'paid' : 'partially_paid',
      ...(fullySettled ? { paidAt: new Date() } : {}),
    },
  })
  if (written.count !== 1) {
    return {
      success: false,
      error: 'The invoice changed while recording this payment. Please retry.',
    }
  }

  // Ledger row so the money is traceable.
  await db.transaction
    .create({
      data: {
        invoiceId: invoice.id,
        userId: opts.userId || invoice.userId,
        gateway: opts.gateway,
        amount,
        currency: invoice.currency,
        status: 'completed',
        reference: opts.reference || null,
        metadata: opts.note ? JSON.stringify({ note: opts.note }) : null,
      },
    })
    .catch(() => {
      /* invoice is updated either way — don't fail on the ledger row */
    })

  await notifyPaymentReceived({
    userId: invoice.userId,
    invoiceNumber: invoice.number,
    amount,
    currency: invoice.currency,
    balanceDue: Math.max(0, remaining),
    method: opts.gateway,
  }).catch(() => {})

  // The final instalment settles the invoice, which is what brings a past-due
  // or suspended subscription back (same hook markInvoicePaid runs).
  if (fullySettled) {
    const { onInvoiceSettled } = await import('@/lib/billing-enforcement')
    await onInvoiceSettled(invoice.id)
  }

  return {
    success: true,
    amountPaid: newPaid,
    balanceDue: Math.max(0, remaining),
    status: fullySettled ? 'paid' : 'partially_paid',
    fullySettled,
  }
}

export interface RefundResult {
  success: boolean
  error?: string
  refundId?: string
  amount?: number
  destination?: string
  creditNoteNumber?: string
  newBalance?: number
}

/**
 * Refund an invoice, fully or partially.
 *
 * Always issues a credit note (a `credit_note` invoice pointing back at the
 * original) so the accounting trail is complete rather than mutating the
 * original invoice's numbers out from under the customer.
 */
export async function refundInvoice(opts: {
  invoiceId: string
  amount?: number // omit = refund everything still refundable
  destination?: 'wallet' | 'gateway'
  reason?: string | null
  adminUserId?: string | null
}): Promise<RefundResult> {
  const invoice = await db.invoice.findUnique({ where: { id: opts.invoiceId } })
  if (!invoice) return { success: false, error: 'Invoice not found' }

  const received = round2((invoice.amountPaid || 0) + (invoice.creditApplied || 0))
  if (received <= 0) {
    return {
      success: false,
      error: 'Nothing to refund — no money has been received against this invoice.',
    }
  }

  const alreadyRefunded = round2(invoice.amountRefunded || 0)
  const refundable = round2(received - alreadyRefunded)
  if (refundable <= 0) {
    return { success: false, error: 'This invoice has already been fully refunded.' }
  }

  const amount = round2(
    opts.amount === undefined ? refundable : Number(opts.amount)
  )
  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, error: 'Refund amount must be greater than 0' }
  }
  if (amount > refundable + 0.009) {
    return {
      success: false,
      error: `Cannot refund more than the ${refundable.toFixed(2)} still refundable.`,
    }
  }

  const destination = opts.destination || 'wallet'

  const totalRefunded = round2(alreadyRefunded + amount)
  const fullyRefunded = totalRefunded >= received - 0.009

  // No interactive transaction: on SQLite two concurrent interactive
  // transactions that read before writing deadlock on the lock upgrade.
  // Guarded single-statement writes instead, claim first:
  //   1. claim the refund with a conditional update on the `amountRefunded`
  //      we read — two refunds submitted together cannot both pass the
  //      "refundable" check above; the loser matches nothing and stops here,
  //      before any money moves;
  //   2. credit the wallet (relative increment); if that fails, undo step 1;
  //   3. write the Refund row and, for a full refund, mark the payments.
  const claimed = await db.invoice.updateMany({
    where: { id: invoice.id, amountRefunded: invoice.amountRefunded },
    data: {
      amountRefunded: totalRefunded,
      refundedAt: new Date(),
      ...(fullyRefunded ? { status: 'refunded' } : {}),
    },
  })
  if (claimed.count !== 1) {
    return {
      success: false,
      error: 'This invoice was refunded by another request just now. Reload and try again.',
    }
  }

  // Money back to the wallet is something we can genuinely do right now.
  let newBalance: number | undefined
  if (destination === 'wallet') {
    try {
      newBalance = await moveCredit({
        userId: invoice.userId,
        amount,
        type: 'refund',
        description: `Refund for invoice ${invoice.number}${opts.reason ? ` — ${opts.reason}` : ''}`,
        invoiceId: invoice.id,
        adminUserId: opts.adminUserId,
      })
    } catch (err) {
      await db.invoice
        .updateMany({
          where: { id: invoice.id, amountRefunded: totalRefunded },
          data: {
            amountRefunded: invoice.amountRefunded,
            refundedAt: invoice.refundedAt,
            status: invoice.status,
          },
        })
        .catch((e) => console.error('[refunds] could not undo refund claim:', e))
      if (err instanceof CreditError) return { success: false, error: err.message }
      throw err
    }
  }

  const refund = await db.refund.create({
    data: {
      invoiceId: invoice.id,
      userId: invoice.userId,
      amount,
      currency: invoice.currency,
      destination,
      reason: opts.reason || null,
      status: 'completed',
      adminUserId: opts.adminUserId || null,
    },
  })

  // A fully refunded invoice means the payments that settled it are
  // refunded too. Service cancellation is left to the admin on purpose.
  if (fullyRefunded) {
    await db.payment.updateMany({
      where: { invoiceId: invoice.id, status: 'completed' },
      data: { status: 'refunded' },
    })
  }

  // Credit note for the books.
  let creditNoteNumber: string | undefined
  try {
    const note = await db.invoice.create({
      data: {
        number: await nextInvoiceNumber(),
        userId: invoice.userId,
        subscriptionId: invoice.subscriptionId,
        planId: invoice.planId,
        type: 'credit_note',
        parentInvoiceId: invoice.id,
        items: JSON.stringify([
          {
            description: `Credit note for invoice ${invoice.number}${opts.reason ? ` — ${opts.reason}` : ''}`,
            quantity: 1,
            unitPrice: -amount,
            total: -amount,
          },
        ]),
        subtotal: -amount,
        tax: 0,
        total: -amount,
        amountPaid: -amount,
        currency: invoice.currency,
        status: 'paid',
        paidAt: new Date(),
        notes: `Refund issued to ${destination}.`,
      },
    })
    creditNoteNumber = note.number
  } catch (err) {
    // The refund itself succeeded; a failed credit note must not undo it.
    console.error('[refunds] credit note creation failed:', err)
  }

  await notifyRefundIssued({
    userId: invoice.userId,
    invoiceNumber: invoice.number,
    amount,
    currency: invoice.currency,
    destination,
    // Only a wallet refund has actually moved money at this point — a
    // gateway refund is recorded here and settled in the provider's portal.
    settled: destination === 'wallet',
    reason: opts.reason || null,
  }).catch(() => {})

  return {
    success: true,
    refundId: refund.id,
    amount,
    destination,
    creditNoteNumber,
    newBalance,
  }
}

/** The parts of a Stripe Charge that recordStripeChargeRefund reads. */
export interface StripeChargeLike {
  id?: string | null
  payment_intent?: string | { id?: string } | null
  amount_refunded?: number | null
  refunded?: boolean | null
}

/**
 * Book a refund made in the Stripe dashboard (`charge.refunded`).
 *
 *  - the linked invoice gets a gateway refund for whatever Stripe has refunded
 *    beyond what is already recorded (so a redelivered event adds nothing);
 *  - a FULL refund marks the Payment 'refunded'.
 *
 * Services are deliberately not cancelled or deleted here — that remains an
 * admin decision.
 */
export async function recordStripeChargeRefund(charge: StripeChargeLike): Promise<string> {
  const paymentIntentId =
    typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id || null
  const ids = [paymentIntentId, charge.id].filter((v): v is string => Boolean(v))
  if (!ids.length) return 'charge has no ids'

  const payment = await db.payment.findFirst({
    where: { method: 'stripe', stripePaymentId: { in: ids } },
    orderBy: { createdAt: 'asc' },
  })
  if (!payment) return 'no matching payment'

  let booked = 0
  if (payment.invoiceId) {
    const invoice = await db.invoice.findUnique({ where: { id: payment.invoiceId } })
    if (invoice) {
      const refundedInStripe = round2(Number(charge.amount_refunded || 0) / 100)
      const received = round2((invoice.amountPaid || 0) + (invoice.creditApplied || 0))
      const recorded = round2(invoice.amountRefunded || 0)
      const toBook = round2(
        Math.min(refundedInStripe - recorded, received - recorded)
      )
      if (toBook > 0.009) {
        const r = await refundInvoice({
          invoiceId: invoice.id,
          amount: toBook,
          destination: 'gateway',
          reason: 'Refunded in Stripe',
        })
        if (r.success) booked = toBook
        else console.error('[refunds] stripe refund not booked:', r.error)
      }
    }
  }

  if (charge.refunded) {
    await db.payment.updateMany({
      where: { id: payment.id, status: 'completed' },
      data: { status: 'refunded' },
    })
  }
  return `payment ${payment.id}${booked ? ` booked ${booked.toFixed(2)}` : ''}${
    charge.refunded ? ' marked refunded' : ''
  }`
}
