/**
 * GET /api/admin/domains
 * Admin-only. Lists ALL domains registered in the Dynadot account by making a
 * REAL `list_domain` API call, then syncing the result into the local DB.
 *
 * Query:
 *   ?status=active&search=example&limit=500&sync=true
 *
 * - `sync=true` (default) forces a fresh call to Dynadot's list_domain API and
 *   upserts the real domains into the DB before returning.
 * - `sync=false` skips the live API call and returns whatever is in the DB.
 *
 * Fake / demo domains (externalId starting with "demo-order-" or registrar
 * "openprovider") are PURGED during sync so the list only ever shows real,
 * Dynadot-registered domains.
 *
 * Returns each domain with owner, project link, email-hosting flag, DNS record
 * counts, nameservers, and a status breakdown.
 */
import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db'
import { ok, apiError } from '@/lib/api-response'
import { listDomains, type ListedDomain } from '@/lib/dynadot'

/**
 * Map a Dynadot domain status string to our internal Domain.status enum.
 * Dynadot statuses: active, expired, deleted, transfer, locked, etc.
 */
function mapDynadotStatus(raw: string): string {
  const s = raw.toLowerCase().trim()
  if (s === 'active' || s === 'live') return 'active'
  if (s === 'expired') return 'expired'
  if (s === 'deleted' || s === 'delete') return 'deleted'
  if (s.startsWith('transfer')) return 'transferring'
  if (s === 'locked' || s === 'suspend' || s === 'suspended') return 'suspended'
  if (s === 'parked') return 'active'
  // Unknown statuses default to active so the domain still shows up.
  return 'active'
}

export async function GET(request: Request) {
  const user = await authenticateRequest(request)
  if (!user) return apiError.unauthorized()
  if (user.role !== 'admin' && user.role !== 'super_admin')
    return apiError.forbidden(`Admin access required`)

  try {
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const search = searchParams.get('search')
    const limit = Math.min(parseInt(searchParams.get('limit') || '500', 10), 500)
    const wantSync = searchParams.get('sync') !== 'false' // default: sync

    let syncError: string | undefined
    let syncedCount = 0
    let purgedCount = 0

    if (wantSync) {
      try {
        const { main, deleted } = await listDomains()

        // Find a system admin user to attribute newly-discovered domains to.
        // If none exists, fall back to the requesting admin.
        let ownerUser =
          (await db.user.findFirst({
            where: { role: { in: ['super_admin', 'admin'] } },
            orderBy: { createdAt: 'asc' },
          })) || user

        const realNames = new Set<string>()
        for (const d of main) realNames.add(d.name)
        for (const d of deleted) realNames.add(d.name)

        // 1) PURGE fake / demo domains that are NOT in the real Dynadot list.
        //    These were created during earlier demo-mode testing and are not
        //    real registrations.
        const stale = await db.domain.findMany({
          where: {
            OR: [
              { externalId: { startsWith: 'demo-order-' } },
              { registrar: 'openprovider' },
              { provider: 'apsamo-demo' },
            ],
          },
          select: { id: true, name: true },
        })
        for (const s of stale) {
          // Only purge if the name is not a real Dynadot domain.
          if (!realNames.has(s.name)) {
            await db.domain.delete({ where: { id: s.id } }).catch(() => {})
            purgedCount++
          }
        }

        // 2) UPSERT every real Dynadot domain into the DB.
        const upsertOne = async (d: ListedDomain, isDeleted: boolean) => {
          const status = isDeleted ? 'deleted' : mapDynadotStatus(d.status)
          const existing = await db.domain.findUnique({ where: { name: d.name } })
          if (existing) {
            // Update real fields from Dynadot.
            await db.domain.update({
              where: { id: existing.id },
              data: {
                status,
                registrar: 'dynadot',
                provider: 'dynadot',
                registeredAt: d.registeredAt
                  ? new Date(d.registeredAt)
                  : existing.registeredAt,
                expiresAt: d.expiresAt ? new Date(d.expiresAt) : existing.expiresAt,
                autoRenew: d.autoRenew,
                locked: d.locked,
                premium: d.premium,
                whoisPrivacy: d.whoisPrivacy,
              },
            })
          } else {
            // New real domain discovered in Dynadot — create it.
            await db.domain.create({
              data: {
                name: d.name,
                status,
                registrar: 'dynadot',
                provider: 'dynadot',
                userId: ownerUser.id,
                registeredAt: d.registeredAt ? new Date(d.registeredAt) : new Date(),
                expiresAt: d.expiresAt ? new Date(d.expiresAt) : null,
                autoRenew: d.autoRenew,
                locked: d.locked,
                premium: d.premium,
                whoisPrivacy: d.whoisPrivacy,
              },
            })
          }
          syncedCount++
        }

        for (const d of main) await upsertOne(d, false)
        for (const d of deleted) await upsertOne(d, true)
      } catch (err) {
        syncError = (err as Error).message
        // Fall through to return whatever is in the DB.
      }
    }

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
        _count: {
          select: { dnsRecords: true, logs: true, orders: true, invoices: true },
        },
      },
    })

    // Build a status breakdown across ALL domains (ignores filters).
    const allRows = await db.domain.groupBy({
      by: ['status'],
      _count: { _all: true },
    })
    const breakdown: Record<string, number> = {}
    for (const r of allRows) breakdown[r.status] = r._count._all
    const totalCount = Object.values(breakdown).reduce((a, b) => a + b, 0)

    // Count how many ACTIVE domains have real hosting attached.
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
          nameservers: d.nameservers
            ? (JSON.parse(d.nameservers) as string[])
            : [],
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
        sync: {
          synced: syncedCount,
          purged: purgedCount,
          error: syncError,
          source: 'dynadot_api',
        },
      },
      syncError
        ? `Retrieved ${domains.length} domains (sync skipped: ${syncError})`
        : `Retrieved ${domains.length} domains (synced ${syncedCount}, purged ${purgedCount})`
    )
  } catch (error) {
    console.error('[admin/domains GET] error:', error)
    return apiError.serverError()
  }
}
