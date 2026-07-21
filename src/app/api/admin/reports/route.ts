import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader, requireAdminRole } from '@/lib/auth'
import { db } from '@/lib/db'

/**
 * Billing reports: financial, subscription and customer metrics.
 *
 * All figures are derived from real rows (paid invoices, active subscriptions,
 * recorded payments) — nothing here is estimated or fabricated. Where a metric
 * genuinely can't be computed yet it is returned as 0 rather than invented.
 */
async function requireAdmin(request: Request): Promise<{
  decoded: { userId: string; email: string; role: string }
} | null> {
  // SECURITY: role comes from the database, not the 7-day token — see
  // verifyTokenFresh. Also rejects suspended/closed accounts.
  const decoded = await requireAdminRole(request)
  return decoded ? { decoded } : null
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
    const auth = await requireAdmin(request)
    if (!auth) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const days = Math.min(Math.max(Number(searchParams.get('days')) || 30, 1), 365)
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const now = new Date()

    const [subs, invoices, payments, refunds, planChangeLogs] = await Promise.all([
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
          id: true,
          amount: true,
          currency: true,
          status: true,
          method: true,
          metadata: true,
          createdAt: true,
          userId: true,
        },
      }),
      db.refund.findMany({
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: {
          id: true,
          invoiceId: true,
          userId: true,
          amount: true,
          currency: true,
          destination: true,
          reason: true,
          status: true,
          createdAt: true,
        },
      }),
      // Plan movement isn't stored on the subscription (it only holds the
      // CURRENT plan), so upgrade/downgrade history comes from the audit log.
      db.auditLog.findMany({
        where: {
          action: { in: ['subscription.change_plan', 'subscription.change_cycle'] },
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: {
          id: true,
          userId: true,
          resourceId: true,
          metadata: true,
          createdAt: true,
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

    // ── Refunds ──────────────────────────────────────────────────────
    // Refunds reduce net revenue, so reporting gross revenue alone overstates
    // what the business actually kept.
    const refundsInPeriod = refunds.filter(
      (r) => new Date(r.createdAt) >= since
    )
    const refundedAllTime = round2(
      refunds.reduce((s, r) => s + (r.amount || 0), 0)
    )
    const refundedPeriod = round2(
      refundsInPeriod.reduce((s, r) => s + (r.amount || 0), 0)
    )
    const refundsByDestination: Record<string, { count: number; amount: number }> = {}
    for (const r of refunds) {
      const d = r.destination || 'unknown'
      refundsByDestination[d] ||= { count: 0, amount: 0 }
      refundsByDestination[d].count++
      refundsByDestination[d].amount = round2(
        refundsByDestination[d].amount + (r.amount || 0)
      )
    }

    // ── Failed payments ──────────────────────────────────────────────
    const failedPayments = payments.filter((p) => p.status === 'failed')
    const failedInPeriod = failedPayments.filter(
      (p) => new Date(p.createdAt) >= since
    )
    const failedValuePeriod = round2(
      failedInPeriod.reduce((s, p) => s + (p.amount || 0), 0)
    )
    const attemptedInPeriod = payments.filter(
      (p) => new Date(p.createdAt) >= since
    )
    const failureRate =
      attemptedInPeriod.length > 0
        ? round2((failedInPeriod.length / attemptedInPeriod.length) * 100)
        : 0
    // Rejection reasons, where an admin recorded one.
    const failureReasons: Record<string, number> = {}
    for (const p of failedInPeriod) {
      let reason = 'Not specified'
      try {
        const m = p.metadata ? JSON.parse(p.metadata) : {}
        if (typeof m?.rejectionReason === 'string' && m.rejectionReason.trim()) {
          reason = m.rejectionReason.trim().slice(0, 120)
        }
      } catch {
        /* unparseable metadata just counts as unspecified */
      }
      failureReasons[reason] = (failureReasons[reason] || 0) + 1
    }

    // ── Plan movement (upgrades / downgrades) ────────────────────────
    let upgrades = 0
    let downgrades = 0
    let cycleChanges = 0
    let upgradeRevenue = 0
    let downgradeCredit = 0
    const planMovements: Array<Record<string, unknown>> = []
    for (const log of planChangeLogs) {
      let m: Record<string, unknown> = {}
      try {
        m = log.metadata ? JSON.parse(log.metadata) : {}
      } catch {
        m = {}
      }
      if (m.billingCycle) {
        cycleChanges++
        continue
      }
      const direction = String(m.direction || 'same')
      const proration = (m.proration || {}) as { netCharge?: number }
      const net = Number(proration.netCharge || 0)
      if (direction === 'upgrade') {
        upgrades++
        if (net > 0) upgradeRevenue = round2(upgradeRevenue + net)
      } else if (direction === 'downgrade') {
        downgrades++
        const credited = Number(m.creditIssued || 0)
        if (credited > 0) downgradeCredit = round2(downgradeCredit + credited)
      }
      planMovements.push({
        at: log.createdAt,
        subscriptionId: log.resourceId,
        direction,
        fromPlan: m.fromPlan ?? null,
        toPlan: m.toPlan ?? null,
        prorationNet: round2(net),
        creditIssued: m.creditIssued ?? null,
        invoiceNumber: m.invoiceNumber ?? null,
      })
    }

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
        // Gross revenue less refunds — what the business actually kept.
        refundedAllTime,
        refundedPeriod,
        netRevenueAllTime: round2(revenueAllTime - refundedAllTime),
        netRevenuePeriod: round2(revenuePeriod - refundedPeriod),
      },
      refunds: {
        countAllTime: refunds.length,
        countInPeriod: refundsInPeriod.length,
        amountAllTime: refundedAllTime,
        amountInPeriod: refundedPeriod,
        byDestination: Object.entries(refundsByDestination).map(
          ([destination, v]) => ({ destination, ...v })
        ),
        recent: refunds.slice(0, 20),
      },
      failedPayments: {
        countAllTime: failedPayments.length,
        countInPeriod: failedInPeriod.length,
        valueInPeriod: failedValuePeriod,
        attemptsInPeriod: attemptedInPeriod.length,
        failureRatePercent: failureRate,
        reasons: Object.entries(failureReasons)
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count),
      },
      planMovement: {
        upgrades,
        downgrades,
        cycleChanges,
        upgradeRevenue,
        downgradeCredit,
        netMoves: upgrades - downgrades,
        recent: planMovements.slice(0, 20),
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
