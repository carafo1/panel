/**
 * GET /api/admin/domains
 * Admin-only. Lists ALL domains in the Dynadot account by making REAL API
 * calls, then syncing the result into the local DB.
 *
 * Two Dynadot API calls are made on every request (when sync=true, default):
 *
 *   1. `list_domain`  — completed/registered domains (MainDomains + DeletedDomains)
 *   2. `order_list` + `get_transfer_status` — domains currently being
 *      transferred IN (these do NOT appear in list_domain until the transfer
 *      completes). Each is upserted with status "transferring".
 *
 * Query:
 *   ?status=active&search=example&limit=500&sync=true
 *
 * - `sync=true` (default) forces fresh Dynadot API calls and upserts real
 *   domains + transfers into the DB before returning.
 * - `sync=false` skips the live API calls and returns whatever is in the DB.
 *
 * Fake / demo domains (externalId starting with "demo-order-" or registrar
 * "openprovider") are PURGED during sync so the list only ever shows real,
 * Dynadot data.
 */
import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db'
import { ok, apiError } from '@/lib/api-response'
import {
  listDomains,
  listTransferOrders,
  type ListedDomain,
  type TransferOrder,
} from '@/lib/dynadot'

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

/**
 * Map a Dynadot transfer status (from get_transfer_status) to our internal
 * Domain.transferStatus field. The domain.status is set to "transferring"
 * for any in-progress transfer.
 */
function mapTransferStatus(t: TransferOrder): {
  status: string
  transferStatus: string
} {
  const raw = t.status.toLowerCase().trim()
  // Completed transfers mean the domain is now registered — but if it's still
  // in the order_list with a transfer item, we treat it as transferring until
  // it shows up in list_domain.
  if (raw === 'completed' || raw === 'complete' || raw === 'success') {
    return { status: 'transferring', transferStatus: 'completed' }
  }
  if (raw === 'cancelled' || raw === 'canceled' || raw === 'failed') {
    return { status: 'transferring', transferStatus: 'failed' }
  }
  if (raw === 'waiting' || raw === 'pending' || raw === 'transfer pending') {
    return { status: 'transferring', transferStatus: 'pending' }
  }
  return { status: 'transferring', transferStatus: raw || 'pending' }
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
    let transfersCount = 0
    let transfers: TransferOrder[] = []

    if (wantSync) {
      try {
        // Find a system admin user to attribute newly-discovered domains to.
        // If none exists, fall back to the requesting admin.
        const ownerUser =
          (await db.user.findFirst({
            where: { role: { in: ['super_admin', 'admin'] } },
            orderBy: { createdAt: 'asc' },
          })) || user

        // ── 1. Registered domains (list_domain) ──────────────────────────
        const { main, deleted } = await listDomains()

        const realNames = new Set<string>()
        for (const d of main) realNames.add(d.name)
        for (const d of deleted) realNames.add(d.name)

        // PURGE fake / demo domains that are NOT in the real Dynadot list.
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
          if (!realNames.has(s.name)) {
            await db.domain.delete({ where: { id: s.id } }).catch(() => {})
            purgedCount++
          }
        }

        // UPSERT every real Dynadot domain into the DB.
        const upsertOne = async (d: ListedDomain, isDeleted: boolean) => {
          const st = isDeleted ? 'deleted' : mapDynadotStatus(d.status)
          const existing = await db.domain.findUnique({ where: { name: d.name } })
          if (existing) {
            await db.domain.update({
              where: { id: existing.id },
              data: {
                status: st,
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
            await db.domain.create({
              data: {
                name: d.name,
                status: st,
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

        // ── 2. Pending transfers (order_list + get_transfer_status) ──────
        // These domains are NOT in list_domain yet because the transfer
        // hasn't completed. We upsert them with status "transferring" so they
        // appear in the admin list immediately.
        transfers = await listTransferOrders()
        for (const t of transfers) {
          const { status: st, transferStatus } = mapTransferStatus(t)
          const existing = await db.domain.findUnique({
            where: { name: t.domain },
          })
          if (existing) {
            // Only overwrite status if the transfer is still pending — once
            // it completes, list_domain will set the real "active" status.
            if (transferStatus === 'pending' || transferStatus === 'failed') {
              await db.domain.update({
                where: { id: existing.id },
                data: {
                  status: st,
                  transferStatus,
                  externalId: t.orderId,
                  registrar: 'dynadot',
                  provider: 'dynadot',
                },
              })
            }
          } else {
            await db.domain.create({
              data: {
                name: t.domain,
                status: st,
                transferStatus,
                externalId: t.orderId,
                registrar: 'dynadot',
                provider: 'dynadot',
                userId: ownerUser.id,
                registeredAt: t.submittedDate
                  ? new Date(t.submittedDate.replace(/\//g, '-'))
                  : new Date(),
              },
            })
          }
          transfersCount++
        }
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

    // Build a quick lookup of live transfer detail (for the response).
    const transferMap = new Map<string, TransferOrder>()
    for (const t of transfers) transferMap.set(t.domain, t)

    return ok(
      {
        domains: domains.map((d) => {
          const liveTransfer = transferMap.get(d.name)
          return {
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
            // Live transfer detail straight from Dynadot (only present when
            // this domain is currently being transferred).
            transferDetail: liveTransfer
              ? {
                  orderId: liveTransfer.orderId,
                  status: liveTransfer.status,
                  failedReason: liveTransfer.failedReason,
                  transferType: liveTransfer.transferType,
                  submittedDate: liveTransfer.submittedDate,
                  cost: liveTransfer.cost,
                  paymentMethod: liveTransfer.paymentMethod,
                }
              : null,
          }
        }),
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
          transfers: transfersCount,
          error: syncError,
          source: 'dynadot_api',
        },
      },
      syncError
        ? `Retrieved ${domains.length} domains (sync partial: ${syncError})`
        : `Retrieved ${domains.length} domains (${syncedCount} registered, ${transfersCount} transferring, ${purgedCount} purged)`
    )
  } catch (error) {
    console.error('[admin/domains GET] error:', error)
    return apiError.serverError()
  }
}
