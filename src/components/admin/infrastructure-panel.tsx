'use client'

/**
 * Super-admin infrastructure overview.
 *
 * Shows what the SERVERS are doing and what the BUSINESS looks like. It
 * deliberately contains no customer plan quotas: a plan's "10 GB" is a billing
 * entitlement for one customer, and putting it beside real host metrics is
 * what made the old dashboard misleading. Quotas appear only when managing a
 * specific subscription.
 *
 * Anything that could not be measured renders as "—", never as 0 — an
 * unreachable server must not look like an idle, healthy one.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import {
  Loader2,
  RefreshCw,
  Server,
  Cpu,
  MemoryStick,
  HardDrive,
  Boxes,
  Users,
  Wallet,
  FileWarning,
  UserX,
  AlertTriangle,
} from 'lucide-react'

interface ServerRow {
  id: string
  name: string
  ip: string | null
  status: string
  demo: boolean
  error: string | null
  cpuPercent: number | null
  cpuCores: number
  ramUsedMB: number | null
  ramTotalMB: number
  ramPercent: number | null
  diskPercent: number | null
  diskSize: string
  diskUsed: string
  containers: number
  load1: number
  uptime: string
}

interface InfraResponse {
  infrastructure: {
    totalServers: number
    reachableServers: number
    unreachableServers: number
    avgCpuPercent: number | null
    avgDiskPercent: number | null
    totalCores: number
    totalRamMB: number
    usedRamMB: number
    ramPercent: number | null
    runningContainers: number
    measuredAt: string
  }
  servers: ServerRow[]
  business: {
    customers: number
    suspendedAccounts: number
    hostingAccounts: number
    runningProjects: number
    totalDomains: number
    activeSubscriptions: number
    pastDueSubscriptions: number
    suspendedSubscriptions: number
    monthlyRevenue: number
    pendingInvoices: number
    outstandingAmount: number
    overdueInvoices: number
  }
}

const gb = (mb: number) => (mb / 1024).toFixed(1)
const money = (n: number) => `$${Number(n || 0).toFixed(2)}`

function barTone(pct: number) {
  return pct > 85 ? 'bg-red-500' : pct > 65 ? 'bg-amber-500' : 'bg-emerald-500'
}

/** A measured metric. `value === null` means "not measured" and shows "—". */
function Metric({
  icon: Icon,
  label,
  value,
  sub,
  percent,
}: {
  icon: React.ElementType
  label: string
  value: string | null
  sub?: string
  percent?: number | null
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value ?? '—'}</p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
      {percent != null && (
        <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full ${barTone(percent)} transition-all duration-700`}
            style={{ width: `${Math.min(percent, 100)}%` }}
          />
        </div>
      )}
    </div>
  )
}

export function InfrastructurePanel() {
  const [data, setData] = useState<InfraResponse | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await apiFetch<InfraResponse>('/admin/infrastructure'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load infrastructure')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    // Host metrics are measured live over SSH; refresh on an interval so the
    // page reflects the server rather than a snapshot from page-load.
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [load])

  const infra = data?.infrastructure
  const biz = data?.business

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold">Infrastructure</h3>
          <p className="text-sm text-muted-foreground">
            Live server metrics and platform totals. Customer plan limits are not shown here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {infra && (
            <span className="text-[11px] text-muted-foreground">
              measured {new Date(infra.measuredAt).toLocaleTimeString()}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </Button>
        </div>
      </div>

      {!data ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {loading ? 'Measuring servers…' : 'No infrastructure data.'}
        </p>
      ) : (
        <>
          {infra!.unreachableServers > 0 && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-3">
              <p className="flex items-center gap-1.5 text-sm font-medium text-red-600 dark:text-red-400">
                <AlertTriangle className="size-4" />
                {infra!.unreachableServers} server(s) unreachable — their metrics are excluded
                from the averages below rather than counted as zero.
              </p>
            </div>
          )}

          {/* ── Real host measurements ────────────────────────────────── */}
          <div>
            <p className="mb-2 text-sm font-medium">Server resources</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Metric
                icon={Server}
                label="Servers"
                value={String(infra!.totalServers)}
                sub={`${infra!.reachableServers} reachable`}
              />
              <Metric
                icon={Cpu}
                label="CPU (avg)"
                value={infra!.avgCpuPercent == null ? null : `${infra!.avgCpuPercent}%`}
                sub={`${infra!.totalCores} cores total`}
                percent={infra!.avgCpuPercent}
              />
              <Metric
                icon={MemoryStick}
                label="Memory"
                value={infra!.ramPercent == null ? null : `${infra!.ramPercent}%`}
                sub={`${gb(infra!.usedRamMB)} / ${gb(infra!.totalRamMB)} GB`}
                percent={infra!.ramPercent}
              />
              <Metric
                icon={HardDrive}
                label="Disk (avg)"
                value={infra!.avgDiskPercent == null ? null : `${infra!.avgDiskPercent}%`}
                percent={infra!.avgDiskPercent}
              />
              <Metric
                icon={Boxes}
                label="Containers"
                value={String(infra!.runningContainers)}
                sub="running"
              />
            </div>
          </div>

          {/* ── Per-server breakdown ──────────────────────────────────── */}
          <div>
            <p className="mb-2 text-sm font-medium">Servers</p>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs">
                  <tr>
                    <th className="p-2 text-left">Server</th>
                    <th className="p-2 text-right">CPU</th>
                    <th className="p-2 text-right">RAM</th>
                    <th className="p-2 text-right">Disk</th>
                    <th className="p-2 text-right">Containers</th>
                    <th className="p-2 text-right">Uptime</th>
                  </tr>
                </thead>
                <tbody>
                  {data.servers.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-6 text-center text-muted-foreground">
                        No servers registered.
                      </td>
                    </tr>
                  ) : (
                    data.servers.map((s) => (
                      <tr key={s.id} className="border-t">
                        <td className="p-2">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium">{s.name}</span>
                            {s.demo && <Badge variant="outline" className="text-[10px]">demo</Badge>}
                            {s.error && (
                              <Badge variant="outline" className="text-[10px] border-red-500/50 text-red-600">
                                unreachable
                              </Badge>
                            )}
                          </div>
                          {s.ip && <p className="text-[11px] text-muted-foreground">{s.ip}</p>}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {s.cpuPercent == null ? '—' : `${s.cpuPercent}%`}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {s.ramPercent == null
                            ? '—'
                            : `${s.ramPercent}% (${gb(s.ramUsedMB ?? 0)}/${gb(s.ramTotalMB)}G)`}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {s.diskPercent == null ? '—' : `${s.diskPercent}% (${s.diskUsed}/${s.diskSize})`}
                        </td>
                        <td className="p-2 text-right tabular-nums">{s.error ? '—' : s.containers}</td>
                        <td className="p-2 text-right text-xs text-muted-foreground">{s.uptime}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Business totals (row counts, not quotas) ──────────────── */}
          <div>
            <p className="mb-2 text-sm font-medium">Platform</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric
                icon={Users}
                label="Customers"
                value={String(biz!.customers)}
                sub={`${biz!.activeSubscriptions} active subscription(s)`}
              />
              <Metric
                icon={Server}
                label="Hosting accounts"
                value={String(biz!.hostingAccounts)}
                sub={`${biz!.runningProjects} running · ${biz!.totalDomains} domain(s)`}
              />
              <Metric
                icon={Wallet}
                label="Revenue (month)"
                value={money(biz!.monthlyRevenue)}
                sub="Payments completed this month"
              />
              <Metric
                icon={FileWarning}
                label="Pending invoices"
                value={String(biz!.pendingInvoices)}
                sub={`${money(biz!.outstandingAmount)} outstanding · ${biz!.overdueInvoices} overdue`}
              />
              <Metric
                icon={UserX}
                label="Suspended accounts"
                value={String(biz!.suspendedAccounts)}
                sub="Sign-in blocked"
              />
              <Metric
                icon={AlertTriangle}
                label="Past due"
                value={String(biz!.pastDueSubscriptions)}
                sub={`${biz!.suspendedSubscriptions} suspended subscription(s)`}
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
