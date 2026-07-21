import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { db } from '@/lib/db'

/**
 * Billing reports: financial, subscription and customer metrics.
 *
 * All figures are derived from real rows (paid invoices, active subscriptions,
 * recorded payments) — nothing here is estimated or fabricated. Where a metric
 * genuinely can't be computed yet it is returned as 0 rather than invented.
 */
function requireAdmin(request: Request): {
  decoded: { userId: string; email: string; role: string }
} | null {
  const token = extractTokenFromHeader(request.headers.get('Authorization'))
  if (!token) return null
  const decoded = verifyToken(token)
  if (!decoded) return null
  if (decoded.role !== 'super_admin' && decoded.role !== 'admin') return null
  return { decoded }
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

/** How many months one billing cycle represents (for MRR normalisation). */
function cycleMonths(billingCycle: string): number | null {
  switch ((billingCycle || 'monthly').toLowerCase()) {
    case 'monthly':
      return 1
    case 'quarterly':
      return 3
    case 'annual':
      return 12
    case 'biennial':
      return 24
    case 'lifetime':
      return null // excluded from recurring revenue
    default:
      return 1
  }
}

/** GET /api/admin/reports?days=30 */
export async function GET(request: Request) {
  try {
    const auth = requireAdmin(request)
    if (!auth) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const days = Math.min(Math.max(Number(searchParams.get('days')) || 30, 1), 365)
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const now = new Date()

    const [subs, invoices, payments] = await Promise.all([
      db.subscription.findMany({
        include: { plan: { select: { price: true, billingCycle: true, name: true } } },
      }),
      db.invoice.findMany({
        select: {
          total: true,
          tax: true,
          discount: true,
          status: true,
          paidAt: true,
          createdAt: true,
          currency: true,
          userId: true,
        },
      }),
      db.payment.findMany({
        select: {
          amount: true,
          status: true,
          method: true,
          createdAt: true,
          userId: true,
        },
      }),
    ])

    // ── Recurring revenue ────────────────────────────────────────────
    // MRR = sum of each ACTIVE subscription's price normalised to a month.
    // Lifetime plans are excluded — they aren't recurring revenue.
    let mrr = 0
    let lifetimeExcluded = 0
    for (const s of subs) {
      if (s.status !== 'active' && s.status !== 'trialing') continue
      const months = cycleMonths(
        (s.plan as { billingCycle?: string })?.billingCycle || 'monthly'
      )
      if (months === null) {
        lifetimeExcluded++
        continue
      }
      mrr += (s.plan?.price || 0) / months
    }
    mrr = round2(mrr)

    // ── Invoice-derived money ────────────────────────────────────────
    const paidInvoices = invoices.filter((i) => i.status === 'paid')
    const paidInPeriod = paidInvoices.filter(
      (i) => i.paidAt && new Date(i.paidAt) >= since
    )
    const revenueAllTime = round2(
      paidInvoices.reduce((s, i) => s + (i.total || 0), 0)
    )
    const revenuePeriod = round2(
      paidInPeriod.reduce((s, i) => s + (i.total || 0), 0)
    )
    const taxCollected = round2(
      paidInvoices.reduce((s, i) => s + (i.tax || 0), 0)
    )
    const discountsGiven = round2(
      paidInvoices.reduce((s, i) => s + (i.discount || 0), 0)
    )
    const unpaid = invoices.filter((i) => i.status === 'unpaid')
    const outstanding = round2(unpaid.reduce((s, i) => s + (i.total || 0), 0))
    const overdue = unpaid.filter(
      (i) => i.createdAt && new Date(i.createdAt) < since
    ).length

    // ── Subscription health ──────────────────────────────────────────
    const byStatus: Record<string, number> = {}
    for (const s of subs) byStatus[s.status] = (byStatus[s.status] || 0) + 1

    const newSubs = subs.filter((s) => new Date(s.createdAt) >= since).length
    const cancelledInPeriod = subs.filter(
      (s) =>
        s.status === 'cancelled' &&
        s.updatedAt &&
        new Date(s.updatedAt) >= since
    ).length
    const activeCount = (byStatus.active || 0) + (byStatus.trialing || 0)
    // Churn = cancellations in the period / (active at end + those cancellations).
    const churnBase = activeCount + cancelledInPeriod
    const churnRate = churnBase > 0 ? round2((cancelledInPeriod / churnBase) * 100) : 0

    const expiringSoon = subs.filter((s) => {
      if (s.status !== 'active') return false
      const end = new Date(s.currentPeriodEnd).getTime()
      return end > now.getTime() && end <= now.getTime() + 7 * 24 * 60 * 60 * 1000
    }).length

    // ── Gateway performance ──────────────────────────────────────────
    const gateways: Record<
      string,
      { total: number; completed: number; failed: number; pending: number; volume: number }
    > = {}
    for (const p of payments) {
      const g = p.method || 'unknown'
      gateways[g] ||= { total: 0, completed: 0, failed: 0, pending: 0, volume: 0 }
      gateways[g].total++
      if (p.status === 'completed') {
        gateways[g].completed++
        gateways[g].volume = round2(gateways[g].volume + (p.amount || 0))
      } else if (p.status === 'failed') gateways[g].failed++
      else if (p.status === 'pending') gateways[g].pending++
    }
    const gatewayRows = Object.entries(gateways).map(([name, g]) => ({
      gateway: name,
      ...g,
      successRate: g.total > 0 ? round2((g.completed / g.total) * 100) : 0,
    }))

    // ── Top customers by lifetime value ──────────────────────────────
    const ltvByUser: Record<string, number> = {}
    for (const i of paidInvoices) {
      ltvByUser[i.userId] = round2((ltvByUser[i.userId] || 0) + (i.total || 0))
    }
    const topIds = Object.entries(ltvByUser)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
    const topUsers = topIds.length
      ? await db.user.findMany({
          where: { id: { in: topIds.map(([id]) => id) } },
          select: { id: true, name: true, email: true },
        })
      : []
    const topCustomers = topIds.map(([id, value]) => {
      const u = topUsers.find((x) => x.id === id)
      return { userId: id, name: u?.name || null, email: u?.email || '—', lifetimeValue: value }
    })

    return NextResponse.json({
      periodDays: days,
      financial: {
        mrr,
        arr: round2(mrr * 12),
        revenueAllTime,
        revenuePeriod,
        taxCollected,
        discountsGiven,
        outstanding,
        outstandingCount: unpaid.length,
        overdueCount: overdue,
        lifetimeSubsExcludedFromMrr: lifetimeExcluded,
      },
      subscriptions: {
        total: subs.length,
        byStatus,
        active: activeCount,
        newInPeriod: newSubs,
        cancelledInPeriod,
        churnRatePercent: churnRate,
        expiringNext7Days: expiringSoon,
      },
      gateways: gatewayRows,
      topCustomers,
    })
  } catch (error) {
    console.error('[admin/reports] GET failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
