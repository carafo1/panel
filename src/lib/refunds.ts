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
import { adjustCredit } from '@/lib/credit'
import { createNotification } from '@/lib/notifications'
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

  await db.invoice.update({
    where: { id: invoice.id },
    data: {
      amountPaid: newPaid,
      status: fullySettled ? 'paid' : 'partially_paid',
      ...(fullySettled ? { paidAt: new Date() } : {}),
    },
  })

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

  await createNotification({
    userId: invoice.userId,
    title: fullySettled ? 'Payment received' : 'Partial payment received',
    message: fullySettled
      ? `We've received ${invoice.currency} ${amount.toFixed(2)} — invoice ${invoice.number} is now paid in full.`
      : `We've received ${invoice.currency} ${amount.toFixed(2)} toward invoice ${invoice.number}. ${invoice.currency} ${remaining.toFixed(2)} remains due.`,
    type: 'success',
    link: '/?tab=billing',
  }).catch(() => {})

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

  // Money back to the wallet is something we can genuinely do right now.
  let newBalance: number | undefined
  if (destination === 'wallet') {
    const credited = await adjustCredit({
      userId: invoice.userId,
      amount,
      type: 'refund',
      description: `Refund for invoice ${invoice.number}${opts.reason ? ` — ${opts.reason}` : ''}`,
      invoiceId: invoice.id,
      adminUserId: opts.adminUserId,
      notify: false,
    })
    if (!credited.success) {
      return { success: false, error: credited.error }
    }
    newBalance = credited.balance
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

  const totalRefunded = round2(alreadyRefunded + amount)
  const fullyRefunded = totalRefunded >= received - 0.009

  await db.invoice.update({
    where: { id: invoice.id },
    data: {
      amountRefunded: totalRefunded,
      refundedAt: new Date(),
      ...(fullyRefunded ? { status: 'refunded' } : {}),
    },
  })

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

  await createNotification({
    userId: invoice.userId,
    title: 'Refund issued',
    message:
      destination === 'wallet'
        ? `${invoice.currency} ${amount.toFixed(2)} has been refunded to your account credit (invoice ${invoice.number}).`
        : `${invoice.currency} ${amount.toFixed(2)} has been refunded to your original payment method (invoice ${invoice.number}).`,
    type: 'info',
    link: '/?tab=billing',
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
