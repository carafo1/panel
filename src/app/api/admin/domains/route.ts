/**
 * GET /api/admin/domains
 * Admin-only. Lists all domains across all users with filters.
 * Query: ?status=active&search=example&limit=50
 *
 * Returns real domain records from the DB with owner, project link,
 * email-hosting flag, DNS record counts, nameservers, and a status
 * breakdown so the admin UI can render an accurate picture.
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
    const limit = Math.min(parseInt(searchParams.get('limit') || '500', 10), 500)

    const where: Record<string, unknown> = {}
    if (status) where.status = status
    if (search) where.name = { contains: search.toLowerCase() }

    const domains = await db.domain.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        user: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true, status: true, subdomain: true } },
        _count: { select: { dnsRecords: true, logs: true, orders: true, invoices: true } },
      },
    })

    // Build a status breakdown across ALL domains (ignores filters) so the
    // admin UI can show "X active / Y cancelled / Z deleted" regardless of
    // the current filter.
    const allRows = await db.domain.groupBy({
      by: ['status'],
      _count: { _all: true },
    })
    const breakdown: Record<string, number> = {}
    for (const r of allRows) breakdown[r.status] = r._count._all
    const totalCount = Object.values(breakdown).reduce((a, b) => a + b, 0)

    // Count how many ACTIVE domains have real hosting attached (email or
    // a linked project). This is the "X domains currently hosting" number.
    const activeWithHosting = await db.domain.count({
      where: {
        status: 'active',
        OR: [{ emailHosted: true }, { projectId: { not: null } }],
      },
    })

    return ok(
      {
        domains: domains.map((d) => ({
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
          emailHosted: d.emailHosted,
          transferStatus: d.transferStatus,
          externalId: d.externalId,
          nameservers: d.nameservers ? (JSON.parse(d.nameservers) as string[]) : [],
          owner: d.user,
          project: d.project
            ? {
                id: d.project.id,
                name: d.project.name,
                status: d.project.status,
                subdomain: d.project.subdomain,
              }
            : null,
          dnsRecordsCount: d._count.dnsRecords,
          logsCount: d._count.logs,
          ordersCount: d._count.orders,
          invoicesCount: d._count.invoices,
          createdAt: d.createdAt.toISOString(),
        })),
        breakdown: {
          total: totalCount,
          active: breakdown['active'] ?? 0,
          pending: breakdown['pending'] ?? 0,
          cancelled: breakdown['cancelled'] ?? 0,
          deleted: breakdown['deleted'] ?? 0,
          expired: breakdown['expired'] ?? 0,
          transferring: breakdown['transferring'] ?? 0,
          suspended: breakdown['suspended'] ?? 0,
          activeWithHosting,
        },
      },
      `Retrieved ${domains.length} domains`
    )
  } catch (error) {
    console.error('[admin/domains GET] error:', error)
    return apiError.serverError()
  }
}
