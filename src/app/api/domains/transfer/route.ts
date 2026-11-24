/**
 * POST /api/domains/transfer
 * Body: { domain, authCode, registrant, method?, force? }
 *
 * Starts a PAID inbound transfer. A transfer costs a full year's registrar fee
 * and extends the domain by a year, so it is charged like a registration: order
 * + invoice first, registrar call only after the payment is confirmed
 * (provisionForPayment → fulfilDomainOrder → runTransferPipeline).
 *
 * Admins keep a `force: true` override for support work, which transfers
 * immediately and leaves an unpaid invoice to reconcile.
 */
import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db'
import { ok, apiError } from '@/lib/api-response'
import { runTransferPipeline } from '@/lib/domain-automation'
import { createDomainOrder } from '@/lib/domain-checkout'
import { withRateLimit } from '@/lib/rate-limit'

async function postHandler(request: Request) {
  const user = await authenticateRequest(request)
  if (!user) return apiError.unauthorized()

  try {
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return apiError.badRequest('A JSON body is required')
    }
    const { domain, authCode, registrant, method, force } = body

    if (!domain) return apiError.badRequest('domain is required')
    if (!authCode) return apiError.badRequest('authCode (EPP code) is required')

    const domainLower = String(domain).toLowerCase().trim()
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domainLower)) {
      return apiError.validation([
        { code: 'invalid_domain', message: 'Invalid domain name format', field: 'domain' },
      ])
    }

    const isAdmin = user.role === 'admin' || user.role === 'super_admin'

    // ─── Admin override: transfer now, bill afterwards ───────────────
    if (force && isAdmin) {
      const result = await runTransferPipeline(
        user.userId,
        domainLower,
        String(authCode)
      )
      if (!result.success) {
        // SECURITY: return generic message — never expose the raw registrar error
        console.error('[domains/transfer] pipeline failed:', result.error)
        return apiError.badRequest(
          'Domain transfer failed. Please verify the auth code and try again.'
        )
      }
      return ok(
        {
          domain: domainLower,
          domainId: result.domainId,
          invoiceNumber: result.invoiceNumber,
          status: 'transferring',
          paid: false,
        },
        'Domain transfer initiated (invoice unpaid)'
      )
    }

    // ─── Customer path: pay first ────────────────────────────────────
    const userRecord = await db.user.findUnique({ where: { id: user.userId } })
    if (!userRecord) return apiError.notFound('User not found')

    const order = await createDomainOrder({
      userId: user.userId,
      email: userRecord.email,
      domain: domainLower,
      years: 1,
      kind: 'transfer',
      method: typeof method === 'string' && method ? method : 'stripe',
      registrant,
      authCode: String(authCode),
    })

    if (!order.success) {
      return apiError.badRequest(order.error || 'Could not start transfer')
    }

    return ok(
      {
        domain: domainLower,
        orderId: order.orderId,
        invoiceNumber: order.invoiceNumber,
        amount: order.amount,
        currency: order.currency,
        redirectUrl: order.redirectUrl,
        status: order.status,
      },
      order.status === 'redirect_required'
        ? 'Continue to payment to start the transfer.'
        : 'Transfer ordered. It begins as soon as payment is confirmed.'
    )
  } catch (error) {
    console.error('[domains/transfer] error:', error)
    return apiError.serverError()
  }
}

// Each call can start a payment and, for admins, a registrar purchase.
export const POST = withRateLimit(postHandler, { limit: 10, windowMs: 60_000 })
