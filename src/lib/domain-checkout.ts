/**
 * Domain checkout — money before delivery.
 *
 * Domain registration spends real registrar balance and is irreversible: once
 * an order reaches Dynadot there is no "undo", and the money is gone whether
 * or not the customer ever pays. So the order of operations is not negotiable:
 *
 *   quote → order (pending_payment) → invoice (pending) → PAYMENT
 *     → [gateway confirms] → provisionForPayment → fulfilDomainOrder
 *       → registrar call → domain live → invoice paid
 *
 * Everything before "PAYMENT" is free to do and free to abandon. Nothing after
 * it runs until a gateway (or an admin, for bank transfers) has confirmed the
 * money arrived. `fulfilDomainOrder` is idempotent so a retried Stripe webhook
 * or a double-clicked admin confirmation cannot register — or bill — twice.
 *
 * This replaces the old path where the Domains panel called
 * /api/domains/register directly and the registrar was hit with no charge at
 * all.
 */
import { db } from './db'
import { dynadotService } from './dynadot-service'
import { getPriceForDomain } from './pricing'
import { processPayment } from './payment-methods'
import { nextInvoiceNumber, markInvoicePaid } from './invoices'
import { isRegistrarManaged, registrarUnavailableReason } from './domain-ownership'
import { checkLimit } from './plan-limits'
import { encrypt, decrypt } from './encryption'
import {
  runRegistrationPipeline,
  runRenewalPipeline,
  runTransferPipeline,
} from './domain-automation'

// ─── Types ────────────────────────────────────────────────────────────────────

export type DomainOrderKind = 'register' | 'renew' | 'transfer'

/**
 * Order lifecycle. `pending_payment` is the only state that spends nothing.
 *
 *   pending_payment → processing → completed
 *                                → transfer_pending   (transfer accepted; completes later)
 *                                → failed             (registrar definitely did NOT buy)
 *                                → manual_review      (registrar MAY have bought: never retry)
 *   failed → retry_pending (set by the retry sweeper) → processing …
 *
 * fulfilDomainOrder claims only `pending_payment` and `retry_pending`, and never
 * calls the registrar for an order whose registrarCalledAt is already set.
 */
export type DomainOrderStatus =
  | 'pending_payment'
  | 'processing'
  | 'completed'
  | 'transfer_pending'
  | 'failed'
  | 'retry_pending'
  | 'manual_review'
  | 'cancelled'

/** States fulfilDomainOrder may claim. */
export const CLAIMABLE_ORDER_STATUSES: readonly DomainOrderStatus[] = ['pending_payment', 'retry_pending']

/** Read the transfer EPP code from order metadata (encrypted; legacy plaintext accepted). */
export function readOrderAuthCode(meta: Record<string, unknown>): string {
  if (typeof meta.authCodeEnc === 'string' && meta.authCodeEnc) {
    try {
      return decrypt(meta.authCodeEnc)
    } catch {
      return ''
    }
  }
  return typeof meta.authCode === 'string' ? meta.authCode : ''
}

/** Metadata with every trace of the EPP code removed. */
export function withoutAuthCode(meta: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...meta }
  delete rest.authCode
  delete rest.authCodeEnc
  return rest
}

export interface RegistrantInput {
  firstName: string
  lastName: string
  email: string
  phone: string
  organization?: string
  address1: string
  address2?: string
  city: string
  state?: string
  postalCode: string
  country: string
}

export interface CreateDomainOrderInput {
  userId: string
  email: string
  domain: string
  years: number
  kind: DomainOrderKind
  /** Payment method key: 'stripe' | 'waafi' | 'manual'. */
  method: string
  /** Required for `register` and `transfer` (ICANN registrant data). */
  registrant?: RegistrantInput
  /** Required for `transfer` — the EPP/auth code from the losing registrar. */
  authCode?: string
  /** Existing domain, for renew/transfer. */
  domainId?: string
  projectId?: string | null
  successUrl?: string
  cancelUrl?: string
}

export interface CreateDomainOrderResult {
  success: boolean
  error?: string
  orderId?: string
  invoiceId?: string
  invoiceNumber?: string
  paymentId?: string
  amount?: number
  currency?: string
  /** Gateway page the customer must be sent to (Stripe/Waafi). */
  redirectUrl?: string
  /** 'redirect_required' | 'pending' | 'completed' */
  status?: string
}

export interface FulfilResult {
  success: boolean
  alreadyFulfilled?: boolean
  domainId?: string
  error?: string
}

// ─── Validation ───────────────────────────────────────────────────────────────

const FQDN_REGEX =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

const MAX_YEARS = 10

/** ISO-3166 alpha-2, which is what registrars require. */
const COUNTRY_REGEX = /^[A-Za-z]{2}$/
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validateRegistrant(r?: RegistrantInput): string | null {
  if (!r) return 'Registrant contact details are required'
  const required: Array<[keyof RegistrantInput, string]> = [
    ['firstName', 'First name'],
    ['lastName', 'Last name'],
    ['email', 'Email'],
    ['phone', 'Phone number'],
    ['address1', 'Street address'],
    ['city', 'City'],
    ['postalCode', 'Postal code'],
    ['country', 'Country'],
  ]
  for (const [field, label] of required) {
    if (!String(r[field] || '').trim()) return `${label} is required`
  }
  if (!EMAIL_REGEX.test(r.email.trim())) {
    return 'Registrant email is not a valid address'
  }
  if (!COUNTRY_REGEX.test(r.country.trim())) {
    return 'Country must be a 2-letter ISO country code (e.g. SO, US, GB)'
  }
  // Registrars reject numbers they cannot dial. Require enough digits to be
  // a real subscriber number rather than a placeholder like "0" or "123".
  if (r.phone.replace(/\D/g, '').length < 7) {
    return 'Phone number is not valid — include the country code, e.g. +252612345678'
  }
  return null
}

/** Money is compared and stored to the cent; floats drift otherwise. */
function toCents(amount: number): number {
  return Math.round(amount * 100)
}

function round2(amount: number): number {
  return Math.round(amount * 100) / 100
}

// ─── Quote ────────────────────────────────────────────────────────────────────

export interface DomainQuote {
  domain: string
  kind: DomainOrderKind
  years: number
  unitPrice: number
  total: number
  currency: string
}

/**
 * Price an order from the DomainPrice catalogue (wholesale + markup).
 *
 * Always quote from the catalogue, never from the registrar's search result —
 * that carries the WHOLESALE price, and quoting it hands the customer our
 * entire margin.
 */
export async function quoteDomainOrder(
  domain: string,
  kind: DomainOrderKind,
  years: number
): Promise<DomainQuote | null> {
  const row = await getPriceForDomain(domain)
  if (!row) return null

  const unitPrice =
    kind === 'renew'
      ? row.renewal ?? row.registration
      : kind === 'transfer'
      ? row.transfer ?? row.registration
      : row.registration

  if (!unitPrice || unitPrice <= 0) return null

  // A transfer buys exactly one year of extension regardless of what the
  // customer picked — charging for more would be taking money for nothing.
  const billableYears = kind === 'transfer' ? 1 : years

  return {
    domain,
    kind,
    years: billableYears,
    unitPrice,
    total: round2(unitPrice * billableYears),
    currency: 'USD',
  }
}

// ─── Order creation ───────────────────────────────────────────────────────────

/**
 * Create a domain order and start payment. Registers NOTHING at the registrar.
 *
 * The returned `redirectUrl` (Stripe/Waafi) must be followed by the customer;
 * for `manual` (bank transfer) the order sits at `pending_payment` until an
 * admin confirms the money, which is the same path a card payment takes.
 */
export async function createDomainOrder(
  input: CreateDomainOrderInput
): Promise<CreateDomainOrderResult> {
  const domain = input.domain.toLowerCase().trim()

  if (!FQDN_REGEX.test(domain)) {
    return {
      success: false,
      error: 'Invalid domain name. Must be a valid domain such as example.com.',
    }
  }

  const years = Math.min(Math.max(Math.floor(Number(input.years) || 1), 1), MAX_YEARS)

  // ── Per-kind preconditions ──────────────────────────────────────────
  let existingDomainId: string | null = input.domainId || null

  if (input.kind === 'register') {
    const contactError = validateRegistrant(input.registrant)
    if (contactError) return { success: false, error: contactError }

    // Plan allowance. maxDomains was shown on the usage bar but never enforced,
    // so a Starter customer (1 domain) could register any number. Checked here
    // rather than at fulfilment so we refuse before taking money, not after.
    const verdict = await checkLimit(input.userId, 'domains')
    if (!verdict.allowed) {
      return {
        success: false,
        error:
          `Your ${verdict.planName} plan includes ${verdict.limit} domain${
            verdict.limit === 1 ? '' : 's'
          } and you already have ${verdict.used}. Upgrade your plan to register more.`,
      }
    }

    const existing = await db.domain.findUnique({ where: { name: domain } })
    // A previously deleted record must not block a fresh purchase.
    if (existing && existing.status !== 'deleted') {
      return { success: false, error: 'That domain is already in an account here.' }
    }

    // Availability is checked again inside the pipeline after payment; this
    // early check just stops the customer paying for something already taken.
    try {
      const search = await dynadotService.search(domain)
      if (search.status === 'premium' || search.premium) {
        // Premium names cost far more than the catalogue price; we do not
        // sell them rather than charge a price the registrar will exceed.
        return {
          success: false,
          error: 'That is a premium domain and cannot be purchased here. Please contact support.',
        }
      }
      if (search.status === 'unknown') {
        return {
          success: false,
          error: 'Could not confirm availability right now. Please try again.',
        }
      }
      if (search.status !== 'available') {
        return { success: false, error: 'That domain is no longer available.' }
      }
    } catch (err) {
      console.error('[domain-checkout] availability check failed:', err)
      return {
        success: false,
        error: 'Could not confirm availability right now. Please try again.',
      }
    }
  }

  if (input.kind === 'renew' || input.kind === 'transfer') {
    if (input.kind === 'transfer') {
      if (!input.authCode || !input.authCode.trim()) {
        return {
          success: false,
          error: 'An authorization (EPP) code is required to transfer a domain.',
        }
      }
      const contactError = validateRegistrant(input.registrant)
      if (contactError) return { success: false, error: contactError }
      // A domain already in ANOTHER customer's account here cannot be
      // transferred into this one (refused before taking money).
      const held = await db.domain.findUnique({ where: { name: domain } })
      if (held && held.status !== 'deleted' && held.userId !== input.userId) {
        return { success: false, error: 'That domain is already in an account here.' }
      }
    }

    if (input.kind === 'renew') {
      if (!existingDomainId) {
        return { success: false, error: 'Domain is required for renewal.' }
      }
      const owned = await db.domain.findUnique({ where: { id: existingDomainId } })
      if (!owned) return { success: false, error: 'Domain not found.' }
      if (owned.userId !== input.userId) {
        return { success: false, error: 'You do not have access to that domain.' }
      }
      if (owned.name.toLowerCase() !== domain) {
        return { success: false, error: 'Domain mismatch.' }
      }
      // Only a domain actually in our registrar account can be renewed here.
      // Taking money to renew a domain registered somewhere else would charge
      // for something we cannot deliver.
      if (!isRegistrarManaged(owned)) {
        return {
          success: false,
          error: registrarUnavailableReason(owned),
        }
      }
    }
  }

  // ── Quote ───────────────────────────────────────────────────────────
  const quote = await quoteDomainOrder(domain, input.kind, years)
  if (!quote) {
    return {
      success: false,
      error: 'We do not currently sell that extension. Please contact support.',
    }
  }

  const label =
    input.kind === 'register'
      ? 'Domain registration'
      : input.kind === 'renew'
      ? 'Domain renewal'
      : 'Domain transfer'

  // ── Order + invoice, atomically (nothing spent yet) ─────────────────
  //
  // These were two sequential creates. If the invoice insert failed — a
  // collision on the unique invoice number, a disk error, a dropped connection
  // — the order row survived in `pending_payment` with no invoice attached:
  // invisible to the customer, impossible to pay, and reclaimed by nothing.
  //
  // processPayment stays OUTSIDE this transaction deliberately. It makes a
  // network call to Stripe or Waafi, and holding a database transaction open
  // across an external HTTP request is how connection pools get exhausted. A
  // failure there is already handled by the compensating cleanup below.
  const { order, invoice, invoiceNumber } = await db.$transaction(async (tx) => {
    const createdOrder = await tx.domainOrder.create({
    data: {
      userId: input.userId,
      domainId: existingDomainId,
      domainName: domain,
      type: input.kind,
      duration: quote.years,
      status: 'pending_payment',
      unitPrice: quote.unitPrice,
      totalAmount: quote.total,
      currency: quote.currency,
      provider: 'dynadot',
      metadata: JSON.stringify({
        registrant: input.registrant || null,
        // EPP code encrypted at rest; cleared once the transfer is accepted.
        authCodeEnc: input.authCode ? encrypt(input.authCode.trim()) : null,
        projectId: input.projectId || null,
        requestedYears: years,
      }),
    },
  })

    // Invoice the customer can actually pay against.
    const number = await nextInvoiceNumber()

    const createdInvoice = await tx.invoice.create({
    data: {
      number,
      userId: input.userId,
      orderId: createdOrder.id,
      domainId: existingDomainId,
      items: JSON.stringify([
        {
          description: `${label}: ${domain} (${quote.years} year${
            quote.years > 1 ? 's' : ''
          })`,
          quantity: quote.years,
          unitPrice: quote.unitPrice,
          total: quote.total,
        },
      ]),
      subtotal: quote.total,
      tax: 0,
      total: quote.total,
      currency: quote.currency,
      status: 'pending',
      paidAt: null,
    },
    })

    return {
      order: createdOrder,
      invoice: createdInvoice,
      invoiceNumber: number,
    }
  })

  // ── Take the money ──────────────────────────────────────────────────
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
  const payment = await processPayment({
    method: input.method,
    // Domain orders are not subscription plans; this key is metadata only and
    // keeps gateway dashboards readable.
    planId: `domain-${input.kind}`,
    planName: `${label}: ${domain}`,
    amount: quote.total,
    currency: 'usd',
    userId: input.userId,
    email: input.email,
    successUrl:
      input.successUrl ||
      `${appUrl}/api/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: input.cancelUrl || `${appUrl}/?tab=domains&payment=cancelled`,
    purchaseType: 'domain',
    domainName: domain,
    extraMetadata: {
      // The hook fulfilment keys off — see provision-on-payment.ts.
      domainOrderId: order.id,
      domainOrderKind: input.kind,
      invoiceId: invoice.id,
      invoiceNumber,
    },
  })

  if (!payment.success || !payment.paymentId) {
    // Nothing was registered and nothing was charged — void the paperwork so
    // the customer isn't left with a phantom unpaid invoice.
    await db.invoice
      .update({ where: { id: invoice.id }, data: { status: 'void' } })
      .catch(() => {})
    await db.domainOrder
      .update({ where: { id: order.id }, data: { status: 'cancelled' } })
      .catch(() => {})
    return {
      success: false,
      error: payment.error || 'Could not start payment. Please try again.',
    }
  }

  await db.domainOrder
    .update({
      where: { id: order.id },
      data: {
        metadata: JSON.stringify({
          ...JSON.parse(order.metadata || '{}'),
          paymentId: payment.paymentId,
          invoiceId: invoice.id,
        }),
      },
    })
    .catch(() => {})

  return {
    success: true,
    orderId: order.id,
    invoiceId: invoice.id,
    invoiceNumber,
    paymentId: payment.paymentId,
    amount: quote.total,
    currency: quote.currency,
    redirectUrl: payment.redirectUrl,
    status: payment.status,
  }
}

// ─── Fulfilment (post-payment) ────────────────────────────────────────────────

/**
 * Deliver a paid domain order. Called only from the payment-confirmed path.
 *
 * Idempotent on the order status: a replayed webhook, a double-clicked admin
 * confirmation, or a retry after a partial failure will not register twice.
 */
export async function fulfilDomainOrder(
  orderId: string,
  opts: { paymentId?: string; gateway?: string } = {}
): Promise<FulfilResult> {
  const order = await db.domainOrder.findUnique({ where: { id: orderId } })
  if (!order) return { success: false, error: 'Order not found' }

  // Idempotency guard — never deliver the same order twice.
  if (order.status === 'completed' || order.status === 'transfer_pending') {
    return {
      success: true,
      alreadyFulfilled: true,
      domainId: order.domainId || undefined,
    }
  }
  if (order.status === 'processing') {
    return { success: false, error: 'Order is already being processed' }
  }
  if (order.status === 'cancelled') {
    return { success: false, error: 'Order was cancelled' }
  }
  if (order.status === 'manual_review') {
    return { success: false, error: 'Order is held for manual review' }
  }
  // 'failed' is NOT re-claimed here: the retry sweeper moves it to
  // 'retry_pending' once it has checked that a retry is safe.
  if (!(CLAIMABLE_ORDER_STATUSES as readonly string[]).includes(order.status)) {
    return { success: false, error: `Order cannot be fulfilled from status "${order.status}"` }
  }

  let meta: Record<string, unknown> = {}
  try {
    meta = order.metadata ? JSON.parse(order.metadata) : {}
  } catch {
    meta = {}
  }

  // The registrar was already called for this order and never confirmed: the
  // purchase may have gone through. Calling again could buy twice.
  if (order.registrarCalledAt) {
    await holdForManualReview(orderId, order.status, meta, 'registrar was called before without a confirmed result')
    return { success: false, error: 'Order is held for manual review' }
  }

  // Claim the order before touching the registrar. Conditional on the status
  // we read AND on the registrar not having been called, so two concurrent
  // confirmations cannot both register (and pay for) the domain.
  const claim = await db.domainOrder.updateMany({
    where: { id: orderId, status: order.status, registrarCalledAt: null },
    data: { status: 'processing' },
  })
  if (claim.count !== 1) {
    const now = await db.domainOrder.findUnique({
      where: { id: orderId },
      select: { status: true, domainId: true },
    })
    if (now?.status === 'completed' || now?.status === 'transfer_pending') {
      return {
        success: true,
        alreadyFulfilled: true,
        domainId: now.domainId || undefined,
      }
    }
    return { success: false, error: 'Order is already being processed' }
  }

  const registrant = (meta.registrant as RegistrantInput | null) || null
  const invoiceId = (meta.invoiceId as string | undefined) || undefined
  const contacts = registrant
    ? (['registrant', 'admin', 'tech', 'billing'] as const).map((type) => ({
        type,
        firstName: registrant.firstName,
        lastName: registrant.lastName,
        email: registrant.email,
        phone: registrant.phone,
        organization: registrant.organization,
        address1: registrant.address1,
        address2: registrant.address2,
        city: registrant.city,
        state: registrant.state,
        postalCode: registrant.postalCode,
        country: registrant.country,
      }))
    : undefined

  try {
    let domainId: string | undefined
    let ok = false
    let error: string | undefined
    let manualReview = false
    let transferPending = false
    let expiryUnknown = false

    if (order.type === 'register') {
      const server = await db.server.findFirst({
        where: { status: 'active' },
        orderBy: { usedRamGB: 'asc' },
      })
      const result = await runRegistrationPipeline({
        userId: order.userId,
        domain: order.domainName,
        duration: order.duration,
        contacts,
        serverIp: server?.ip,
        paymentMethod: opts.gateway || 'stripe',
        existingOrderId: order.id,
        existingInvoiceId: invoiceId,
      })
      ok = result.success
      error = result.error
      domainId = result.domainId
      manualReview = !!result.manualReview
      expiryUnknown = !!result.expiryUnknown
    } else if (order.type === 'renew') {
      const result = await runRenewalPipeline(
        order.userId,
        order.domainId as string,
        order.duration,
        { existingOrderId: order.id, existingInvoiceId: invoiceId }
      )
      ok = result.success
      error = result.error
      domainId = order.domainId || undefined
      manualReview = !!result.manualReview
      expiryUnknown = !!result.expiryUnknown
    } else if (order.type === 'transfer') {
      const authCode = readOrderAuthCode(meta)
      if (!authCode) {
        ok = false
        error = 'No transfer authorization code on the order'
      } else {
        const result = await runTransferPipeline(
          order.userId,
          order.domainName,
          authCode,
          { existingOrderId: order.id, existingInvoiceId: invoiceId, contacts }
        )
        ok = result.success
        error = result.error
        domainId = result.domainId
        manualReview = !!result.manualReview
        transferPending = !!result.transferPending
      }
    } else {
      ok = false
      error = `Unknown order type "${order.type}"`
    }

    // Once the registrar accepted a transfer the EPP code has done its job.
    const metaAfter = order.type === 'transfer' && (ok || manualReview) ? withoutAuthCode(meta) : meta

    if (!ok) {
      if (manualReview) {
        await holdForManualReview(orderId, 'processing', metaAfter, error || 'unknown')
        return { success: false, error: error || 'Order is held for manual review' }
      }
      // The registrar definitely did not buy anything. The money is already
      // taken: park the order as failed and leave the invoice unpaid so it
      // shows up for retry/refund rather than disappearing silently.
      await db.domainOrder.update({
        where: { id: orderId },
        data: {
          status: 'failed',
          metadata: JSON.stringify({
            ...metaAfter,
            fulfilmentError: error || 'unknown',
            failedAt: new Date().toISOString(),
          }),
        },
      })
      console.error(
        `[domain-checkout] fulfilment failed for order ${orderId} (${order.domainName}): ${error}`
      )
      return { success: false, error: error || 'Fulfilment failed' }
    }

    await db.domainOrder.update({
      where: { id: orderId },
      data: {
        // A transfer is only accepted at this point; reconciliation marks it
        // completed when the registry finishes it.
        status: transferPending ? 'transfer_pending' : 'completed',
        domainId: domainId || order.domainId,
        metadata: JSON.stringify({
          ...metaAfter,
          ...(expiryUnknown ? { needsReconciliation: 'expiry' } : {}),
        }),
      },
    })

    // Settle the invoice — the money is confirmed and the registrar accepted
    // the order (for a transfer: accepted, completion is tracked separately).
    if (invoiceId) {
      await markInvoicePaid(invoiceId, {
        gateway: opts.gateway || 'stripe',
        reference: opts.paymentId || null,
        amount: order.totalAmount,
        userId: order.userId,
      }).catch((err) =>
        console.error('[domain-checkout] invoice settle failed:', err)
      )
    }

    return { success: true, domainId }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // If the registrar was reached for this order we cannot know what it
    // did: hold for review. Otherwise nothing was bought: 'failed'.
    const now = await db.domainOrder
      .findUnique({ where: { id: orderId }, select: { registrarCalledAt: true } })
      .catch(() => null)
    if (!now || now.registrarCalledAt) {
      await holdForManualReview(orderId, 'processing', meta, message)
    } else {
      await db.domainOrder
        .update({
          where: { id: orderId },
          data: {
            status: 'failed',
            metadata: JSON.stringify({
              ...meta,
              fulfilmentError: message,
              failedAt: new Date().toISOString(),
            }),
          },
        })
        .catch(() => {})
    }
    console.error('[domain-checkout] fulfilment threw:', message)
    return { success: false, error: message }
  }
}

/**
 * Park an order whose registrar outcome is unknown, or whose purchase went
 * through but whose records are incomplete. Nothing retries a manual_review
 * order; an operator reconciles it against the registrar.
 */
async function holdForManualReview(
  orderId: string,
  fromStatus: string,
  meta: Record<string, unknown>,
  reason: string
): Promise<void> {
  await db.domainOrder
    .updateMany({
      where: { id: orderId, status: fromStatus },
      data: {
        status: 'manual_review',
        metadata: JSON.stringify({
          ...meta,
          manualReviewReason: reason,
          manualReviewAt: new Date().toISOString(),
        }),
      },
    })
    .catch((err) => console.error('[domain-checkout] could not hold order for review:', err))
  console.error(`[domain-checkout] order ${orderId} held for manual review: ${reason}`)
}
