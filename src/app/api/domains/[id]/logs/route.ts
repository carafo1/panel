/**
 * GET /api/domains/:id/logs
 * Returns the activity log for a domain.
 */
import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db'
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

    const logs = await db.domainLog.findMany({
      where: { domainId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    return ok(
      logs.map((l) => ({
        id: l.id,
        action: l.action,
        status: l.status,
        message: l.message,
        ipAddress: l.ipAddress,
        metadata: l.metadata ? JSON.parse(l.metadata) : null,
        createdAt: l.createdAt.toISOString(),
      })),
      `Retrieved ${logs.length} log entries`
    )
  } catch (error) {
    console.error('[domains/logs] error:', error)
    return apiError.serverError()
  }
}
