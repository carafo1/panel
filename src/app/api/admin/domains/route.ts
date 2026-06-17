/**
 * GET /api/admin/domains
 * Admin-only. Lists all domains across all users with filters.
 * Query: ?status=active&search=example&limit=50
 */
import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db'
import { ok, apiError } from '@/lib/api-response'

export async function GET(request: Request) {
  const user = await authenticateRequest(request)
  if (!user) return apiError.unauthorized()
  if (user.role !== 'admin' && user.role !== 'super_admin') return apiError.forbidden(`Admin access required`)

  try {
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const search = searchParams.get('search')
    const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10), 500)

    const where: Record<string, unknown> = {}
    if (status) where.status = status
    if (search) where.name = { contains: search.toLowerCase() }

    const domains = await db.domain.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        user: { select: { id: true, name: true, email: true } },
        _count: { select: { dnsRecords: true, logs: true } },
      },
    })

    return ok(
      domains.map((d) => ({
        id: d.id,
        name: d.name,
        status: d.status,
        registrar: d.registrar,
        provider: d.provider,
        registeredAt: d.registeredAt?.toISOString(),
        expiresAt: d.expiresAt?.toISOString(),
        autoRenew: d.autoRenew,
        whoisPrivacy: d.whoisPrivacy,
        locked: d.locked,
        premium: d.premium,
        owner: d.user,
        dnsRecordsCount: d._count.dnsRecords,
        logsCount: d._count.logs,
        createdAt: d.createdAt.toISOString(),
      })),
      `Retrieved ${domains.length} domains`
    )
  } catch (error) {
    console.error('[admin/domains GET] error:', error)
    return apiError.serverError()
  }
}
