/**
 * Customer-facing view of a DomainOrder.
 *
 * DomainOrder.metadata holds things a customer must never see: the encrypted
 * EPP code, registrar error strings (fulfilmentError, manualReviewReason),
 * registrar order ids and the registrant record. This module builds the
 * response from an explicit allow-list instead of spreading the row, so a new
 * metadata key can never leak by accident. The `message` is chosen from fixed
 * copy keyed on status; no stored text is ever echoed back.
 */

export type OrderKind = 'register' | 'renew' | 'transfer'

export type PaymentMethodKey = 'stripe' | 'waafi' | 'manual'

/** What the customer can do to pay an order that is still awaiting payment. */
export interface OrderPaymentView {
  method: PaymentMethodKey | null
  /** Gateway page to finish paying (card / mobile money), when still usable. */
  payUrl: string | null
  /** Reference to quote on a bank transfer. */
  reference: string | null
  /** Admin-configured bank-transfer instructions. */
  instructions: string | null
}

export interface DomainOrderView {
  id: string
  domainName: string
  kind: OrderKind
  years: number
  status: string
  amount: number
  currency: string
  invoiceId: string | null
  invoiceNumber: string | null
  invoicePaid: boolean
  /** The Domain this order produced or applies to, when it is in the account. */
  domainId: string | null
  /** True once that domain is live, so the UI can file the order as history. */
  domainActive: boolean
  /** Present only while the order is awaiting payment. */
  payment: OrderPaymentView | null
  message: string
  createdAt: string
  updatedAt: string
}

export interface OrderRow {
  id: string
  domainName: string
  type: string
  duration: number
  status: string
  totalAmount: number
  currency: string
  metadata: string | null
  createdAt: Date
  updatedAt: Date
  domain: { id: string; status: string; userId: string } | null
  invoices: Array<{
    id: string
    number: string
    status: string
    type: string
    total: number
    amountPaid: number
    createdAt: Date
  }>
}

export interface PaymentRow {
  id: string
  method: string
  status: string
  createdAt: Date
  metadata: string | null
}

/** Stripe Checkout sessions expire after 24h; stop offering the link before that. */
const PAY_LINK_MAX_AGE_MS = 23 * 60 * 60 * 1000

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** The payment id recorded on the order at checkout, if any. */
export function orderPaymentId(order: Pick<OrderRow, 'metadata'>): string | null {
  return str(parseMeta(order.metadata).paymentId)
}

/**
 * Only hand back a URL the browser can safely navigate to: a gateway over
 * https, or a same-origin path (demo checkout in development).
 */
function safePayUrl(raw: unknown): string | null {
  const value = str(raw)
  if (!value) return null
  if (value.startsWith('/') && !value.startsWith('//')) return value
  try {
    const u = new URL(value)
    if (u.protocol === 'https:') return u.toString()
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
      return u.toString()
    }
  } catch {
    /* not a URL */
  }
  return null
}

function isMethod(v: unknown): v is PaymentMethodKey {
  return v === 'stripe' || v === 'waafi' || v === 'manual'
}

function pickInvoice(order: OrderRow): OrderRow['invoices'][number] | null {
  const linked = str(parseMeta(order.metadata).invoiceId)
  const standard = order.invoices.filter((i) => i.type !== 'credit_note')
  if (linked) {
    const hit = standard.find((i) => i.id === linked)
    if (hit) return hit
  }
  return (
    [...standard].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null
  )
}

function invoiceIsPaid(inv: OrderRow['invoices'][number] | null): boolean {
  if (!inv) return false
  if (inv.status === 'paid') return true
  // A refunded or voided invoice is not "paid", whatever amountPaid recorded.
  if (inv.status === 'refunded' || inv.status === 'void') return false
  return inv.total > 0 && inv.amountPaid >= inv.total
}

function kindOf(type: string): OrderKind {
  return type === 'renew' || type === 'transfer' ? type : 'register'
}

function plural(years: number): string {
  return `${years} year${years === 1 ? '' : 's'}`
}

function buildPayment(
  payment: PaymentRow | null,
  now: number
): OrderPaymentView {
  if (!payment) return { method: null, payUrl: null, reference: null, instructions: null }
  const meta = parseMeta(payment.metadata)
  const method = isMethod(payment.method) ? payment.method : null
  const fresh = now - payment.createdAt.getTime() < PAY_LINK_MAX_AGE_MS
  const payUrl =
    method !== 'manual' && payment.status === 'pending' && fresh
      ? safePayUrl(meta.redirectUrl)
      : null
  return {
    method,
    payUrl,
    reference: method === 'manual' ? str(meta.manualReference) : null,
    instructions: method === 'manual' ? str(meta.instructions) : null,
  }
}

/**
 * Fixed customer copy for each state. Deliberately never includes the stored
 * failure reason: those strings come from the registrar or our own internals.
 */
function messageFor(
  status: string,
  kind: OrderKind,
  years: number,
  opts: {
    invoicePaid: boolean
    invoiceStatus: string | null
    invoiceNumber: string | null
    payment: OrderPaymentView | null
  }
): string {
  const inv = opts.invoiceNumber ? `invoice ${opts.invoiceNumber}` : 'the invoice'
  switch (status) {
    case 'pending_payment': {
      if (opts.invoicePaid) {
        return 'Payment received. We will start on this order shortly.'
      }
      const p = opts.payment
      if (p?.method === 'manual') {
        return p.reference
          ? `Waiting for your bank transfer to be confirmed. Quote reference ${p.reference} with your payment.`
          : 'Waiting for your bank transfer to be confirmed by our team.'
      }
      if (p?.payUrl) return `Waiting for payment. Pay ${inv} to start this order.`
      return `Waiting for payment. The payment link for ${inv} has expired; place the order again or contact support to pay it.`
    }
    case 'processing':
    case 'retry_pending':
      return kind === 'renew'
        ? 'Payment received. We are renewing this domain now.'
        : kind === 'transfer'
          ? 'Payment received. We are starting the transfer now.'
          : 'Payment received. We are registering this domain now.'
    case 'transfer_pending':
      return 'The transfer has been accepted and usually completes within 5–7 days.'
    case 'manual_review':
      return 'Our team is confirming this order with the registry. No action is needed from you.'
    case 'completed':
      return kind === 'renew'
        ? `Renewed for ${plural(years)}.`
        : kind === 'transfer'
          ? 'Transfer complete. The domain is now in your account.'
          : `Registered for ${plural(years)}. The domain is in your account.`
    case 'failed':
      return opts.invoiceStatus === 'refunded'
        ? 'This order could not be completed and your payment has been refunded.'
        : 'This order could not be completed. Contact support and we will sort it out.'
    case 'cancelled':
      return opts.invoicePaid
        ? 'This order was cancelled. Contact support about your payment.'
        : 'This order was cancelled before any payment was taken.'
    default:
      return 'We are working on this order.'
  }
}

export function toOrderView(
  order: OrderRow,
  userId: string,
  paymentsById: Map<string, PaymentRow>,
  now: number = Date.now()
): DomainOrderView {
  const kind = kindOf(order.type)
  const invoice = pickInvoice(order)
  const paid = invoiceIsPaid(invoice)
  // Only point at a Domain that is actually in this customer's account.
  const domain = order.domain && order.domain.userId === userId ? order.domain : null

  const payment =
    order.status === 'pending_payment' && !paid
      ? buildPayment(paymentsById.get(orderPaymentId(order) ?? '') ?? null, now)
      : null

  return {
    id: order.id,
    domainName: order.domainName,
    kind,
    years: order.duration,
    status: order.status,
    amount: order.totalAmount,
    currency: order.currency,
    invoiceId: invoice?.id ?? null,
    invoiceNumber: invoice?.number ?? null,
    invoicePaid: paid,
    domainId: domain?.id ?? null,
    domainActive: domain?.status === 'active',
    payment,
    message: messageFor(order.status, kind, order.duration, {
      invoicePaid: paid,
      invoiceStatus: invoice?.status ?? null,
      invoiceNumber: invoice?.number ?? null,
      payment,
    }),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  }
}
