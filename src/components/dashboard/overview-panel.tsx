'use client'

import { useState, useEffect } from 'react'
import { useAuthStore } from '@/store/auth-store'
import { useAppStore, type DashboardTab } from '@/store/app-store'
import { Badge } from '@/components/ui/badge'
import {
  LayoutDashboard,
  Server,
  Globe,
  Rocket,
  CreditCard,
  Shield,
  Activity,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  AlertCircle,
  Zap,
  TrendingUp,
  TrendingDown,
  HardDrive,
  Wifi,
  Layers,
  ChevronRight,
} from 'lucide-react'

/** One plan quota vs what the customer actually consumes. */
interface QuotaCheck {
  key: string
  label: string
  used: number
  /** null means unlimited — must never render as a full bar. */
  limit: number | null
  percent: number | null
  over: boolean
}

/** Live container metrics for one of the customer's sites. */
interface HostingResource {
  projectId: string
  name: string
  slug: string
  status: string
  /** False when the container could not be inspected — show "—", not 0. */
  measured: boolean
  cpuPercent: number | null
  ramUsedMB: number | null
  ramLimitMB: number | null
  storageUsedGB: number | null
}

interface UsageResponse {
  subscription: { planName: string | null; status: string } | null
  quota: { planName: string | null; checks: QuotaCheck[]; overCount: number }
  consumed: { diskMB: number; bandwidthMB: number; capturedAt: string } | null
  hosting: HostingResource[]
}

// ── Overview Dashboard ─────────────────────────────────────────────────
export default function OverviewPanel() {
  const { user } = useAuthStore()
  const setDashboardTab = useAppStore((s) => s.setDashboardTab)
  const [loading, setLoading] = useState(true)
  const [mounted, setMounted] = useState(false)

  // Data states
  const [projectsCount, setProjectsCount] = useState(0)
  const [domainsCount, setDomainsCount] = useState(0)
  const [deploymentsCount, setDeploymentsCount] = useState(0)
  /**
   * Genuine last-7-day counts. The trend captions used to read
   * `+${Math.min(count, 5)} this week`, which is just the total capped at five
   * — a project created a year ago was reported as created this week.
   */
  const [newThisWeek, setNewThisWeek] = useState({ projects: 0, domains: 0, deployments: 0 })
  /**
   * Real uptime, averaged across the customer's monitors. Null when they have
   * none — the card then shows "—" rather than inventing a figure.
   */
  const [uptime, setUptime] = useState<{ pct: number; monitors: number } | null>(null)
  const [deployments, setDeployments] = useState<Array<{ id: string; status: string; createdAt: string; project?: { name: string } }>>([])
  const [activityTimeline, setActivityTimeline] = useState<Array<{ id: string; type: string; message: string; time: string; status: string }>>([])
  const [planInfo, setPlanInfo] = useState<{ name: string; storage: string; bandwidth: string; projects: number } | null>(null)

  // Chart data: deployments per day for last 7 days
  const [chartData, setChartData] = useState<Array<{ day: string; success: number; failed: number }>>([])

  /**
   * Measured usage + plan quotas from /api/usage.
   *
   * This replaces the previous "Resource Usage" panel, whose storage and
   * bandwidth figures were invented (`projectCount * 1.8 + 0.5`) and shown to
   * customers as if measured. Anything not actually measured now renders as
   * "—", never as a number.
   */
  const [usage, setUsage] = useState<UsageResponse | null>(null)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    async function loadData() {
      try {
        // The httpOnly session cookie authenticates these requests.
        const headers = { 'Content-Type': 'application/json' }
        const [projRes, domRes, depRes, logRes, subRes, usageRes, monRes] = await Promise.all([
          fetch('/api/hosting', { headers }).catch(() => null),
          fetch('/api/domains', { headers }).catch(() => null),
          fetch('/api/deployments', { headers }).catch(() => null),
          fetch('/api/automation/logs?limit=20', { headers }).catch(() => null),
          fetch('/api/billing/subscription', { headers }).catch(() => null),
          // Measured usage + plan quotas — the only source for the resource UI.
          fetch('/api/usage', { headers }).catch(() => null),
          // Real uptime — measured by the worker against live endpoints.
          fetch('/api/monitors', { headers }).catch(() => null),
        ])

        const projData = projRes ? await projRes.json().catch(() => ({ projects: [] })) : { projects: [] }
        const domData = domRes ? await domRes.json().catch(() => ({ domains: [] })) : { domains: [] }
        const depData = depRes ? await depRes.json().catch(() => ({ deployments: [] })) : { deployments: [] }
        const logData = logRes ? await logRes.json().catch(() => ({ logs: [] })) : { logs: [] }
        const subData = subRes ? await subRes.json().catch(() => ({ subscription: null })) : { subscription: null }
        if (usageRes?.ok) {
          setUsage(await usageRes.json().catch(() => null))
        }

        const projCount = Array.isArray(projData.projects) ? projData.projects.length : 0
        const domCount = Array.isArray(domData.domains) ? domData.domains.length : 0
        const depList = Array.isArray(depData.deployments) ? depData.deployments : []
        const depCount = depList.length

        setProjectsCount(projCount)
        setDomainsCount(domCount)
        setDeploymentsCount(depCount)
        setDeployments(depList.slice(0, 20))

        // Actual creations in the last 7 days, from createdAt.
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
        const since = (rows: unknown): number =>
          Array.isArray(rows)
            ? rows.filter((r) => {
                const c = (r as { createdAt?: string }).createdAt
                return c ? new Date(c).getTime() >= weekAgo : false
              }).length
            : 0
        setNewThisWeek({
          projects: since(projData.projects),
          domains: since(domData.domains),
          deployments: since(depList),
        })

        // Uptime from real monitors, or null when none are configured.
        if (monRes?.ok) {
          const monData = await monRes.json().catch(() => ({ monitors: [] }))
          const mons: Array<{ uptimePct?: number | null }> = Array.isArray(monData.monitors)
            ? monData.monitors
            : []
          const withData = mons.filter((m) => typeof m.uptimePct === 'number')
          setUptime(
            withData.length > 0
              ? {
                  pct:
                    Math.round(
                      (withData.reduce((sum, m) => sum + (m.uptimePct as number), 0) /
                        withData.length) * 10
                    ) / 10,
                  monitors: withData.length,
                }
              : null
          )
        }

        // Plan info
        if (subData.subscription?.plan) {
          setPlanInfo({
            name: subData.subscription.plan.name,
            storage: subData.subscription.plan.storage || '10GB',
            bandwidth: subData.subscription.plan.bandwidth || '100GB',
            projects: subData.subscription.plan.projects || 3,
          })
        }

        // Build chart data: deployments per day for last 7 days
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
        const now = new Date()
        const days: Array<{ date: string; day: string; success: number; failed: number }> = []
        for (let i = 6; i >= 0; i--) {
          const d = new Date(now)
          d.setDate(d.getDate() - i)
          const dateStr = d.toISOString().split('T')[0]
          days.push({ date: dateStr, day: dayNames[d.getDay()], success: 0, failed: 0 })
        }
        depList.forEach((dep: { createdAt: string; status: string }) => {
          const depDate = new Date(dep.createdAt).toISOString().split('T')[0]
          const dayEntry = days.find((d) => d.date === depDate)
          if (dayEntry) {
            if (dep.status === 'failed' || dep.status === 'rolled_back') {
              dayEntry.failed++
            } else {
              dayEntry.success++
            }
          }
        })
        // Show real activity only — no fabricated data. An all-zero week
        // renders an honest empty chart instead of invented deployments.
        setChartData(days)

        // Build activity timeline from automation logs + deployments + domains
        const timeline: Array<{ id: string; type: string; message: string; time: string; status: string }> = []

        // From automation logs
        const logs = Array.isArray(logData.logs) ? logData.logs : []
        logs.forEach((log: { id: string; eventType: string; action: string; status: string; createdAt: string; error?: string }) => {
          let type = 'automation'
          if (log.action?.includes('deploy') || log.eventType?.includes('hosting')) type = 'deployment'
          else if (log.action?.includes('domain') || log.action?.includes('dns')) type = 'domain'
          else if (log.eventType?.includes('payment')) type = 'payment'
          else if (log.action?.includes('ssl')) type = 'ssl'

          const message = log.action
            ? log.action.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
            : log.eventType?.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()) || 'Automation event'

          timeline.push({ id: `log-${log.id}`, type, message, time: log.createdAt, status: log.status })
        })

        // From deployments
        depList.slice(0, 5).forEach((d: { id: string; status: string; createdAt: string; project?: { name: string } }) => {
          const projName = d.project?.name || 'Project'
          const statusLabel = d.status === 'live' ? 'deployed successfully' : d.status === 'failed' ? 'deployment failed' : `deployment ${d.status}`
          timeline.push({
            id: `dep-${d.id}`,
            type: 'deployment',
            message: `${projName} ${statusLabel}`,
            time: d.createdAt,
            status: d.status,
          })
        })

        // From domains
        const domList = Array.isArray(domData.domains) ? domData.domains : []
        domList.slice(0, 3).forEach((d: { id: string; status: string; name: string; createdAt: string }) => {
          timeline.push({
            id: `dom-${d.id}`,
            type: 'domain',
            message: `Domain ${d.name} ${d.status === 'active' ? 'registered' : d.status}`,
            time: d.createdAt,
            status: d.status,
          })
        })

        // Sort by time descending, deduplicate
        timeline.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
        const seen = new Set<string>()
        const unique = timeline.filter((item) => {
          if (seen.has(item.id)) return false
          seen.add(item.id)
          return true
        })
        setActivityTimeline(unique.slice(0, 10))
      } catch {
        // Silently handle
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [])

  // Helpers
  const formatDate = () => {
    return new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  }

  const relativeTime = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'Just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days < 7) return `${days}d ago`
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  const barColor = (pct: number) =>
    pct > 80 ? 'bg-red-500' : pct > 60 ? 'bg-amber-500' : 'bg-indigo-500'

  const barBgColor = (pct: number) =>
    pct > 80 ? 'bg-red-100' : pct > 60 ? 'bg-amber-100' : 'bg-indigo-100'

  // Deployment success rate — the share of this customer's deployments that
  // reached "live". This used to be labelled "Uptime", which it never was: it
  // measures build outcomes, not availability, and it fell back to a hardcoded
  // 99.9% for anyone with no deployments, so a brand-new account with nothing
  // hosted was shown "Uptime 99.9% — Excellent".
  const liveCount = deployments.filter((d) => d.status === 'live').length
  const totalDep = deployments.length
  const successPct = totalDep > 0 ? Math.round((liveCount / totalDep) * 100) : null

  // Timeline icon/color per type
  const timelineIcon = (type: string) => {
    switch (type) {
      case 'deployment': return { icon: Rocket, color: 'text-indigo-600', bg: 'bg-indigo-100', dot: 'bg-indigo-500' }
      case 'domain': return { icon: Globe, color: 'text-indigo-700', bg: 'bg-indigo-100', dot: 'bg-indigo-400' }
      case 'automation': return { icon: Zap, color: 'text-indigo-600', bg: 'bg-indigo-50', dot: 'bg-indigo-500' }
      case 'payment': return { icon: CreditCard, color: 'text-indigo-700', bg: 'bg-indigo-50', dot: 'bg-indigo-400' }
      case 'ssl': return { icon: Shield, color: 'text-indigo-600', bg: 'bg-indigo-100', dot: 'bg-indigo-500' }
      default: return { icon: Activity, color: 'text-gray-600', bg: 'bg-gray-100', dot: 'bg-gray-500' }
    }
  }

  const statusBadge = (status: string) => {
    switch (status) {
      case 'live':
      case 'active':
      case 'completed':
        return <Badge className="bg-indigo-50 text-indigo-700 border-indigo-200 text-[10px] capitalize">{status}</Badge>
      case 'building':
      case 'deploying':
      case 'running':
      case 'pending':
        return <Badge className="bg-amber-50 text-amber-700 border-amber-200 text-[10px] capitalize">{status}</Badge>
      case 'failed':
      case 'rolled_back':
        return <Badge className="bg-red-50 text-red-700 border-red-200 text-[10px] capitalize">{status}</Badge>
      default:
        return <Badge variant="outline" className="text-[10px] capitalize">{status}</Badge>
    }
  }

  // Stat cards config
  const statCards = [
    {
      title: 'Projects',
      value: projectsCount,
      icon: Server,
      gradient: 'from-indigo-500 to-indigo-600',
      iconBg: 'bg-indigo-500/20',
      trend:
        newThisWeek.projects > 0
          ? `+${newThisWeek.projects} this week`
          : projectsCount > 0
          ? 'No change this week'
          : 'No projects yet',
      trendUp: newThisWeek.projects > 0,
      tab: 'hosting' as DashboardTab,
    },
    {
      title: 'Domains',
      value: domainsCount,
      icon: Globe,
      gradient: 'from-indigo-400 to-indigo-500',
      iconBg: 'bg-indigo-400/20',
      trend:
        newThisWeek.domains > 0
          ? `+${newThisWeek.domains} this week`
          : domainsCount > 0
          ? 'No change this week'
          : 'No domains yet',
      trendUp: newThisWeek.domains > 0,
      tab: 'domains' as DashboardTab,
    },
    {
      title: 'Deployments',
      value: deploymentsCount,
      icon: Rocket,
      gradient: 'from-indigo-500 to-indigo-700',
      iconBg: 'bg-indigo-500/20',
      trend:
        successPct !== null
          ? `${successPct}% reached live`
          : 'No deployments yet',
      trendUp: successPct !== null && successPct >= 80,
      tab: 'deployments' as DashboardTab,
    },
    {
      // Real availability, measured by the worker against live endpoints.
      // Shows "—" rather than a number when the customer has no monitors:
      // there is genuinely nothing to report, and a placeholder percentage
      // here is exactly what made this card untrustworthy before.
      title: 'Uptime',
      value: uptime ? `${uptime.pct}%` : '—',
      icon: Activity,
      gradient: 'from-indigo-400 to-indigo-600',
      iconBg: 'bg-indigo-400/20',
      trend: uptime
        ? `${uptime.monitors} monitor${uptime.monitors === 1 ? '' : 's'}`
        : 'Not monitored yet',
      trendUp: uptime ? uptime.pct >= 99 : false,
      tab: 'monitoring' as DashboardTab,
    },
  ]

  // Quick actions
  const quickActions = [
    { label: 'New Project', desc: 'Create hosting project', icon: Server, tab: 'hosting' as DashboardTab, gradient: 'group-hover:from-indigo-500 group-hover:to-indigo-600' },
    { label: 'Register Domain', desc: 'Search & register domains', icon: Globe, tab: 'domains' as DashboardTab, gradient: 'group-hover:from-indigo-400 group-hover:to-indigo-500' },
    { label: 'View Deployments', desc: 'Recent deployment history', icon: Rocket, tab: 'deployments' as DashboardTab, gradient: 'group-hover:from-indigo-600 group-hover:to-indigo-700' },
    { label: 'Manage Billing', desc: 'Plans & invoices', icon: CreditCard, tab: 'billing' as DashboardTab, gradient: 'group-hover:from-indigo-500 group-hover:to-indigo-400' },
  ]

  // Max chart value for scaling
  const maxChartVal = Math.max(...chartData.map((d) => d.success + d.failed), 1)

  return (
    <div className="space-y-6">
      {/* Section 1: Welcome Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">
            <span className="bg-gradient-to-r from-indigo-600 to-indigo-600 bg-clip-text text-transparent">
              Welcome back{user?.name ? `, ${user.name}` : ''}!
            </span>
          </h1>
          <p className="text-muted-foreground mt-1">{formatDate()}</p>
        </div>
        {planInfo && (
          <Badge className="bg-indigo-50 text-indigo-700 border-indigo-200 shrink-0 self-start sm:self-auto">
            {planInfo.name} Plan
          </Badge>
        )}
      </div>

      {/* Section 2: Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card, idx) => {
          const Icon = card.icon
          return (
            <button
              key={card.title}
              onClick={() => setDashboardTab(card.tab)}
              className={`relative bg-card border rounded-xl p-5 flex items-center gap-4 hover:shadow-md transition-all text-left group overflow-hidden stat-card-hover ${
                mounted ? 'animate-stagger-in' : 'opacity-0'
              }`}
              style={{ animationDelay: `${idx * 0.1 + 0.1}s` }}
            >
              {/* Gradient overlay on hover */}
              <div className={`absolute inset-0 bg-gradient-to-br ${card.gradient} opacity-0 group-hover:opacity-[0.07] transition-opacity duration-300`} />
              <div className={`size-12 rounded-xl bg-gradient-to-br ${card.gradient} flex items-center justify-center shrink-0 shadow-sm`}>
                <Icon className="size-6 text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-muted-foreground">{card.title}</p>
                <p className={`text-2xl font-bold mt-0.5 ${card.title === 'Deployments' && !loading ? 'number-pulse' : ''}`}>{loading ? '...' : card.value}</p>
                <div className="flex items-center gap-1 mt-1">
                  {card.trendUp ? (
                    <TrendingUp className="size-3 text-indigo-500" />
                  ) : (
                    <TrendingDown className="size-3 text-red-500" />
                  )}
                  <span className={`text-[11px] font-medium ${card.trendUp ? 'text-indigo-600' : 'text-red-600'}`}>
                    {card.trend}
                  </span>
                </div>
              </div>
              <ArrowUpRight className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity relative z-10" />
            </button>
          )
        })}
      </div>

      {/* Section 3: Deployment Activity Chart */}
      <div className={`bg-card border rounded-xl p-5 ${mounted ? 'animate-fade-in-up' : 'opacity-0'}`} style={{ animationDelay: '0.5s' }}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold">Deployment Activity</h2>
            <p className="text-sm text-muted-foreground">Last 7 days</p>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <div className="flex items-center gap-1.5">
              <div className="size-2.5 rounded-sm bg-indigo-500" />
              <span className="text-muted-foreground">Success</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="size-2.5 rounded-sm bg-red-500" />
              <span className="text-muted-foreground">Failed</span>
            </div>
          </div>
        </div>
        <div className="flex items-end gap-2 sm:gap-3 h-40">
          {chartData.map((day) => {
            const successH = maxChartVal > 0 ? (day.success / maxChartVal) * 100 : 0
            const failedH = maxChartVal > 0 ? (day.failed / maxChartVal) * 100 : 0
            return (
              <div key={day.day} className="flex-1 flex flex-col items-center gap-1 group/bar relative">
                {/* Tooltip */}
                <div className="absolute -top-8 bg-foreground text-background text-[10px] px-2 py-1 rounded-md opacity-0 group-hover/bar:opacity-100 transition-opacity whitespace-nowrap z-10 pointer-events-none">
                  {day.success} success{day.failed > 0 ? `, ${day.failed} failed` : ''}
                </div>
                <div className="flex items-end gap-0.5 w-full h-32">
                  {/* Success bar */}
                  <div className="flex-1 flex flex-col justify-end">
                    <div
                      className="bg-indigo-500 rounded-t-sm transition-all duration-500 min-h-[2px]"
                      style={{ height: `${Math.max(successH, 2)}%` }}
                    />
                  </div>
                  {/* Failed bar */}
                  {day.failed > 0 && (
                    <div className="flex-1 flex flex-col justify-end">
                      <div
                        className="bg-red-500 rounded-t-sm transition-all duration-500 min-h-[2px]"
                        style={{ height: `${Math.max(failedH, 2)}%` }}
                      />
                    </div>
                  )}
                </div>
                <span className="text-[11px] text-muted-foreground font-medium">{day.day}</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Section 4a: Subscription Usage (plan quotas) ─────────────────
          These are BILLING limits from the purchased plan, compared against
          measured consumption. They are not server capacity: a 10 GB plan
          quota says nothing about the host's disk. */}
      <div className={`bg-card border rounded-xl p-5 ${mounted ? 'animate-fade-in-up' : 'opacity-0'}`} style={{ animationDelay: '0.6s' }}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold">Subscription Usage</h2>
          {usage?.quota?.planName && (
            <Badge variant="outline" className="text-xs">{usage.quota.planName} plan</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          What your plan includes, against what you&apos;re actually using.
        </p>

        {!usage ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Loading usage…</p>
        ) : usage.quota.checks.length === 0 ? (
          <div className="py-6 text-center">
            <CreditCard className="size-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No active plan</p>
            <button onClick={() => setDashboardTab('billing')} className="text-xs text-indigo-600 hover:text-indigo-700 font-medium mt-1">
              View plans
            </button>
          </div>
        ) : (
          <div className="space-y-3.5">
            {usage.quota.checks.map((c) => {
              const unlimited = c.limit === null || c.limit === 0
              const pct = unlimited ? 0 : Math.min(c.percent ?? 0, 100)
              const label = c.key === 'disk' ? 'Hosting Storage' : c.label
              return (
                <div key={c.key}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      {c.key === 'disk' ? <HardDrive className="size-4 text-muted-foreground" />
                        : c.key === 'bandwidth' ? <Wifi className="size-4 text-muted-foreground" />
                        : <Layers className="size-4 text-muted-foreground" />}
                      <span className="text-sm font-medium">{label}</span>
                      {c.over && <Badge variant="outline" className="text-[10px] border-red-500/50 text-red-600">over limit</Badge>}
                    </div>
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {/* Unlimited renders as "—", never a full bar. */}
                      {unlimited ? `${c.used} / unlimited` : `${c.used} / ${c.limit}`}
                    </span>
                  </div>
                  {unlimited ? (
                    <div className="h-2.5 rounded-full bg-muted overflow-hidden">
                      <div className="h-full w-full bg-gradient-to-r from-indigo-500/20 to-transparent" />
                    </div>
                  ) : (
                    <div className={`h-2.5 rounded-full ${barBgColor(pct)} overflow-hidden`}>
                      <div className={`h-full rounded-full ${barColor(pct)} transition-all duration-700`} style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              )
            })}
            {usage.consumed?.capturedAt && (
              <p className="text-[11px] text-muted-foreground pt-1">
                Measured {relativeTime(usage.consumed.capturedAt)}.
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Section 4b: Hosting Resources (live container metrics) ────────
          Real CPU/RAM/disk for the customer's own sites, measured now. This
          is NOT host capacity — customers never see the VPS's totals. */}
      {usage && usage.hosting.length > 0 && (
        <div className={`bg-card border rounded-xl p-5 ${mounted ? 'animate-fade-in-up' : 'opacity-0'}`} style={{ animationDelay: '0.65s' }}>
          <h2 className="text-lg font-semibold mb-1">Hosting Resources</h2>
          <p className="text-xs text-muted-foreground mb-4">
            Live resource use of your websites, measured from their containers.
          </p>
          <div className="space-y-3">
            {usage.hosting.map((h) => (
              <div key={h.projectId} className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Server className="size-4 text-muted-foreground shrink-0" />
                    <span className="text-sm font-medium truncate">{h.name}</span>
                  </div>
                  <Badge variant={h.status === 'running' ? 'default' : 'secondary'} className="text-[10px] shrink-0">
                    {h.status}
                  </Badge>
                </div>
                {h.measured ? (
                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <div>
                      <p className="text-muted-foreground">CPU</p>
                      <p className="font-semibold tabular-nums">{(h.cpuPercent ?? 0).toFixed(1)}%</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Memory</p>
                      <p className="font-semibold tabular-nums">
                        {(h.ramUsedMB ?? 0).toFixed(0)} MB
                        {h.ramLimitMB ? <span className="text-muted-foreground font-normal"> / {h.ramLimitMB}</span> : null}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Disk</p>
                      <p className="font-semibold tabular-nums">{(h.storageUsedGB ?? 0).toFixed(2)} GB</p>
                    </div>
                  </div>
                ) : (
                  /* Not measurable right now — say so rather than showing 0. */
                  <p className="text-xs text-muted-foreground">
                    Metrics unavailable{h.status !== 'running' ? ' (site is not running)' : ''}.
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Section 5: Recent Activity Timeline */}
      <div className={`bg-card border rounded-xl p-5 ${mounted ? 'animate-fade-in-up' : 'opacity-0'}`} style={{ animationDelay: '0.7s' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Recent Activity</h2>
          <button
            onClick={() => setDashboardTab('deployments')}
            className="text-xs text-indigo-600 hover:text-indigo-700 font-medium flex items-center gap-0.5 transition-colors"
          >
            View all <ChevronRight className="size-3" />
          </button>
        </div>
        {activityTimeline.length === 0 ? (
          <div className="p-8 text-center">
            <Activity className="size-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No recent activity</p>
            <p className="text-xs text-muted-foreground mt-1">Create a project or register a domain to get started</p>
          </div>
        ) : (
          <div className="relative">
            {/* Vertical timeline line */}
            <div className="absolute left-5 top-3 bottom-3 w-px bg-border" />
            <div className="space-y-0">
              {activityTimeline.map((item, idx) => {
                const ti = timelineIcon(item.type)
                const Icon = ti.icon
                const isLast = idx === activityTimeline.length - 1
                return (
                  <div key={item.id} className="relative flex items-start gap-3 pb-4 group/timeline">
                    {/* Timeline dot */}
                    <div className={`relative z-10 size-10 rounded-full ${ti.bg} flex items-center justify-center shrink-0 ring-2 ring-background`}>
                      <Icon className={`size-4 ${ti.color}`} />
                    </div>
                    {/* Content */}
                    <div className={`flex-1 min-w-0 ${isLast ? '' : 'border-b border-border/50'} pb-3`}>
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium truncate">{item.message}</p>
                        {statusBadge(item.status)}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{relativeTime(item.time)}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Section 6: Quick Actions */}
      <div className={`bg-card border rounded-xl p-5 ${mounted ? 'animate-fade-in-up' : 'opacity-0'}`} style={{ animationDelay: '0.8s' }}>
        <h2 className="text-lg font-semibold mb-3">Quick Actions</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {quickActions.map((action) => {
            const Icon = action.icon
            return (
              <button
                key={action.label}
                onClick={() => setDashboardTab(action.tab)}
                className="group bg-card border rounded-xl p-4 flex items-center gap-3 hover:border-indigo-300 hover:shadow-md transition-all text-left relative overflow-hidden"
              >
                {/* Gradient hover overlay */}
                <div className={`absolute inset-0 bg-gradient-to-br ${action.gradient} opacity-0 group-hover:opacity-[0.06] transition-opacity duration-300`} />
                <div className="size-9 rounded-lg bg-indigo-50 group-hover:bg-gradient-to-br group-hover:from-indigo-500 group-hover:to-indigo-500 flex items-center justify-center text-indigo-600 group-hover:text-white shrink-0 transition-all duration-300">
                  <Icon className="size-4" />
                </div>
                <div className="relative z-10">
                  <p className="text-sm font-medium">{action.label}</p>
                  <p className="text-xs text-muted-foreground">{action.desc}</p>
                </div>
                <ChevronRight className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity ml-auto relative z-10" />
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
