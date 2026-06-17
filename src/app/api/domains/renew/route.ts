/**
 * POST /api/domains/renew
 * Body: { domainId: string, duration: number }
 * Renews a domain through the Dynadot pipeline and generates an invoice.
 */
import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db'
import { ok, apiError } from '@/lib/api-response'
import { runRenewalPipeline } from '@/lib/domain-automation'

export async function POST(request: Request) {
  const user = await authenticateRequest(request)
  if (!user) return apiError.unauthorized()

  try {
    const body = await request.json()
    const { domainId, duration: rawDuration } = body

    if (!domainId) return apiError.badRequest('domainId is required')
    const duration = Number(rawDuration) || 1
    if (duration < 1 || duration > 10) {
      return apiError.badRequest('duration must be between 1 and 10 years')
    }

    const domain = await db.domain.findUnique({ where: { id: domainId } })
    if (!domain) return apiError.notFound('Domain not found')
    if (domain.userId !== user.userId && user.role !== 'admin' && user.role !== 'super_admin') {
      return apiError.forbidden()
    }

    const result = await runRenewalPipeline(user.userId, domainId, duration)
    if (!result.success) {
      return apiError.badRequest(result.error || 'Renewal failed')
    }

    const updated = await db.domain.findUnique({
      where: { id: domainId },
      include: { renewals: { orderBy: { createdAt: 'desc' }, take: 1 } },
    })

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
      },
      `Domain renewed successfully for ${duration} year${duration > 1 ? 's' : ''}`
    )
  } catch (error) {
    console.error('[domains/renew] error:', error)
    return apiError.serverError()
  }
}
