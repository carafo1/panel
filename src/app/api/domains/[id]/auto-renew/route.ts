/**
 * PUT /api/domains/:id/auto-renew
 * Body: { enabled: boolean }
 * Enable or disable auto-renewal for a domain via Dynadot.
 */
import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db'
import { dynadotService } from '@/lib/dynadot-service'
import { ok, apiError } from '@/lib/api-response'
import { assertRegistrarManaged } from '@/lib/domain-ownership'

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

    // Registrar-only operation. Without this the call reaches Dynadot and comes
    // back "could not find domain in your account", which the customer sees as
    // an opaque server error on a domain the panel told them we manage.
    const notOurs = assertRegistrarManaged(domain)
    if (notOurs) return notOurs

    const body = await request.json()
    const { enabled } = body
    if (typeof enabled !== 'boolean') {
      return apiError.badRequest('enabled (boolean) is required')
    }

    const result = enabled
      ? await dynadotService.enableAutoRenew(domain.name)
      : await dynadotService.disableAutoRenew(domain.name)

    if (!result.success) {
      return apiError.badRequest('Failed to update auto-renew setting at the registrar')
    }

    await db.domain.update({ where: { id }, data: { autoRenew: enabled } })

    await db.domainLog.create({
      data: {
        domainId: id,
        userId: user.userId,
        action: 'auto_renew',
        status: 'success',
        message: `Auto-renew ${enabled ? 'enabled' : 'disabled'}`,
      },
    })

    return ok(
      { autoRenew: enabled },
      `Auto-renew ${enabled ? 'enabled' : 'disabled'} successfully`
    )
  } catch (error) {
    console.error('[domains/auto-renew] error:', error)
    return apiError.serverError()
  }
}
