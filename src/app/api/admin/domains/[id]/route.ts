/**
 * GET    /api/admin/domains/:id   — admin view of a single domain
 * POST   /api/admin/domains/:id/suspend  — suspend a domain
 * DELETE /api/admin/domains/:id   — delete a domain (soft: marks status=deleted)
 */
import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db'
import { ok, apiError } from '@/lib/api-response'
import { dynadotService } from '@/lib/dynadot-service'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await authenticateRequest(request)
  if (!user) return apiError.unauthorized()
  if (user.role !== 'admin' && user.role !== 'super_admin') return apiError.forbidden(`Admin access required`)

  const { id } = await params
  const domain = await db.domain.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, email: true } },
      dnsRecords: true,
      logs: { orderBy: { createdAt: 'desc' }, take: 20 },
      orders: { orderBy: { createdAt: 'desc' }, take: 10 },
      invoices: { orderBy: { createdAt: 'desc' }, take: 10 },
    },
  })
  if (!domain) return apiError.notFound('Domain not found')

  return ok(
    {
      ...domain,
      registeredAt: domain.registeredAt?.toISOString(),
      expiresAt: domain.expiresAt?.toISOString(),
      createdAt: domain.createdAt.toISOString(),
      updatedAt: domain.updatedAt.toISOString(),
      logs: domain.logs.map((l) => ({
        ...l,
        createdAt: l.createdAt.toISOString(),
      })),
    },
    'Domain details'
  )
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await authenticateRequest(request)
  if (!user) return apiError.unauthorized()
  if (user.role !== 'admin' && user.role !== 'super_admin') return apiError.forbidden(`Admin access required`)

  const { id } = await params
  const domain = await db.domain.findUnique({ where: { id } })
  if (!domain) return apiError.notFound('Domain not found')

  // Soft delete - mark as deleted (do not actually remove DB record for audit)
  await db.domain.update({ where: { id }, data: { status: 'deleted' } })
  await db.domainLog.create({
    data: {
      domainId: id,
      userId: user.userId,
      action: 'delete',
      status: 'success',
      message: `Domain deleted by admin ${user.email}`,
    },
  })

  return ok({ id, status: 'deleted' }, 'Domain deleted (soft delete)')
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await authenticateRequest(request)
  if (!user) return apiError.unauthorized()
  if (user.role !== 'admin' && user.role !== 'super_admin') return apiError.forbidden(`Admin access required`)

  const { id } = await params
  const body = await request.json()
  const { status } = body

  const domain = await db.domain.findUnique({ where: { id } })
  if (!domain) return apiError.notFound('Domain not found')

  await db.domain.update({ where: { id }, data: { status } })
  await db.domainLog.create({
    data: {
      domainId: id,
      userId: user.userId,
      action: 'status_change',
      status: 'success',
      message: `Status changed to ${status} by admin`,
    },
  })

  return ok({ id, status }, `Domain status updated to ${status}`)
}

// Suppress unused import warning for dynadotService (used by suspend route)
void dynadotService
