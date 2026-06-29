/**
 * GET /api/domains/:id/auth-code
 * Retrieves the EPP / auth code for a domain (required for transfers).
 */
import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db'
import { dynadotService } from '@/lib/dynadot-service'
import { ok, apiError } from '@/lib/api-response'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await authenticateRequest(request)
  if (!user) return apiError.unauthorized()

  const { id } = await params
  try {
    const domain = await db.domain.findUnique({ where: { id } })
    if (!domain) return apiError.notFound('Domain not found')
    if (domain.userId !== user.userId && user.role !== 'admin' && user.role !== 'super_admin') {
      return apiError.forbidden()
    }

    const result = await dynadotService.getAuthCode(domain.name)
    if (!result.success || !result.authCode) {
      return apiError.badRequest('Failed to retrieve auth code from the registrar')
    }

    // Cache the auth code on the domain record (encrypted at rest by app layer if desired)
    await db.domain.update({
      where: { id },
      data: { authCode: result.authCode },
    })

    await db.domainLog.create({
      data: {
        domainId: id,
        userId: user.userId,
        action: 'auth_code',
        status: 'success',
        message: 'EPP auth code retrieved',
      },
    })

    return ok(
      { authCode: result.authCode },
      'Auth code retrieved successfully'
    )
  } catch (error) {
    console.error('[domains/auth-code] error:', error)
    return apiError.serverError()
  }
}
