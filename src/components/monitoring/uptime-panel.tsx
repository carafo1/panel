'use client'

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import {
  Activity,
  Globe,
  Plus,
  Trash2,
  Clock,
  Zap,
  RefreshCw,
  ArrowLeft,
  ExternalLink,
  CheckCircle2,
  XCircle,
  HelpCircle,
  PauseCircle,
  Loader2,
  AlertTriangle,
  TrendingUp,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// ── Types ──────────────────────────────────────────────────────────────
interface ProjectRef {
  id: string
  name: string
  /** The site's real domain; null when none is connected. */
  address: string | null
}

interface Monitor {
  id: string
  projectId: string
  url: string
  intervalSec: number
  enabled: boolean
  lastStatus: string // 'up' | 'down' | 'unknown'
  lastCheckedAt: string | null
  uptimePct: number
  createdAt: string
  updatedAt: string
  project: ProjectRef
}

interface CheckRecord {
  id: string
  status: string
  responseTime: number | null
  statusCode?: number | null
  error?: string | null
  checkedAt: string
}

interface MonitorStats {
  monitorId: string
  hours: number
  uptimePct: number
  totalChecks: number
  upCount: number
  downCount: number
  avgResponseTime: number
  checks: CheckRecord[]
}

type StatusKey = 'up' | 'down' | 'unknown' | 'paused'

function statusKey(m: Monitor): StatusKey {
  if (!m.enabled) return 'paused'
  if (m.lastStatus === 'up') return 'up'
  if (m.lastStatus === 'down') return 'down'
  return 'unknown'
}

const STATUS_META: Record<
  StatusKey,
  { label: string; dot: string; badge: string; icon: typeof CheckCircle2 }
> = {
  up: {
    label: 'Operational',
    dot: 'bg-indigo-500',
    badge:
      'bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 border-indigo-500/30',
    icon: CheckCircle2,
  },
  down: {
    label: 'Down',
    dot: 'bg-red-500',
    badge:
      'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30',
    icon: XCircle,
  },
  unknown: {
    label: 'Pending',
    dot: 'bg-gray-400',
    badge:
      'bg-gray-500/10 text-gray-700 dark:text-gray-400 border-gray-500/30',
    icon: HelpCircle,
  },
  paused: {
    label: 'Paused',
    dot: 'bg-amber-500',
    badge:
      'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30',
    icon: PauseCircle,
  },
}

// ── Helpers ─────────────────────────────────────────────────────────────
function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'Never'
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diff = Math.max(0, now - then)
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function formatResponseTime(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function uptimeColor(pct: number): string {
  if (pct >= 99) return 'text-indigo-600 dark:text-indigo-400'
  if (pct >= 95) return 'text-amber-600 dark:text-amber-400'
  return 'text-red-600 dark:text-red-400'
}

function uptimeBarClass(pct: number): string {
  if (pct >= 99) return '[&_[data-slot=progress-indicator]]:bg-indigo-500'
  if (pct >= 95) return '[&_[data-slot=progress-indicator]]:bg-amber-500'
  return '[&_[data-slot=progress-indicator]]:bg-red-500'
}

// ── Add Monitor Dialog ──────────────────────────────────────────────────
function AddMonitorDialog({
  open,
  onOpenChange,
  projects,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  projects: ProjectRef[]
  onCreated: () => void
}) {
  const [projectId, setProjectId] = useState<string>('')
  const [url, setUrl] = useState('')
  const [intervalSec, setIntervalSec] = useState(60)
  const [submitting, setSubmitting] = useState(false)

  // Auto-pick the first project when the dialog opens.
  useEffect(() => {
    if (open && !projectId && projects.length > 0) {
      setProjectId(projects[0].id)
    }
  }, [open, projectId, projects])

  // When the user picks a project, prefill the URL field with its domain.
  useEffect(() => {
    if (!projectId) return
    const p = projects.find((x) => x.id === projectId)
    if (p && !url && p.address) {
      setUrl(`https://${p.address}`)
    }
  }, [projectId, projects, url])

  const reset = () => {
    setUrl('')
    setIntervalSec(60)
    setProjectId(projects[0]?.id || '')
  }

  const handleSubmit = async () => {
    if (!projectId) {
      toast.error('Please choose a project')
      return
    }
    if (!url.trim()) {
      toast.error('Please enter a URL to monitor')
      return
    }
    setSubmitting(true)
    try {
      await apiFetch('/monitors', {
        method: 'POST',
        body: JSON.stringify({ projectId, url: url.trim(), intervalSec }),
      })
      toast.success('Monitor created — first check will run shortly')
      reset()
      onOpenChange(false)
      onCreated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create monitor')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="size-5 text-indigo-600" />
            New Uptime Monitor
          </DialogTitle>
          <DialogDescription>
            Track the availability and response time of any HTTP endpoint.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="monitor-project">Project</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger id="monitor-project" className="w-full">
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    No projects available
                  </div>
                ) : (
                  projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="monitor-url">URL to monitor</Label>
            <div className="relative">
              <Globe className="absolute start-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                id="monitor-url"
                placeholder="https://example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="ps-9"
                autoComplete="url"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              A 2xx or 3xx response counts as “up”. Redirects are followed.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Check interval</Label>
            <div className="grid grid-cols-4 gap-2">
              {[30, 60, 300, 900].map((sec) => {
                const active = intervalSec === sec
                return (
                  <Button
                    key={sec}
                    type="button"
                    variant={active ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setIntervalSec(sec)}
                    className={
                      active
                        ? 'bg-indigo-600 hover:bg-indigo-700'
                        : ''
                    }
                  >
                    {sec < 60 ? `${sec}s` : sec < 3600 ? `${sec / 60}m` : `${sec / 60}m`}
                  </Button>
                )
              })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || projects.length === 0}
            className="bg-indigo-600 hover:bg-indigo-700"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin me-2" />
                Creating…
              </>
            ) : (
              <>
                <Plus className="size-4 me-2" />
                Create Monitor
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Uptime Sparkline (recent checks as colored bars) ────────────────────
function UptimeSparkline({ checks }: { checks: CheckRecord[] }) {
  // Show most recent 40 checks, oldest → newest (left → right).
  const recent = [...checks].slice(0, 40).reverse()
  if (recent.length === 0) {
    return (
      <div className="flex items-center justify-center h-10 text-xs text-muted-foreground">
        No checks yet
      </div>
    )
  }
  return (
    <div className="flex items-end gap-0.5 h-10">
      {recent.map((c) => (
        <div
          key={c.id}
          title={`${new Date(c.checkedAt).toLocaleString()} · ${c.status} · ${formatResponseTime(c.responseTime)}`}
          className={`flex-1 rounded-sm min-w-[3px] ${
            c.status === 'up' ? 'bg-indigo-500' : 'bg-red-500'
          }`}
          style={{ height: c.status === 'up' ? '100%' : '60%' }}
        />
      ))}
    </div>
  )
}

// ── Response Time Chart ─────────────────────────────────────────────────
function ResponseTimeGraph({ checks }: { checks: CheckRecord[] }) {
  // Oldest → newest.
  const data = [...checks].slice(0, 60).reverse().filter((c) => c.responseTime != null)
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-xs text-muted-foreground">
        No response time data yet
      </div>
    )
  }
  const maxTime = Math.max(...data.map((c) => c.responseTime || 0), 100)
  const chartHeight = 160
  const points = data
    .map((c, i) => {
      const x = (i / Math.max(data.length - 1, 1)) * 100
      const y = chartHeight - ((c.responseTime || 0) / maxTime) * chartHeight
      return `${x}%,${y}`
    })
    .join(' ')

  return (
    <div className="space-y-1">
      <div className="flex items-end gap-1">
        <div
          className="flex flex-col justify-between text-[10px] text-muted-foreground font-mono w-10 text-end pe-1"
          style={{ height: chartHeight }}
        >
          <span>{maxTime}ms</span>
          <span>{Math.round(maxTime / 2)}ms</span>
          <span>0ms</span>
        </div>
        <div className="flex-1 relative" style={{ height: chartHeight }}>
          <div className="absolute inset-0 flex flex-col justify-between pointer-events-none">
            <div className="border-b border-border/40" />
            <div className="border-b border-border/40" />
            <div className="border-b border-border/40" />
          </div>
          <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
            <polyline
              fill="none"
              stroke="#10b981"
              strokeWidth="2"
              strokeLinejoin="round"
              points={points}
            />
            {data.map((c, i) => {
              const x = (i / Math.max(data.length - 1, 1)) * 100
              const y = chartHeight - ((c.responseTime || 0) / maxTime) * chartHeight
              return (
                <circle
                  key={c.id}
                  cx={`${x}%`}
                  cy={y}
                  r="2.5"
                  fill={c.status === 'up' ? '#10b981' : '#ef4444'}
                />
              )
            })}
          </svg>
        </div>
      </div>
    </div>
  )
}

// ── Monitor Detail Dialog ───────────────────────────────────────────────
function MonitorDetailDialog({
  monitor,
  open,
  onOpenChange,
  onRefresh,
}: {
  monitor: Monitor | null
  open: boolean
  onOpenChange: (v: boolean) => void
  onRefresh: () => void
}) {
  const [stats, setStats] = useState<MonitorStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [hours, setHours] = useState(24)

  const loadStats = useCallback(async () => {
    if (!monitor) return
    setLoading(true)
    try {
      const data = await apiFetch(
        `/monitors/${monitor.id}/stats?hours=${hours}`,
        { method: 'GET' }
      )
      setStats(data as MonitorStats)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to load monitor stats'
      )
    } finally {
      setLoading(false)
    }
  }, [monitor, hours])

  useEffect(() => {
    if (open && monitor) {
      loadStats()
    }
     
  }, [open, monitor?.id, hours])

  if (!monitor) return null

  const key = statusKey(monitor)
  const meta = STATUS_META[key]
  const StatusIcon = meta.icon

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pe-6">
            <span className={`size-2.5 rounded-full ${meta.dot} animate-pulse`} />
            <span className="truncate">{monitor.url}</span>
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2 flex-wrap">
            <span>{monitor.project.name}</span>
            <span>·</span>
            <Badge variant="outline" className={meta.badge}>
              <StatusIcon className="size-3 me-1" />
              {meta.label}
            </Badge>
            <span>·</span>
            <a
              href={monitor.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-indigo-600 hover:underline"
            >
              Visit <ExternalLink className="size-3" />
            </a>
          </DialogDescription>
        </DialogHeader>

        {/* Range selector */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Clock className="size-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Range:</span>
            <Select
              value={String(hours)}
              onValueChange={(v) => setHours(Number(v))}
            >
              <SelectTrigger className="h-8 w-[110px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Last hour</SelectItem>
                <SelectItem value="6">Last 6h</SelectItem>
                <SelectItem value="24">Last 24h</SelectItem>
                <SelectItem value="168">Last 7d</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={loadStats}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
          </Button>
        </div>

        <ScrollArea className="flex-1 pe-2 -me-2">
          <div className="space-y-4 pe-2">
            {/* Stats grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Card className="p-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                  Uptime
                </div>
                <div className={`text-xl font-bold ${uptimeColor(stats?.uptimePct ?? monitor.uptimePct)}`}>
                  {(stats?.uptimePct ?? monitor.uptimePct).toFixed(2)}%
                </div>
              </Card>
              <Card className="p-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                  Checks
                </div>
                <div className="text-xl font-bold">{stats?.totalChecks ?? 0}</div>
              </Card>
              <Card className="p-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                  Avg response
                </div>
                <div className="text-xl font-bold">
                  {formatResponseTime(stats?.avgResponseTime ?? null)}
                </div>
              </Card>
              <Card className="p-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                  Incidents
                </div>
                <div className="text-xl font-bold text-red-600 dark:text-red-400">
                  {stats?.downCount ?? 0}
                </div>
              </Card>
            </div>

            {/* Uptime sparkline */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Activity className="size-4 text-indigo-600" />
                  Recent Checks
                </CardTitle>
                <CardDescription>
                  Each bar = one check (green = up, red = down)
                </CardDescription>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <Skeleton className="h-10 w-full" />
                ) : (
                  <UptimeSparkline checks={stats?.checks ?? []} />
                )}
              </CardContent>
            </Card>

            {/* Response time chart */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Zap className="size-4 text-indigo-600" />
                  Response Time
                </CardTitle>
                <CardDescription>Latency over the selected range</CardDescription>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <Skeleton className="h-40 w-full" />
                ) : (
                  <ResponseTimeGraph checks={stats?.checks ?? []} />
                )}
              </CardContent>
            </Card>

            {/* Recent checks list */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Clock className="size-4 text-indigo-600" />
                  Check Log
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="max-h-64 overflow-y-auto">
                  {(stats?.checks ?? []).length === 0 ? (
                    <div className="p-6 text-center text-sm text-muted-foreground">
                      No checks recorded in this range yet.
                    </div>
                  ) : (
                    <ul className="divide-y">
                      {(stats?.checks ?? []).slice(0, 30).map((c) => (
                        <li
                          key={c.id}
                          className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/40"
                        >
                          {c.status === 'up' ? (
                            <CheckCircle2 className="size-4 text-indigo-500 shrink-0" />
                          ) : (
                            <XCircle className="size-4 text-red-500 shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">
                                {c.status === 'up' ? 'OK' : 'Down'}
                              </span>
                              {c.statusCode != null && (
                                <Badge variant="outline" className="text-[10px] py-0">
                                  HTTP {c.statusCode}
                                </Badge>
                              )}
                              <span className="text-xs text-muted-foreground">
                                {formatResponseTime(c.responseTime)}
                              </span>
                            </div>
                            {c.error && (
                              <p className="text-xs text-red-600 dark:text-red-400 truncate">
                                {c.error}
                              </p>
                            )}
                          </div>
                          <span className="text-xs text-muted-foreground shrink-0">
                            {new Date(c.checkedAt).toLocaleString()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            onClick={() => {
              onRefresh()
              loadStats()
            }}
            className="bg-indigo-600 hover:bg-indigo-700"
          >
            <RefreshCw className="size-4 me-2" />
            Refresh
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Monitor Card ────────────────────────────────────────────────────────
function MonitorCard({
  monitor,
  onToggle,
  onDelete,
  onClick,
  toggling,
}: {
  monitor: Monitor
  onToggle: () => void
  onDelete: () => void
  onClick: () => void
  toggling: boolean
}) {
  const key = statusKey(monitor)
  const meta = STATUS_META[key]
  const StatusIcon = meta.icon

  return (
    <Card
      className="group cursor-pointer hover:border-indigo-500/40 hover:shadow-sm transition-all"
      onClick={onClick}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <div className="relative mt-0.5 shrink-0">
            <span className={`block size-3 rounded-full ${meta.dot}`} />
            {key === 'up' && (
              <span className="absolute inset-0 rounded-full animate-ping bg-indigo-500 opacity-40" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-sm font-medium truncate flex items-center gap-1.5">
                <Globe className="size-3.5 text-muted-foreground shrink-0" />
                <span className="truncate">{monitor.url}</span>
              </CardTitle>
              <Badge variant="outline" className={`text-[10px] py-0 ${meta.badge}`}>
                <StatusIcon className="size-2.5 me-1" />
                {meta.label}
              </Badge>
            </div>
            <CardDescription className="text-xs truncate mt-0.5">
              {monitor.project.name} · every {monitor.intervalSec < 60 ? `${monitor.intervalSec}s` : `${monitor.intervalSec / 60}m`}
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pb-3 pt-0">
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div>
            <div className="text-muted-foreground mb-1">Uptime</div>
            <div className={`font-semibold ${uptimeColor(monitor.uptimePct)}`}>
              {monitor.uptimePct.toFixed(2)}%
            </div>
          </div>
          <div>
            <div className="text-muted-foreground mb-1">Last check</div>
            <div className="font-medium">
              {formatRelativeTime(monitor.lastCheckedAt)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground mb-1">Interval</div>
            <div className="font-medium">
              {monitor.intervalSec < 60 ? `${monitor.intervalSec}s` : `${monitor.intervalSec / 60}m`}
            </div>
          </div>
        </div>
        <Progress
          value={monitor.uptimePct}
          className={`mt-3 h-1.5 ${uptimeBarClass(monitor.uptimePct)}`}
        />
      </CardContent>

      <CardFooter className="pt-0 pb-3 flex items-center justify-between gap-2">
        <div
          className="flex items-center gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          <Switch
            checked={monitor.enabled}
            onCheckedChange={onToggle}
            disabled={toggling}
            aria-label="Toggle monitoring"
          />
          <span className="text-xs text-muted-foreground">
            {monitor.enabled ? 'Enabled' : 'Paused'}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-red-600 hover:bg-red-500/10"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          aria-label="Delete monitor"
        >
          <Trash2 className="size-4" />
        </Button>
      </CardFooter>
    </Card>
  )
}

// ── Main Panel ──────────────────────────────────────────────────────────
export default function UptimePanel() {
  const [monitors, setMonitors] = useState<Monitor[]>([])
  const [projects, setProjects] = useState<ProjectRef[]>([])
  const [loading, setLoading] = useState(true)
  const [mounted, setMounted] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [detailMonitor, setDetailMonitor] = useState<Monitor | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Monitor | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  // Initial mount flag (for hydration safety with date formatting).
  useEffect(() => {
    setMounted(true)
  }, [])

  const loadMonitors = useCallback(async () => {
    try {
      const data = await apiFetch('/monitors', { method: 'GET' })
      setMonitors((data.monitors as Monitor[]) || [])
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to load monitors'
      )
    } finally {
      setLoading(false)
    }
  }, [])

  const loadProjects = useCallback(async () => {
    try {
      const data = await apiFetch('/hosting', { method: 'GET' })
      const list = ((data.projects as any[]) || []).map((p) => ({
        id: p.id,
        name: p.name,
        address: (p.address as string | null | undefined) ?? p.customDomain ?? null,
      }))
      setProjects(list)
    } catch {
      // Silently fail — user can still see existing monitors without this.
    }
  }, [])

  useEffect(() => {
    loadMonitors()
    loadProjects()
  }, [loadMonitors, loadProjects])

  const handleToggle = async (m: Monitor) => {
    setTogglingId(m.id)
    try {
      await apiFetch(`/monitors/${m.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !m.enabled }),
      })
      toast.success(m.enabled ? 'Monitor paused' : 'Monitor enabled')
      await loadMonitors()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to toggle monitor'
      )
    } finally {
      setTogglingId(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await apiFetch(`/monitors/${deleteTarget.id}`, { method: 'DELETE' })
      toast.success('Monitor deleted')
      setDeleteTarget(null)
      await loadMonitors()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to delete monitor'
      )
    } finally {
      setDeleting(false)
    }
  }

  const handleRunNow = async () => {
    setRunning(true)
    try {
      // Non-admin users will get a 403 from this endpoint; we surface the
      // error so they know to ask an admin to wire up a cron.
      const res = await apiFetch('/monitors/run', { method: 'POST' })
      toast.success(
        `Ran ${res.checked} check${res.checked === 1 ? '' : 's'} — ${res.up} up, ${res.down} down`
      )
      // Give the DB a moment then refresh.
      setTimeout(() => loadMonitors(), 500)
    } catch (err) {
      toast.error(
        err instanceof Error
          ? `Couldn't trigger sweep: ${err.message}`
          : 'Failed to trigger sweep'
      )
    } finally {
      setRunning(false)
    }
  }

  const openDetail = (m: Monitor) => {
    setDetailMonitor(m)
    setDetailOpen(true)
  }

  // Aggregate stats for the summary cards.
  const total = monitors.length
  const upCount = monitors.filter((m) => statusKey(m) === 'up').length
  const downCount = monitors.filter((m) => statusKey(m) === 'down').length
  const pausedCount = monitors.filter((m) => statusKey(m) === 'paused').length
  const avgUptime =
    total === 0
      ? 0
      : monitors.reduce((sum, m) => sum + m.uptimePct, 0) / total

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Activity className="size-5 text-indigo-600" />
            Uptime Monitoring
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Track the availability and latency of your deployed projects.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRunNow}
            disabled={running || total === 0}
          >
            {running ? (
              <Loader2 className="size-4 animate-spin me-2" />
            ) : (
              <RefreshCw className="size-4 me-2" />
            )}
            Run checks
          </Button>
          <Button
            onClick={() => setAddOpen(true)}
            size="sm"
            className="bg-indigo-600 hover:bg-indigo-700"
          >
            <Plus className="size-4 me-2" />
            Add Monitor
          </Button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Total Monitors
              </div>
              <div className="text-2xl font-bold">{mounted ? total : 0}</div>
            </div>
            <Activity className="size-5 text-muted-foreground" />
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Operational
              </div>
              <div className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">
                {mounted ? upCount : 0}
              </div>
            </div>
            <CheckCircle2 className="size-5 text-indigo-500" />
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Down
              </div>
              <div className="text-2xl font-bold text-red-600 dark:text-red-400">
                {mounted ? downCount : 0}
              </div>
            </div>
            <XCircle className="size-5 text-red-500" />
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Avg Uptime
              </div>
              <div className={`text-2xl font-bold ${uptimeColor(avgUptime)}`}>
                {mounted ? avgUptime.toFixed(2) : '0.00'}%
              </div>
            </div>
            <TrendingUp className="size-5 text-muted-foreground" />
          </div>
        </Card>
      </div>

      {/* Monitors list */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="p-4">
              <Skeleton className="h-4 w-3/4 mb-2" />
              <Skeleton className="h-3 w-1/2 mb-4" />
              <Skeleton className="h-16 w-full" />
              <div className="mt-4 flex justify-between">
                <Skeleton className="h-6 w-20" />
                <Skeleton className="h-6 w-8" />
              </div>
            </Card>
          ))}
        </div>
      ) : total === 0 ? (
        <Card className="p-8 text-center">
          <div className="mx-auto size-12 rounded-full bg-indigo-500/10 flex items-center justify-center mb-3">
            <Activity className="size-6 text-indigo-600" />
          </div>
          <h3 className="font-semibold mb-1">No monitors yet</h3>
          <p className="text-sm text-muted-foreground mb-4 max-w-md mx-auto">
            Add a monitor to track the uptime and response time of any HTTP
            endpoint. We'll ping it on a schedule and show you the results here.
          </p>
          {projects.length === 0 ? (
            <div className="inline-flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 px-3 py-1.5 rounded-md">
              <AlertTriangle className="size-3.5" />
              Create a project first to start monitoring.
            </div>
          ) : (
            <Button
              onClick={() => setAddOpen(true)}
              className="bg-indigo-600 hover:bg-indigo-700"
            >
              <Plus className="size-4 me-2" />
              Add your first monitor
            </Button>
          )}
        </Card>
      ) : pausedCount > 0 ? (
        <>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <PauseCircle className="size-3.5" />
            {pausedCount} monitor{pausedCount === 1 ? ' is' : 's are'} paused
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {monitors.map((m) => (
              <MonitorCard
                key={m.id}
                monitor={m}
                onToggle={() => handleToggle(m)}
                onDelete={() => setDeleteTarget(m)}
                onClick={() => openDetail(m)}
                toggling={togglingId === m.id}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {monitors.map((m) => (
            <MonitorCard
              key={m.id}
              monitor={m}
              onToggle={() => handleToggle(m)}
              onDelete={() => setDeleteTarget(m)}
              onClick={() => openDetail(m)}
              toggling={togglingId === m.id}
            />
          ))}
        </div>
      )}

      {/* Dialogs */}
      <AddMonitorDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        projects={projects}
        onCreated={loadMonitors}
      />

      <MonitorDetailDialog
        monitor={detailMonitor}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onRefresh={loadMonitors}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this monitor?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the monitor for{' '}
              <span className="font-medium text-foreground">
                {deleteTarget?.url}
              </span>{' '}
              and all of its historical check data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
            >
              {deleting ? (
                <Loader2 className="size-4 animate-spin me-2" />
              ) : (
                <Trash2 className="size-4 me-2" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
