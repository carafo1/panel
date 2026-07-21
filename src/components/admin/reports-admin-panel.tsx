'use client'

/**
 * Billing reports dashboard.
 *
 * Every figure comes from real rows (paid invoices, active subscriptions,
 * recorded payments). Where something genuinely has no data yet it shows 0 —
 * nothing here is estimated.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { apiFetch as baseApiFetch } from '@/store/auth-store'
import { Loader2, RefreshCw } from 'lucide-react'

// Delegate to the shared client — see billing-admin-panel for why.
async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return (await baseApiFetch(path, init)) as T
}

interface ReportData {
  periodDays: number
  financial: {
    mrr: number
    arr: number
    revenueAllTime: number
    revenuePeriod: number
    taxCollected: number
    discountsGiven: number
    outstanding: number
    outstandingCount: number
    overdueCount: number
    lifetimeSubsExcludedFromMrr: number
    refundedAllTime: number
    refundedPeriod: number
    netRevenueAllTime: number
    netRevenuePeriod: number
  }
  refunds: {
    countAllTime: number
    countInPeriod: number
    amountAllTime: number
    amountInPeriod: number
    byDestination: Array<{ destination: string; count: number; amount: number }>
  }
  failedPayments: {
    countAllTime: number
    countInPeriod: number
    valueInPeriod: number
    attemptsInPeriod: number
    failureRatePercent: number
    reasons: Array<{ reason: string; count: number }>
  }
  planMovement: {
    upgrades: number
    downgrades: number
    cycleChanges: number
    upgradeRevenue: number
    downgradeCredit: number
    netMoves: number
    recent: Array<{
      at: string
      direction: string
      fromPlan: string | null
      toPlan: string | null
      prorationNet: number
      invoiceNumber: string | null
    }>
  }
  subscriptions: {
    total: number
    byStatus: Record<string, number>
    active: number
    newInPeriod: number
    cancelledInPeriod: number
    churnRatePercent: number
    expiringNext7Days: number
  }
  gateways: Array<{
    gateway: string
    total: number
    completed: number
    failed: number
    pending: number
    volume: number
    successRate: number
  }>
  topCustomers: Array<{
    userId: string
    name: string | null
    email: string
    lifetimeValue: number
  }>
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'good' | 'warn' | 'bad'
}) {
  const color =
    tone === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : tone === 'bad'
          ? 'text-red-600 dark:text-red-400'
          : ''
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function ReportsAdminPanel() {
  const [data, setData] = useState<ReportData | null>(null)
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await apiFetch<ReportData>(`/admin/reports?days=${days}`))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load reports')
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => {
    load()
  }, [load])

  const money = (n: number) => `$${Number(n || 0).toFixed(2)}`

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold">Reports</h3>
          <p className="text-sm text-muted-foreground">
            Revenue, subscriptions and gateway performance.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {[7, 30, 90, 365].map((d) => (
            <Button
              key={d}
              size="sm"
              variant={days === d ? 'default' : 'outline'}
              onClick={() => setDays(d)}
            >
              {d}d
            </Button>
          ))}
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
          </Button>
        </div>
      </div>

      {!data ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {loading ? 'Loading…' : 'No report data.'}
        </p>
      ) : (
        <div className="space-y-5">
          {/* Recurring revenue */}
          <div>
            <p className="mb-2 text-sm font-medium">Recurring revenue</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="MRR"
                value={money(data.financial.mrr)}
                hint="Active subs normalised to a month"
                tone="good"
              />
              <Stat label="ARR" value={money(data.financial.arr)} hint="MRR × 12" />
              <Stat
                label={`Revenue (${data.periodDays}d)`}
                value={money(data.financial.revenuePeriod)}
                hint="Invoices paid in period"
              />
              <Stat
                label="Revenue (all time)"
                value={money(data.financial.revenueAllTime)}
              />
            </div>
            {data.financial.lifetimeSubsExcludedFromMrr > 0 && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {data.financial.lifetimeSubsExcludedFromMrr} lifetime
                subscription(s) excluded from MRR — they aren&apos;t recurring.
              </p>
            )}
          </div>

          {/* Cash position */}
          <div>
            <p className="mb-2 text-sm font-medium">Cash position</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Outstanding"
                value={money(data.financial.outstanding)}
                hint={`${data.financial.outstandingCount} unpaid invoice(s)`}
                tone={data.financial.outstanding > 0 ? 'warn' : undefined}
              />
              <Stat
                label="Overdue"
                value={String(data.financial.overdueCount)}
                hint="Unpaid past the period"
                tone={data.financial.overdueCount > 0 ? 'bad' : undefined}
              />
              <Stat
                label="Tax collected"
                value={money(data.financial.taxCollected)}
                hint="On paid invoices"
              />
              <Stat
                label="Discounts given"
                value={money(data.financial.discountsGiven)}
                hint="Coupon value redeemed"
              />
            </div>
          </div>

          {/* Subscriptions */}
          <div>
            <p className="mb-2 text-sm font-medium">Subscriptions</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Stat label="Active" value={String(data.subscriptions.active)} tone="good" />
              <Stat
                label={`New (${data.periodDays}d)`}
                value={String(data.subscriptions.newInPeriod)}
              />
              <Stat
                label={`Cancelled (${data.periodDays}d)`}
                value={String(data.subscriptions.cancelledInPeriod)}
                tone={data.subscriptions.cancelledInPeriod > 0 ? 'warn' : undefined}
              />
              <Stat
                label="Churn rate"
                value={`${data.subscriptions.churnRatePercent}%`}
                tone={data.subscriptions.churnRatePercent > 5 ? 'bad' : undefined}
              />
              <Stat
                label="Expiring ≤7d"
                value={String(data.subscriptions.expiringNext7Days)}
                tone={data.subscriptions.expiringNext7Days > 0 ? 'warn' : undefined}
              />
            </div>
            {Object.keys(data.subscriptions.byStatus).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(data.subscriptions.byStatus).map(([s, n]) => (
                  <Badge key={s} variant="outline">
                    {s}: {n}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Refunds — gross revenue alone overstates what was kept. */}
          <div>
            <p className="mb-2 text-sm font-medium">Refunds &amp; net revenue</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label={`Refunded (${data.periodDays}d)`}
                value={money(data.refunds.amountInPeriod)}
                hint={`${data.refunds.countInPeriod} refund(s)`}
                tone={data.refunds.amountInPeriod > 0 ? 'warn' : undefined}
              />
              <Stat
                label="Refunded (all time)"
                value={money(data.refunds.amountAllTime)}
                hint={`${data.refunds.countAllTime} refund(s)`}
              />
              <Stat
                label={`Net revenue (${data.periodDays}d)`}
                value={money(data.financial.netRevenuePeriod)}
                hint="Paid less refunded"
                tone="good"
              />
              <Stat
                label="Net revenue (all time)"
                value={money(data.financial.netRevenueAllTime)}
                tone="good"
              />
            </div>
            {data.refunds.byDestination.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {data.refunds.byDestination.map((d) => (
                  <Badge key={d.destination} variant="secondary">
                    {d.destination}: {money(d.amount)} ({d.count})
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Failed payments — the leading indicator of involuntary churn. */}
          <div>
            <p className="mb-2 text-sm font-medium">Failed payments</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label={`Failures (${data.periodDays}d)`}
                value={String(data.failedPayments.countInPeriod)}
                hint={`of ${data.failedPayments.attemptsInPeriod} attempt(s)`}
                tone={data.failedPayments.countInPeriod > 0 ? 'bad' : 'good'}
              />
              <Stat
                label="Failure rate"
                value={`${data.failedPayments.failureRatePercent}%`}
                hint="Attempts that failed"
                tone={
                  data.failedPayments.failureRatePercent > 10 ? 'bad' : undefined
                }
              />
              <Stat
                label="Value at risk"
                value={money(data.failedPayments.valueInPeriod)}
                hint="Money that didn't land"
                tone={data.failedPayments.valueInPeriod > 0 ? 'warn' : undefined}
              />
              <Stat
                label="Failures (all time)"
                value={String(data.failedPayments.countAllTime)}
              />
            </div>
            {data.failedPayments.reasons.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {data.failedPayments.reasons.map((r) => (
                  <Badge key={r.reason} variant="outline">
                    {r.reason} × {r.count}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Plan movement — reconstructed from the audit log, since the
              subscription row only ever holds the CURRENT plan. */}
          <div>
            <p className="mb-2 text-sm font-medium">
              Plan movement ({data.periodDays}d)
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Upgrades"
                value={String(data.planMovement.upgrades)}
                hint={`${money(data.planMovement.upgradeRevenue)} pro-rated`}
                tone={data.planMovement.upgrades > 0 ? 'good' : undefined}
              />
              <Stat
                label="Downgrades"
                value={String(data.planMovement.downgrades)}
                hint={`${money(data.planMovement.downgradeCredit)} credited back`}
                tone={data.planMovement.downgrades > 0 ? 'warn' : undefined}
              />
              <Stat
                label="Net movement"
                value={
                  data.planMovement.netMoves > 0
                    ? `+${data.planMovement.netMoves}`
                    : String(data.planMovement.netMoves)
                }
                hint="Upgrades less downgrades"
                tone={
                  data.planMovement.netMoves > 0
                    ? 'good'
                    : data.planMovement.netMoves < 0
                      ? 'bad'
                      : undefined
                }
              />
              <Stat
                label="Cycle changes"
                value={String(data.planMovement.cycleChanges)}
                hint="e.g. monthly → annual"
              />
            </div>
            {data.planMovement.recent.length > 0 && (
              <div className="mt-2 overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs">
                    <tr>
                      <th className="p-2 text-left">When</th>
                      <th className="p-2 text-left">Change</th>
                      <th className="p-2 text-left">Move</th>
                      <th className="p-2 text-right">Pro-rated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.planMovement.recent.map((m, i) => (
                      <tr key={i} className="border-t">
                        <td className="p-2 text-xs text-muted-foreground">
                          {new Date(m.at).toLocaleDateString()}
                        </td>
                        <td className="p-2">
                          <Badge
                            variant={
                              m.direction === 'upgrade' ? 'default' : 'secondary'
                            }
                          >
                            {m.direction}
                          </Badge>
                        </td>
                        <td className="p-2 text-xs">
                          {m.fromPlan || '—'} → {m.toPlan || '—'}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {money(m.prorationNet)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Gateways */}
          <div>
            <p className="mb-2 text-sm font-medium">Payment gateways</p>
            {data.gateways.length === 0 ? (
              <p className="text-sm text-muted-foreground">No payments recorded yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-left">
                      <th className="p-2 font-medium">Gateway</th>
                      <th className="p-2 font-medium">Volume</th>
                      <th className="p-2 font-medium">Completed</th>
                      <th className="p-2 font-medium">Pending</th>
                      <th className="p-2 font-medium">Failed</th>
                      <th className="p-2 font-medium">Success rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.gateways.map((g) => (
                      <tr key={g.gateway} className="border-t">
                        <td className="p-2 capitalize">{g.gateway}</td>
                        <td className="p-2 tabular-nums">{money(g.volume)}</td>
                        <td className="p-2 tabular-nums">{g.completed}</td>
                        <td className="p-2 tabular-nums">{g.pending}</td>
                        <td className="p-2 tabular-nums">{g.failed}</td>
                        <td className="p-2 tabular-nums">{g.successRate}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Top customers */}
          <div>
            <p className="mb-2 text-sm font-medium">Top customers by lifetime value</p>
            {data.topCustomers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No paid invoices yet.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-left">
                      <th className="p-2 font-medium">Customer</th>
                      <th className="p-2 font-medium">Lifetime value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topCustomers.map((c) => (
                      <tr key={c.userId} className="border-t">
                        <td className="p-2">
                          <div className="font-medium">{c.name || '—'}</div>
                          <div className="text-xs text-muted-foreground">
                            {c.email}
                          </div>
                        </td>
                        <td className="p-2 tabular-nums font-medium">
                          {money(c.lifetimeValue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
