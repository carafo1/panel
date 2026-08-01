/**
 * POST /api/domains/checkout
 *
 * The customer-facing way to buy a domain: register, renew, or transfer.
 *
 * Creates an order and an invoice, then starts payment. NOTHING is sent to the
 * registrar here — delivery happens only once the gateway (or an admin, for
 * bank transfers) confirms the money, via provisionForPayment →
 * fulfilDomainOrder.
 *
 * Response carries `redirectUrl` for card/mobile-money gateways; for a manual
 * bank transfer the order waits at `pending_payment` with a payable invoice.
 *
 * GET /api/domains/checkout?domain=x.com&kind=register&years=1
 * returns the quote alone, so the UI can show a total before collecting
 * registrant details.
 */
import { NextResponse } from 'next/server'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { db } from '@/lib/db'
import {
  createDomainOrder,
  quoteDomainOrder,
  type DomainOrderKind,
  type RegistrantInput,
} from '@/lib/domain-checkout'
import { getActivePaymentMethods } from '@/lib/payment-methods'
import { requireVerifiedEmail } from '@/lib/require-verified'
import { withRateLimit } from '@/lib/rate-limit'
import { logAudit } from '@/lib/audit'

const VALID_KINDS: DomainOrderKind[] = ['register', 'renew', 'transfer']

function isKind(value: unknown): value is DomainOrderKind {
  return typeof value === 'string' && VALID_KINDS.includes(value as DomainOrderKind)
}

/** Trim every string field so " " doesn't pass a required-field check. */
function cleanRegistrant(raw: unknown): RegistrantInput | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string).trim() : '')
  return {
    firstName: str('firstName'),
    lastName: str('lastName'),
    email: str('email'),
    phone: str('phone'),
    organization: str('organization') || undefined,
    address1: str('address1'),
    address2: str('address2') || undefined,
    city: str('city'),
    state: str('state') || undefined,
    postalCode: str('postalCode'),
    country: str('country').toUpperCase(),
  }
}

async function getHandler(request: Request) {
  const token = extractTokenFromHeader(request.headers.get('Authorization'))
  if (!token) {
    return NextResponse.json({ error: 'Authorization token required' }, { status: 401 })
  }
  const decoded = await verifyTokenFresh(token)
  if (!decoded) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const domain = (searchParams.get('domain') || '').toLowerCase().trim()
  const kindParam = searchParams.get('kind') || 'register'
  const years = Number(searchParams.get('years') || '1')

  if (!domain) {
    return NextResponse.json({ error: 'domain is required' }, { status: 400 })
  }
  if (!isKind(kindParam)) {
    return NextResponse.json(
      { error: 'kind must be register, renew or transfer' },
      { status: 400 }
    )
  }

  const quote = await quoteDomainOrder(domain, kindParam, years)
  if (!quote) {
    return NextResponse.json(
      { error: 'We do not currently sell that extension.' },
      { status: 404 }
    )
  }

  // Only offer gateways an admin has switched on.
  const methods = await getActivePaymentMethods()

  return NextResponse.json({
    quote,
    paymentMethods: methods.map((m) => ({
      method: m.method,
      displayName: m.displayName,
      icon: m.icon,
    })),
  })
}

async function postHandler(request: Request) {
  try {
    const token = extractTokenFromHeader(request.headers.get('Authorization'))
    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }
    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const user = await db.user.findUnique({ where: { id: decoded.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Domain registration spends non-refundable registrar balance, so require a
    // confirmed email first. Without this an address the signer-up does not
    // control could place real orders.
    const gate = await requireVerifiedEmail(decoded.userId, decoded.role)
    if (!gate.ok) return gate.response!

    const body = await request.json()
    const { domain, kind, years, method, registrant, authCode, domainId, projectId } =
      body as Record<string, unknown>

    if (typeof domain !== 'string' || !domain.trim()) {
      return NextResponse.json({ error: 'domain is required' }, { status: 400 })
    }
    const orderKind: DomainOrderKind = isKind(kind) ? kind : 'register'

    const result = await createDomainOrder({
      userId: decoded.userId,
      email: user.email,
      domain: domain.trim(),
      years: Number(years) || 1,
      kind: orderKind,
      method: typeof method === 'string' && method ? method : 'stripe',
      registrant: cleanRegistrant(registrant),
      authCode: typeof authCode === 'string' ? authCode.trim() : undefined,
      domainId: typeof domainId === 'string' ? domainId : undefined,
      projectId: typeof projectId === 'string' ? projectId : null,
    })

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    await logAudit({
      userId: decoded.userId,
      action: `domain.${orderKind}.ordered`,
      resource: 'domain_order',
      resourceId: result.orderId,
      req: request,
      metadata: {
        domain: domain.trim().toLowerCase(),
        kind: orderKind,
        amount: result.amount,
        invoiceNumber: result.invoiceNumber,
        // The registrar is our supplier, not the customer's business.
        provider: 'apsamo',
      },
    })

    return NextResponse.json(
      {
        orderId: result.orderId,
        invoiceId: result.invoiceId,
        invoiceNumber: result.invoiceNumber,
        amount: result.amount,
        currency: result.currency,
        redirectUrl: result.redirectUrl,
        status: result.status,
        message:
          result.status === 'redirect_required'
            ? 'Continue to payment to complete your order.'
            : 'Order created. Your domain is set up as soon as payment is confirmed.',
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('[domains/checkout] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// Orders hit the registrar's availability API and create DB rows — rate limit
// so a script can't spray hundreds of pending orders.
export const GET = withRateLimit(getHandler, { limit: 30, windowMs: 60_000 })
export const POST = withRateLimit(postHandler, { limit: 10, windowMs: 60_000 })
