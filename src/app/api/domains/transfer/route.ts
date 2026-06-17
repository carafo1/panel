/**
 * POST /api/domains/transfer
 * Body: { domain: string, authCode: string }
 * Transfers a domain from another registrar using the EPP auth code.
 */
import { authenticateRequest } from '@/lib/auth'
import { ok, apiError } from '@/lib/api-response'
import { runTransferPipeline } from '@/lib/domain-automation'

export async function POST(request: Request) {
  const user = await authenticateRequest(request)
  if (!user) return apiError.unauthorized()

  try {
    const body = await request.json()
    const { domain, authCode } = body

    if (!domain) return apiError.badRequest('domain is required')
    if (!authCode) return apiError.badRequest('authCode (EPP code) is required')

    const domainLower = String(domain).toLowerCase().trim()
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domainLower)) {
      return apiError.validation([
        { code: 'invalid_domain', message: 'Invalid domain name format', field: 'domain' },
      ])
    }

    const result = await runTransferPipeline(user.userId, domainLower, String(authCode))
    if (!result.success) {
      return apiError.badRequest(result.error || 'Transfer failed')
    }

    return ok(
      {
        domain: domainLower,
        domainId: result.domainId,
        invoiceNumber: result.invoiceNumber,
        status: 'transferring',
      },
      'Domain transfer initiated successfully'
    )
  } catch (error) {
    console.error('[domains/transfer] error:', error)
    return apiError.serverError()
  }
}
