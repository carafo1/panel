'use client'

import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '@/store/auth-store'
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  Clock,
  Zap,
  Users,
  AlertTriangle,
  Activity,
  Globe,
  Loader2,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// Types
interface AnalyticsData {
  totalRequests: number
  avgResponseTime: number
  errorRate: number
  bandwidth: number
  uniqueVisitors: number
  requestsByDay: Array<{ date: string; count: number; errors: number }>
  topPaths: Array<{ path: string; count: number; avgTime: number }>
  responseTimeByDay: Array<{ date: string; avg: number; p95: number }>
  geoDistribution: Array<{ country: string; count: number }>
}

interface Project {
  id: string
  name: string
  subdomain: string
  customDomain?: string
  status: string
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return n.toString()
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ── Requests Over Time Chart ────────────────────────────────────────
function RequestsChart({ data }: { data: Array<{ date: string; count: number; errors: number }> }) {
  const maxCount = Math.max(...data.map(d => d.count), 1)
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <BarChart3 className="size-4 text-indigo-600" />
          Requests Over Time
        </CardTitle>
        <CardDescription>Daily request volume</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {/* Y-axis labels */}
          <div className="flex items-end gap-1 h-48">
            <div className="flex flex-col justify-between h-48 text-[10px] text-muted-foreground font-mono w-8 text-right pr-1">
              <span>{formatNumber(maxCount)}</span>
              <span>{formatNumber(Math.round(maxCount * 0.75))}</span>
              <span>{formatNumber(Math.round(maxCount * 0.5))}</span>
              <span>{formatNumber(Math.round(maxCount * 0.25))}</span>
              <span>0</span>
            </div>
            <div className="flex-1 flex items-end gap-1 h-48">
              {data.map((day) => {
                const barHeight = (day.count / maxCount) * 100
                const errorHeight = (day.errors / maxCount) * 100
                return (
                  <div key={day.date} className="flex-1 flex flex-col items-center group/bar relative">
                    <div className="flex items-end gap-px w-full h-44">
                      <div className="flex-1 flex flex-col justify-end">
                        <div
                          className="bg-gradient-to-t from-indigo-600 to-indigo-400 rounded-t-sm transition-all duration-500 min-h-[2px] w-full"
                          style={{ height: `${Math.max(barHeight, 1)}%` }}
                        />
                      </div>
                      {day.errors > 0 && (
                        <div className="flex-1 flex flex-col justify-end">
                          <div
                            className="bg-red-500/80 rounded-t-sm transition-all duration-500 min-h-[2px] w-full"
                            style={{ height: `${Math.max(errorHeight, 1)}%` }}
                          />
                        </div>
                      )}
                    </div>
                    {/* Tooltip */}
                    <div className="absolute -top-10 bg-foreground text-background text-[10px] px-2 py-1 rounded-md opacity-0 group-hover/bar:opacity-100 transition-opacity whitespace-nowrap z-10 pointer-events-none">
                      {formatNumber(day.count)} requests{day.errors > 0 ? `, ${day.errors} errors` : ''}
                    </div>
                    <span className="text-[9px] text-muted-foreground font-medium mt-0.5 truncate w-full text-center">
                      {formatDate(day.date)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
          <div className="flex items-center gap-4 text-[10px] pl-9">
            <div className="flex items-center gap-1">
              <div className="size-2.5 rounded-sm bg-indigo-500" />
              <span className="text-muted-foreground">Requests</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="size-2.5 rounded-sm bg-red-500/80" />
              <span className="text-muted-foreground">Errors</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Response Time Chart ─────────────────────────────────────────────
function ResponseTimeChart({ data }: { data: Array<{ date: string; avg: number; p95: number }> }) {
  if (data.length === 0) return null
  const maxTime = Math.max(...data.map(d => d.p95), 1)
  const chartHeight = 160

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Clock className="size-4 text-indigo-600" />
          Response Time
        </CardTitle>
        <CardDescription>Average and P95 latency</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          <div className="flex items-end gap-1">
            <div className="flex flex-col justify-between text-[10px] text-muted-foreground font-mono w-8 text-right pr-1" style={{ height: chartHeight }}>
              <span>{maxTime}ms</span>
              <span>{Math.round(maxTime * 0.5)}ms</span>
              <span>0ms</span>
            </div>
            <div className="flex-1 relative" style={{ height: chartHeight }}>
              {/* Grid lines */}
              <div className="absolute inset-0 flex flex-col justify-between pointer-events-none">
                <div className="border-b border-border/40" />
                <div className="border-b border-border/40" />
                <div className="border-b border-border/40" />
              </div>
              {/* SVG line chart */}
              <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
                {/* P95 line */}
                <polyline
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth="2"
                  strokeLinejoin="round"
                  points={data.map((d, i) => {
                    const x = (i / Math.max(data.length - 1, 1)) * 100
                    const y = chartHeight - (d.p95 / maxTime) * chartHeight
                    return `${x}%,${y}`
                  }).join(' ')}
                />
                {/* Average line */}
                <polyline
                  fill="none"
                  stroke="#10b981"
                  strokeWidth="2"
                  strokeLinejoin="round"
                  points={data.map((d, i) => {
                    const x = (i / Math.max(data.length - 1, 1)) * 100
                    const y = chartHeight - (d.avg / maxTime) * chartHeight
                    return `${x}%,${y}`
                  }).join(' ')}
                />
                {/* Data points - avg */}
                {data.map((d, i) => {
                  const x = (i / Math.max(data.length - 1, 1)) * 100
                  const y = chartHeight - (d.avg / maxTime) * chartHeight
                  return <circle key={`avg-${i}`} cx={`${x}%`} cy={y} r="3" fill="#10b981" />
                })}
                {/* Data points - p95 */}
                {data.map((d, i) => {
                  const x = (i / Math.max(data.length - 1, 1)) * 100
                  const y = chartHeight - (d.p95 / maxTime) * chartHeight
                  return <circle key={`p95-${i}`} cx={`${x}%`} cy={y} r="3" fill="#f59e0b" />
                })}
              </svg>
            </div>
          </div>
          <div className="flex items-center justify-between pl-9">
            <div className="flex items-center gap-4 text-[10px]">
              <div className="flex items-center gap-1">
                <div className="size-2.5 rounded-full bg-indigo-500" />
                <span className="text-muted-foreground">Avg</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="size-2.5 rounded-full bg-amber-500" />
                <span className="text-muted-foreground">P95</span>
              </div>
            </div>
            <span className="text-[9px] text-muted-foreground">
              {formatDate(data[0]?.date)} – {formatDate(data[data.length - 1]?.date)}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Top Paths Chart ─────────────────────────────────────────────────
function TopPathsChart({ data }: { data: Array<{ path: string; count: number; avgTime: number }> }) {
  const maxCount = Math.max(...data.map(d => d.count), 1)
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Zap className="size-4 text-indigo-600" />
          Top Paths
        </CardTitle>
        <CardDescription>Most requested routes</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2.5">
          {data.map((item) => {
            const widthPct = (item.count / maxCount) * 100
            return (
              <div key={item.path} className="group">
                <div className="flex items-center justify-between mb-1">
                  <code className="text-xs font-mono truncate max-w-[60%]">{item.path}</code>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{formatNumber(item.count)}</span>
                    <span className="text-[10px]">{item.avgTime}ms</span>
                  </div>
                </div>
                <div className="h-2 bg-muted/50 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-indigo-500 to-indigo-400 rounded-full transition-all duration-500"
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

// ── Geographic Distribution ─────────────────────────────────────────
function GeoDistribution({ data }: { data: Array<{ country: string; count: number }> }) {
  const maxCount = Math.max(...data.map(d => d.count), 1)
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Globe className="size-4 text-indigo-600" />
          Geographic Distribution
        </CardTitle>
        <CardDescription>Requests by country</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="max-h-80 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
          <div className="space-y-2">
            {data.map((item) => {
              const widthPct = (item.count / maxCount) * 100
              return (
                <div key={item.country} className="flex items-center gap-3">
                  <span className="text-sm w-36 truncate shrink-0">{item.country}</span>
                  <div className="flex-1 h-2 bg-muted/50 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-indigo-500/60 rounded-full transition-all duration-500"
                      style={{ width: `${widthPct}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono text-muted-foreground w-12 text-right shrink-0">
                    {formatNumber(item.count)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Main Analytics Panel ────────────────────────────────────────────
export default function AnalyticsPanel() {
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<'24h' | '7d' | '30d'>('7d')

  // Fetch projects
  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const data = await apiFetch('/hosting')
        const projs = data.projects || []
        setProjects(projs)
        if (projs.length > 0 && !selectedProjectId) {
          setSelectedProjectId(projs[0].id)
        }
      } catch {
        // Silently handle
      }
    }
    fetchProjects()
  }, [])

  // Fetch analytics
  const fetchAnalytics = useCallback(async () => {
    if (!selectedProjectId) return
    setLoading(true)
    try {
      const data = await apiFetch(`/analytics/${selectedProjectId}?period=${period}`)
      setAnalytics(data)
    } catch {
      setAnalytics(null)
    } finally {
      setLoading(false)
    }
  }, [selectedProjectId, period])

  useEffect(() => {
    fetchAnalytics()
  }, [fetchAnalytics])

  const selectedProject = projects.find(p => p.id === selectedProjectId)

  // No projects
  if (projects.length === 0 && !loading) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold">Analytics</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor your project performance and traffic
          </p>
        </div>
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <BarChart3 className="size-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold mb-1">No projects yet</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Create a hosting project to see analytics data
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">Analytics</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor your project performance and traffic
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Project selector */}
          {projects.length > 1 && (
            <Select
              value={selectedProjectId || ''}
              onValueChange={setSelectedProjectId}
            >
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Select project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Period selector */}
          <div className="flex items-center rounded-lg border bg-muted/30 p-0.5">
            {(['24h', '7d', '30d'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  period === p
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          {/* Live indicator */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="relative flex size-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
              <span className="relative inline-flex rounded-full size-2 bg-indigo-500" />
            </span>
            Live
          </div>
        </div>
      </div>

      {/* Project info */}
      {selectedProject && (
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            {selectedProject.name}
          </Badge>
          <span className="text-xs text-muted-foreground font-mono">
            {selectedProject.customDomain || selectedProject.subdomain}
          </span>
        </div>
      )}

      {loading ? (
        <>
          {/* Loading stats */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="p-5">
                  <Skeleton className="h-4 w-24 mb-2" />
                  <Skeleton className="h-8 w-32 mb-1" />
                  <Skeleton className="h-3 w-20" />
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card><CardContent className="p-5"><Skeleton className="h-64 w-full" /></CardContent></Card>
            <Card><CardContent className="p-5"><Skeleton className="h-64 w-full" /></CardContent></Card>
          </div>
        </>
      ) : analytics ? (
        <>
          {/* Stats Row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Total Requests */}
            <Card className="hover:shadow-md transition-shadow">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">Total Requests</p>
                  <div className="size-8 rounded-lg bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center">
                    <Activity className="size-4 text-indigo-600" />
                  </div>
                </div>
                <p className="text-2xl font-bold font-mono mt-2">{formatNumber(analytics.totalRequests)}</p>
                <div className="flex items-center gap-1 mt-1">
                  <TrendingUp className="size-3 text-indigo-500" />
                  <span className="text-xs text-indigo-600 font-medium">+12.5%</span>
                  <span className="text-xs text-muted-foreground">vs last period</span>
                </div>
              </CardContent>
            </Card>

            {/* Avg Response Time */}
            <Card className="hover:shadow-md transition-shadow">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">Avg Response Time</p>
                  <div className="size-8 rounded-lg bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center">
                    <Clock className="size-4 text-indigo-600" />
                  </div>
                </div>
                <p className="text-2xl font-bold font-mono mt-2">{analytics.avgResponseTime}<span className="text-sm font-normal text-muted-foreground ml-1">ms</span></p>
                <div className="flex items-center gap-1 mt-1">
                  <TrendingDown className="size-3 text-indigo-500" />
                  <span className="text-xs text-indigo-600 font-medium">-8.3%</span>
                  <span className="text-xs text-muted-foreground">faster</span>
                </div>
              </CardContent>
            </Card>

            {/* Error Rate */}
            <Card className="hover:shadow-md transition-shadow">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">Error Rate</p>
                  <div className="size-8 rounded-lg bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                    <AlertTriangle className="size-4 text-red-600" />
                  </div>
                </div>
                <p className="text-2xl font-bold font-mono mt-2">{analytics.errorRate}<span className="text-sm font-normal text-muted-foreground ml-1">%</span></p>
                <div className="flex items-center gap-1 mt-1">
                  {analytics.errorRate < 2 ? (
                    <>
                      <TrendingDown className="size-3 text-indigo-500" />
                      <span className="text-xs text-indigo-600 font-medium">Healthy</span>
                    </>
                  ) : (
                    <>
                      <TrendingUp className="size-3 text-red-500" />
                      <span className="text-xs text-red-600 font-medium">Above threshold</span>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Unique Visitors */}
            <Card className="hover:shadow-md transition-shadow">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">Unique Visitors</p>
                  <div className="size-8 rounded-lg bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center">
                    <Users className="size-4 text-indigo-600" />
                  </div>
                </div>
                <p className="text-2xl font-bold font-mono mt-2">{formatNumber(analytics.uniqueVisitors)}</p>
                <div className="flex items-center gap-1 mt-1">
                  <TrendingUp className="size-3 text-indigo-500" />
                  <span className="text-xs text-indigo-600 font-medium">+5.2%</span>
                  <span className="text-xs text-muted-foreground">vs last period</span>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Charts - 2 col grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <RequestsChart data={analytics.requestsByDay} />
            <ResponseTimeChart data={analytics.responseTimeByDay} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <TopPathsChart data={analytics.topPaths} />
            <GeoDistribution data={analytics.geoDistribution} />
          </div>

          {/* Bandwidth info */}
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="size-8 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                    <Zap className="size-4 text-amber-600" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Bandwidth Used</p>
                    <p className="text-lg font-bold font-mono">{analytics.bandwidth} <span className="text-sm font-normal text-muted-foreground">MB</span></p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={fetchAnalytics}
                  className="h-8 text-xs"
                >
                  <Loader2 className="size-3.5 mr-1 animate-spin hidden" />
                  Refresh
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <BarChart3 className="size-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold mb-1">No analytics data</h3>
            <p className="text-sm text-muted-foreground">
              Select a project to view its analytics
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
