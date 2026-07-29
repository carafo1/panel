/**
 * Duplicate-order protection for email purchases.
 *
 * Nothing stopped the same order being placed twice. A customer who
 * double-clicks — or reloads a slow checkout — got two pending payments, and
 * once an admin confirmed both they were charged twice. For add-ons it was
 * worse than a billing problem: each confirmation increments
 * `extraMailboxes`/`extraStorageGB`, so one intended purchase of two mailboxes
 * silently became four.
 *
 * `provisionForPayment` is idempotent PER PAYMENT, which is the wrong grain to
 * catch this — two payments are two legitimate provisioning runs as far as it
 * is concerned. The duplicate has to be refused when the order is placed.
 *
 * The window is deliberately "any unsettled order for the same thing", not a
 * time window: an offline payment can sit pending for days waiting on a bank
 * transfer, and during all of that time a second order for the same domain is
 * a mistake rather than an intention.
 */
import { db } from '@/lib/db'

/** Statuses that mean money may still be taken for this order. */
const UNSETTLED = ['pending', 'processing'] as const

export interface DuplicateOrder {
  paymentId: string
  reference: string | null
  amount: number
  createdAt: Date
  method: string
}

/**
 * Payments that are still unsettled for this user, newest first.
 *
 * Metadata is JSON in a TEXT column, so it cannot be queried structurally —
 * candidates are narrowed in SQL by user and status, then matched in code.
 * The set is tiny (a customer has a handful of open orders at most).
 */
async function unsettledPayments(userId: string) {
  return db.payment.findMany({
    where: { userId, status: { in: [...UNSETTLED] } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function describe(p: {
  id: string
  transactionId: string | null
  amount: number
  createdAt: Date
  method: string
}): DuplicateOrder {
  return {
    paymentId: p.id,
    reference: p.transactionId,
    amount: p.amount,
    createdAt: p.createdAt,
    method: p.method,
  }
}

/**
 * An unsettled email-hosting order for this domain, if one exists.
 *
 * Matched on the DOMAIN rather than the plan: ordering Starter and then
 * Business for the same domain within minutes is the same mistake, and the
 * second would provision over the first.
 */
export async function findPendingEmailOrder(
  userId: string,
  domain: string
): Promise<DuplicateOrder | null> {
  const target = domain.toLowerCase().trim()
  for (const p of await unsettledPayments(userId)) {
    const meta = parseMeta(p.metadata)
    if (meta.purchaseType !== 'email') continue
    const d = typeof meta.domainName === 'string' ? meta.domainName.toLowerCase() : ''
    if (d === target) return describe(p)
  }
  return null
}

/** An unsettled add-on order for this service, if one exists. */
export async function findPendingAddonOrder(
  userId: string,
  serviceId: string
): Promise<DuplicateOrder | null> {
  for (const p of await unsettledPayments(userId)) {
    const meta = parseMeta(p.metadata)
    if (meta.purchaseType !== 'email-addon') continue
    if (meta.emailServiceId === serviceId) return describe(p)
  }
  return null
}

/** Wording shared by both paths so the customer sees one consistent message. */
export function duplicateOrderMessage(
  what: string,
  existing: DuplicateOrder
): string {
  const ref = existing.reference ? ` (reference ${existing.reference})` : ''
  return (
    `You already have an unpaid order for ${what}${ref}. ` +
    `Pay that one rather than placing a second — it is applied as soon as the ` +
    `payment is confirmed. Cancel it from Billing if you want to change it.`
  )
}
