/**
 * PUT /api/domains/:id/lock
 * Body: { locked: boolean }
 * Lock or unlock the domain (registrar transfer lock) via Dynadot.
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
    const { locked } = body
    if (typeof locked !== 'boolean') {
      return apiError.badRequest('locked (boolean) is required')
    }

    const result = locked
      ? await dynadotService.lock(domain.name)
      : await dynadotService.unlock(domain.name)

    if (!result.success) {
      return apiError.badRequest(
        `Failed to ${locked ? 'lock' : 'unlock'} domain at the registrar`
      )
    }

    await db.domain.update({ where: { id }, data: { locked } })

    await db.domainLog.create({
      data: {
        domainId: id,
        userId: user.userId,
        action: locked ? 'lock' : 'unlock',
        status: 'success',
        message: `Domain ${locked ? 'locked' : 'unlocked'}`,
      },
    })

    return ok(
      { locked },
      `Domain ${locked ? 'locked' : 'unlocked'} successfully`
    )
  } catch (error) {
    console.error('[domains/lock] error:', error)
    return apiError.serverError()
  }
}
