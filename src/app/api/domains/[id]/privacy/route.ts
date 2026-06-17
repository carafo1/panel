/**
 * PUT /api/domains/:id/privacy
 * Body: { enabled: boolean }
 * Enable or disable WHOIS privacy via Dynadot.
 */
import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db'
import { dynadotService } from '@/lib/dynadot-service'
import { ok, apiError } from '@/lib/api-response'

export async function PUT(
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

    const body = await request.json()
    const { enabled } = body
    if (typeof enabled !== 'boolean') {
      return apiError.badRequest('enabled (boolean) is required')
    }

    const result = enabled
      ? await dynadotService.enableWhoisPrivacy(domain.name)
      : await dynadotService.disableWhoisPrivacy(domain.name)

    if (!result.success) {
      return apiError.badRequest(
        `Failed to ${enabled ? 'enable' : 'disable'} WHOIS privacy at Dynadot`
      )
    }

    await db.domain.update({ where: { id }, data: { whoisPrivacy: enabled } })

    await db.domainLog.create({
      data: {
        domainId: id,
        userId: user.userId,
        action: 'privacy',
        status: 'success',
        message: `WHOIS privacy ${enabled ? 'enabled' : 'disabled'}`,
      },
    })

    return ok(
      { whoisPrivacy: enabled },
      `WHOIS privacy ${enabled ? 'enabled' : 'disabled'} successfully`
    )
  } catch (error) {
    console.error('[domains/privacy] error:', error)
    return apiError.serverError()
  }
}
