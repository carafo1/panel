/**
 * PUT /api/domains/:id/nameservers
 * Body: { nameservers: ["ns1.example.com", "ns2.example.com"] }
 * Sets custom nameservers for the domain via Dynadot and persists them.
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
    const { nameservers } = body
    if (!Array.isArray(nameservers) || nameservers.length < 2) {
      return apiError.badRequest('At least 2 nameservers are required')
    }
    if (nameservers.length > 13) {
      return apiError.badRequest('Maximum 13 nameservers allowed')
    }
    // SECURITY: validate nameserver format — H6 (was: /^[a-z0-9.-]+$/ — too permissive)
    const NS_REGEX = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i
    for (const ns of nameservers) {
      if (typeof ns !== 'string' || !NS_REGEX.test(ns)) {
        return apiError.validation([
          { code: 'invalid_ns', message: `Invalid nameserver (must be a valid FQDN like ns1.example.com): ${ns}`, field: 'nameservers' },
        ])
      }
    }

    // Push to Dynadot
    const result = await dynadotService.setNameservers(domain.name, nameservers)
    if (!result.success) {
      return apiError.badRequest('Failed to set nameservers at the registrar')
    }

    // Persist
    await db.domain.update({
      where: { id },
      data: { nameservers: JSON.stringify(nameservers) },
    })
    await db.nameserverEntry.deleteMany({ where: { domainId: id } })
    for (let i = 0; i < nameservers.length; i++) {
      await db.nameserverEntry.create({
        data: { domainId: id, hostname: nameservers[i], sortOrder: i },
      })
    }

    await db.domainLog.create({
      data: {
        domainId: id,
        userId: user.userId,
        action: 'nameservers',
        status: 'success',
        message: `Updated nameservers: ${nameservers.join(', ')}`,
      },
    })

    return ok({ nameservers }, 'Nameservers updated successfully')
  } catch (error) {
    console.error('[domains/nameservers] error:', error)
    return apiError.serverError()
  }
}
