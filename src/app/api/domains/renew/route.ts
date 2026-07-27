/**
 * POST /api/domains/renew
 * Body: { domainId: string, duration: number, method?: string }
 *
 * Starts a PAID renewal: prices the renewal, raises an order + invoice, and
 * returns a payment redirect. The registrar is only called once the payment is
 * confirmed (provisionForPayment → fulfilDomainOrder → runRenewalPipeline).
 *
 * Renewing costs real registrar balance, so this endpoint no longer renews
 * first and invoices afterwards — that delivered the service whether or not the
 * customer ever paid.
 *
 * Admins can still force an immediate renewal (`force: true`) for support and
 * recovery work; those go through the pipeline directly and leave an unpaid
 * invoice for reconciliation.
 */
import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db'
import { ok, apiError } from '@/lib/api-response'
import { runRenewalPipeline } from '@/lib/domain-automation'
import { createDomainOrder } from '@/lib/domain-checkout'

export async function POST(request: Request) {
  const user = await authenticateRequest(request)
  if (!user) return apiError.unauthorized()

  try {
    const body = await request.json()
    const { domainId, duration: rawDuration, method, force } = body

    if (!domainId) return apiError.badRequest('domainId is required')
    const duration = Number(rawDuration) || 1
    if (duration < 1 || duration > 10) {
      return apiError.badRequest('duration must be between 1 and 10 years')
    }

    const isAdmin = user.role === 'admin' || user.role === 'super_admin'

    const domain = await db.domain.findUnique({ where: { id: domainId } })
    if (!domain) return apiError.notFound('Domain not found')
    if (domain.userId !== user.userId && !isAdmin) {
      return apiError.forbidden()
    }

    // ─── Admin override: renew now, bill afterwards ──────────────────
    if (force && isAdmin) {
      const result = await runRenewalPipeline(user.userId, domainId, duration)
      if (!result.success) {
        // SECURITY: return generic message — never expose the raw registrar error
        console.error('[domains/renew] pipeline failed:', result.error)
        return apiError.badRequest(
          'Domain renewal failed. Please try again or contact support.'
        )
      }
      const updated = await db.domain.findUnique({ where: { id: domainId } })
      return ok(
        {
          domain: {
            id: updated!.id,
            name: updated!.name,
            status: updated!.status,
            expiresAt: updated!.expiresAt?.toISOString(),
            autoRenew: updated!.autoRenew,
          },
          invoiceNumber: result.invoiceNumber,
          paid: false,
        },
        `Domain renewed for ${duration} year${duration > 1 ? 's' : ''} (invoice unpaid)`
      )
    }

    // ─── Customer path: pay first ────────────────────────────────────
    const userRecord = await db.user.findUnique({ where: { id: user.userId } })
    if (!userRecord) return apiError.notFound('User not found')

    const order = await createDomainOrder({
      userId: user.userId,
      email: userRecord.email,
      domain: domain.name,
      years: duration,
      kind: 'renew',
      method: typeof method === 'string' && method ? method : 'stripe',
      domainId,
    })

    if (!order.success) {
      return apiError.badRequest(order.error || 'Could not start renewal')
    }

    return ok(
      {
        orderId: order.orderId,
        invoiceNumber: order.invoiceNumber,
        amount: order.amount,
        currency: order.currency,
        redirectUrl: order.redirectUrl,
        status: order.status,
      },
      order.status === 'redirect_required'
        ? 'Continue to payment to renew this domain.'
        : 'Renewal ordered. It completes as soon as payment is confirmed.'
    )
  } catch (error) {
    console.error('[domains/renew] error:', error)
    return apiError.serverError()
  }
}
