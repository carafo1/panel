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

/** A refused balance move (overdraw, unknown user, concurrent change). */
export class CreditError extends Error {}

export interface AdjustCreditInput {
  userId: string
  amount: number
  type: 'topup' | 'refund' | 'applied' | 'adjustment'
  description?: string | null
  invoiceId?: string | null
  adminUserId?: string | null
}

/**
 * Move a balance and write the ledger row. Returns the balance after the
 * move; throws CreditError when refused.
 *
 * No interactive transaction on purpose. On SQLite two concurrent interactive
 * transactions that read before they write deadlock on the lock upgrade (and
 * Prisma's updateMany reads first internally). Instead:
 *
 *   1. ONE atomic, self-guarding UPDATE: a relative increment/decrement —
 *      never an absolute value computed from an earlier read, which lost one of
 *      two concurrent updates — with the overdraw check in the same statement
 *      (`creditBalance >= amount`), so two spends cannot both pass it;
 *   2. the ledger row. If that insert fails, the balance move is reversed
 *      (again with a relative update) so total and history cannot drift.
 */
export async function moveCredit(opts: AdjustCreditInput): Promise<number> {
  const amount = round2(Number(opts.amount || 0))
  if (!Number.isFinite(amount) || amount === 0) {
    throw new CreditError('Amount must be a non-zero number')
  }

  const moved = await db.user.updateMany({
    where: {
      id: opts.userId,
      // Tiny epsilon: balances are floats, and 9.999999 must cover 10.00.
      ...(amount < 0 ? { creditBalance: { gte: -amount - 0.000001 } } : {}),
    },
    data: { creditBalance: { increment: amount } },
  })
  if (moved.count !== 1) {
    const user = await db.user.findUnique({
      where: { id: opts.userId },
      select: { creditBalance: true },
    })
    if (!user) throw new CreditError('User not found')
    throw new CreditError(
      `Insufficient credit: balance is ${round2(user.creditBalance || 0).toFixed(2)}`
    )
  }

  // Balance as of just after our move (a concurrent move may already be
  // included; the running total itself is exact either way).
  const after = await db.user.findUnique({
    where: { id: opts.userId },
    select: { creditBalance: true },
  })
  const next = round2(after?.creditBalance || 0)

  try {
    await db.creditTransaction.create({
      data: {
        userId: opts.userId,
        amount,
        balanceAfter: next,
        type: opts.type,
        description: opts.description || null,
        invoiceId: opts.invoiceId || null,
        adminUserId: opts.adminUserId || null,
      },
    })
  } catch (err) {
    await db.user
      .updateMany({
        where: { id: opts.userId },
        data: { creditBalance: { increment: -amount } },
      })
      .catch((e) => console.error('[credit] could not reverse balance move:', e))
    throw err
  }
  return next
}

/**
 * Adjust a customer's balance. Positive `amount` adds credit, negative
 * consumes it. Refuses to overdraw.
 */
export async function adjustCredit(
  opts: AdjustCreditInput & { notify?: boolean }
): Promise<CreditResult> {
  const amount = round2(Number(opts.amount || 0))
  if (!Number.isFinite(amount) || amount === 0) {
    return { success: false, error: 'Amount must be a non-zero number' }
  }

  let next: number
  try {
    next = await moveCredit(opts)
  } catch (err) {
    if (err instanceof CreditError) return { success: false, error: err.message }
    throw err
  }

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

  // Money already received against the invoice is not due again.
  const due = round2(
    invoice.total - (invoice.creditApplied || 0) - (invoice.amountPaid || 0)
  )
  if (due <= 0) return { success: true, applied: 0, balance }

  const applied = round2(Math.min(balance, due))
  const fullyCovered = applied >= due

  // No interactive transaction (SQLite lock-upgrade deadlock). Two guarded
  // single-statement writes instead, with compensation:
  //   1. claim the invoice exactly as it was read — a concurrent application
  //      (two sweeps, admin + sweep) matches nothing and stops here;
  //   2. debit the wallet with a self-guarding decrement; if the balance no
  //      longer covers it, the claim in step 1 is undone.
  const claim = await db.invoice.updateMany({
    where: {
      id: invoice.id,
      status: invoice.status,
      creditApplied: invoice.creditApplied,
    },
    data: {
      creditApplied: { increment: applied },
      ...(fullyCovered ? { status: 'paid', paidAt: new Date() } : {}),
    },
  })
  if (claim.count !== 1) {
    return { success: false, error: 'The invoice changed while applying credit. Please retry.' }
  }

  let newBalance: number
  try {
    newBalance = await moveCredit({
      userId: invoice.userId,
      amount: -applied,
      type: 'applied',
      description: `Applied to invoice ${invoice.number}`,
      invoiceId: invoice.id,
      adminUserId: opts.adminUserId,
    })
  } catch (err) {
    await db.invoice
      .updateMany({
        where: { id: invoice.id },
        data: {
          creditApplied: { increment: -applied },
          ...(fullyCovered ? { status: invoice.status, paidAt: invoice.paidAt } : {}),
        },
      })
      .catch((e) => console.error('[credit] could not undo invoice credit claim:', e))
    if (err instanceof CreditError) return { success: false, error: err.message }
    throw err
  }

  if (fullyCovered) {
    const { onInvoiceSettled } = await import('@/lib/billing-enforcement')
    await onInvoiceSettled(invoice.id)
  }

  return { success: true, applied, balance: newBalance }
}

/** Wallet history, newest first. */
export async function getCreditHistory(userId: string, limit = 50) {
  return db.creditTransaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}
