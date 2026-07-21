/**
 * Customer wallet / credit balance.
 *
 * `User.creditBalance` is a denormalised running total for fast reads; the
 * CreditTransaction table is the authoritative append-only history. Every
 * mutation goes through here so the two can never drift.
 */
import { db } from '@/lib/db'
import { notifyCreditAdjusted } from '@/lib/billing-notifications'

function round2(n: number) {
  return Math.round(n * 100) / 100
}

export interface CreditResult {
  success: boolean
  error?: string
  balance?: number
  applied?: number
}

/**
 * Adjust a customer's balance. Positive `amount` adds credit, negative
 * consumes it. Refuses to overdraw.
 */
export async function adjustCredit(opts: {
  userId: string
  amount: number
  type: 'topup' | 'refund' | 'applied' | 'adjustment'
  description?: string | null
  invoiceId?: string | null
  adminUserId?: string | null
  notify?: boolean
}): Promise<CreditResult> {
  const amount = round2(Number(opts.amount || 0))
  if (!Number.isFinite(amount) || amount === 0) {
    return { success: false, error: 'Amount must be a non-zero number' }
  }

  const user = await db.user.findUnique({
    where: { id: opts.userId },
    select: { id: true, creditBalance: true },
  })
  if (!user) return { success: false, error: 'User not found' }

  const current = round2(user.creditBalance || 0)
  const next = round2(current + amount)
  if (next < 0) {
    return {
      success: false,
      error: `Insufficient credit: balance is ${current.toFixed(2)}`,
    }
  }

  // Ledger row + balance move together so history and total stay consistent.
  await db.$transaction([
    db.user.update({
      where: { id: opts.userId },
      data: { creditBalance: next },
    }),
    db.creditTransaction.create({
      data: {
        userId: opts.userId,
        amount,
        balanceAfter: next,
        type: opts.type,
        description: opts.description || null,
        invoiceId: opts.invoiceId || null,
        adminUserId: opts.adminUserId || null,
      },
    }),
  ])

  // 'applied' means we just spent the customer's own credit against an
  // invoice — the invoice-paid notification already covers that, so telling
  // them their balance dropped as well is noise.
  if (opts.notify !== false && opts.type !== 'applied') {
    await notifyCreditAdjusted({
      userId: opts.userId,
      amount,
      balance: next,
      reason: opts.description || null,
    }).catch(() => {})
  }

  return { success: true, balance: next }
}

/**
 * Spend available wallet balance against an invoice.
 * Applies the lesser of (balance, amount due); marks the invoice paid if the
 * credit covers it entirely. Safe to call when the balance is zero.
 */
export async function applyCreditToInvoice(opts: {
  invoiceId: string
  adminUserId?: string | null
}): Promise<CreditResult> {
  const invoice = await db.invoice.findUnique({ where: { id: opts.invoiceId } })
  if (!invoice) return { success: false, error: 'Invoice not found' }
  if (invoice.status === 'paid') {
    return { success: false, error: 'Invoice is already paid' }
  }

  const user = await db.user.findUnique({
    where: { id: invoice.userId },
    select: { creditBalance: true },
  })
  const balance = round2(user?.creditBalance || 0)
  if (balance <= 0) return { success: true, applied: 0, balance: 0 }

  const due = round2(invoice.total - (invoice.creditApplied || 0))
  if (due <= 0) return { success: true, applied: 0, balance }

  const applied = round2(Math.min(balance, due))

  const spend = await adjustCredit({
    userId: invoice.userId,
    amount: -applied,
    type: 'applied',
    description: `Applied to invoice ${invoice.number}`,
    invoiceId: invoice.id,
    adminUserId: opts.adminUserId,
    notify: false,
  })
  if (!spend.success) return spend

  const fullyCovered = applied >= due
  await db.invoice.update({
    where: { id: invoice.id },
    data: {
      creditApplied: round2((invoice.creditApplied || 0) + applied),
      ...(fullyCovered ? { status: 'paid', paidAt: new Date() } : {}),
    },
  })

  return { success: true, applied, balance: spend.balance }
}

/** Wallet history, newest first. */
export async function getCreditHistory(userId: string, limit = 50) {
  return db.creditTransaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}
