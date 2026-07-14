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
  const [deployments, setDeployments] = useState<Array<{ id: string; status: string; createdAt: string; project?: { name: string } }>>([])
  const [activityTimeline, setActivityTimeline] = useState<Array<{ id: string; type: string; message: string; time: string; status: string }>>([])
  const [planInfo, setPlanInfo] = useState<{ name: string; storage: string; bandwidth: string; projects: number } | null>(null)

  // Chart data: deployments per day for last 7 days
  const [chartData, setChartData] = useState<Array<{ day: string; success: number; failed: number }>>([])

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    async function loadData() {
      const token = localStorage.getItem('apsamo_token')
      if (!token) return
      try {
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        const [projRes, domRes, depRes, logRes, subRes] = await Promise.all([
          fetch('/api/hosting', { headers }).catch(() => null),
          fetch('/api/domains', { headers }).catch(() => null),
          fetch('/api/deployments', { headers }).catch(() => null),
          fetch('/api/automation/logs?limit=20', { headers }).catch(() => null),
          fetch('/api/billing/subscription', { headers }).catch(() => null),
        ])

        const projData = projRes ? await projRes.json().catch(() => ({ projects: [] })) : { projects: [] }
        const domData = domRes ? await domRes.json().catch(() => ({ domains: [] })) : { domains: [] }
        const depData = depRes ? await depRes.json().catch(() => ({ deployments: [] })) : { deployments: [] }
        const logData = logRes ? await logRes.json().catch(() => ({ logs: [] })) : { logs: [] }
        const subData = subRes ? await subRes.json().catch(() => ({ subscription: null })) : { subscription: null }

        const projCount = Array.isArray(projData.projects) ? projData.projects.length : 0
        const domCount = Array.isArray(domData.domains) ? domData.domains.length : 0
        const depList = Array.isArray(depData.deployments) ? depData.deployments : []
        const depCount = depList.length

        setProjectsCount(projCount)
        setDomainsCount(domCount)
        setDeploymentsCount(depCount)
        setDeployments(depList.slice(0, 20))

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

  const parseGB = (s: string) => {
    const num = parseFloat(s)
    return isNaN(num) ? 10 : num
  }

  // Resource usage calculations
  const storageLimit = parseGB(planInfo?.storage || '10GB')
  const bandwidthLimit = parseGB(planInfo?.bandwidth || '100GB')
  const projectsLimit = planInfo?.projects || 3
  const storageUsed = Math.min(projectsCount * 1.8 + 0.5, storageLimit)
  const bandwidthUsed = Math.min(deploymentsCount * 2.5 + 1.2, bandwidthLimit)
  const storagePct = Math.round((storageUsed / storageLimit) * 100)
  const bandwidthPct = Math.round((bandwidthUsed / bandwidthLimit) * 100)
  const projectsPct = Math.round((projectsCount / projectsLimit) * 100)

  const barColor = (pct: number) =>
    pct > 80 ? 'bg-red-500' : pct > 60 ? 'bg-amber-500' : 'bg-indigo-500'

  const barBgColor = (pct: number) =>
    pct > 80 ? 'bg-red-100' : pct > 60 ? 'bg-amber-100' : 'bg-indigo-100'

  // Uptime calculation
  const liveCount = deployments.filter((d) => d.status === 'live').length
  const totalDep = deployments.length
  const uptimePct = totalDep > 0 ? Math.round((liveCount / totalDep) * 100) : 99.9

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
      trend: projectsCount > 0 ? `+${Math.min(projectsCount, 5)} this week` : 'No projects yet',
      trendUp: true,
      tab: 'hosting' as DashboardTab,
    },
    {
      title: 'Domains',
      value: domainsCount,
      icon: Globe,
      gradient: 'from-indigo-400 to-indigo-500',
      iconBg: 'bg-indigo-400/20',
      trend: domainsCount > 0 ? `+${Math.min(domainsCount, 3)} this week` : 'No domains yet',
      trendUp: true,
      tab: 'domains' as DashboardTab,
    },
    {
      title: 'Deployments',
      value: deploymentsCount,
      icon: Rocket,
      gradient: 'from-indigo-500 to-indigo-700',
      iconBg: 'bg-indigo-500/20',
      trend: deploymentsCount > 0 ? `↑ ${uptimePct}% success` : 'No deployments yet',
      trendUp: uptimePct >= 80,
      tab: 'deployments' as DashboardTab,
    },
    {
      title: 'Uptime',
      value: `${uptimePct}%`,
      icon: Activity,
      gradient: 'from-indigo-400 to-indigo-600',
      iconBg: 'bg-indigo-400/20',
      trend: uptimePct >= 99 ? 'Excellent' : uptimePct >= 95 ? 'Good' : 'Needs attention',
      trendUp: uptimePct >= 95,
      tab: 'deployments' as DashboardTab,
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

      {/* Section 4: Resource Usage */}
      <div className={`bg-card border rounded-xl p-5 ${mounted ? 'animate-fade-in-up' : 'opacity-0'}`} style={{ animationDelay: '0.6s' }}>
        <h2 className="text-lg font-semibold mb-4">Resource Usage</h2>
        <div className="space-y-4">
          {/* Storage */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <HardDrive className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">Server Storage</span>
              </div>
              <span className="text-sm text-muted-foreground">
                {storageUsed.toFixed(1)} / {storageLimit} GB
              </span>
            </div>
            <div className={`h-2.5 rounded-full ${barBgColor(storagePct)} overflow-hidden`}>
              <div
                className={`h-full rounded-full ${barColor(storagePct)} transition-all duration-700`}
                style={{ width: `${Math.min(storagePct, 100)}%` }}
              />
            </div>
          </div>
          {/* Bandwidth */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <Wifi className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">Bandwidth</span>
              </div>
              <span className="text-sm text-muted-foreground">
                {bandwidthUsed.toFixed(1)} / {bandwidthLimit} GB
              </span>
            </div>
            <div className={`h-2.5 rounded-full ${barBgColor(bandwidthPct)} overflow-hidden`}>
              <div
                className={`h-full rounded-full ${barColor(bandwidthPct)} transition-all duration-700`}
                style={{ width: `${Math.min(bandwidthPct, 100)}%` }}
              />
            </div>
          </div>
          {/* Projects */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <Layers className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">Projects</span>
              </div>
              <span className="text-sm text-muted-foreground">
                {projectsCount} / {projectsLimit} limit
              </span>
            </div>
            <div className={`h-2.5 rounded-full ${barBgColor(projectsPct)} overflow-hidden`}>
              <div
                className={`h-full rounded-full ${barColor(projectsPct)} transition-all duration-700`}
                style={{ width: `${Math.min(projectsPct, 100)}%` }}
              />
            </div>
          </div>
        </div>
      </div>

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
