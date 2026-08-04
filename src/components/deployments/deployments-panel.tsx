'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  joinDeploymentRoom,
  leaveDeploymentRoom,
  type DeploymentLogData,
  type DeploymentStatusData,
} from '@/lib/socket'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Trash2,
  GitBranch,
  Clock,
  ArrowLeft,
  RotateCcw,
  ExternalLink,
  Loader2,
  Rocket,
  Terminal,
  User,
  Webhook,
  Bot,
  CheckCircle2,
  XCircle,
  Filter,
  Globe,
  Wifi,
  WifiOff,
  Search,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

// ── Types ──────────────────────────────────────────────────────────────
interface Deployment {
  id: string
  projectId: string
  commit: string | null
  branch: string
  status: string
  deployUrl: string | null
  duration: number | null
  triggeredBy: string
  createdAt: string
  updatedAt: string
  project: {
    id: string
    name: string
    slug: string
    subdomain: string
    framework?: string
  }
}

interface DeploymentDetail extends Deployment {
  buildLog: string | null
}

// ── API helper ─────────────────────────────────────────────────────────
async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('apsamo_token')
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(data.error || `Request failed with status ${res.status}`)
  }
  return res.json()
}

// ── Status badge ───────────────────────────────────────────────────────
const STATUS_CONFIG: Record<string, { className: string; label: string }> = {
  queued: { className: 'bg-yellow-100 text-yellow-700 border-yellow-200', label: 'Queued' },
  building: { className: 'bg-indigo-100 text-indigo-700 border-indigo-200', label: 'Building' },
  deploying: { className: 'bg-indigo-100 text-indigo-700 border-indigo-200', label: 'Deploying' },
  live: { className: 'bg-indigo-100 text-indigo-700 border-indigo-200', label: 'Live' },
  failed: { className: 'bg-red-100 text-red-700 border-red-200', label: 'Failed' },
  rolled_back: { className: 'bg-gray-100 text-gray-600 border-gray-200', label: 'Rolled Back' },
}

function DeployStatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.queued
  const isAnimating = status === 'building' || status === 'deploying'
  return (
    <Badge variant="outline" className={`${cfg.className} ${isAnimating ? 'animate-pulse' : ''}`}>
      {isAnimating && <Loader2 className="size-3 animate-spin mr-1" />}
      {cfg.label}
    </Badge>
  )
}

// ── Time helpers ───────────────────────────────────────────────────────
function timeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '—'
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

function triggeredByIcon(trigger: string) {
  switch (trigger) {
    case 'user':
      return <User className="size-3.5" />
    case 'webhook':
      return <Webhook className="size-3.5" />
    case 'auto':
      return <Bot className="size-3.5" />
    default:
      return <User className="size-3.5" />
  }
}

// ── Simulated build logs ───────────────────────────────────────────────
function generateSimulatedBuildLog(deployment: DeploymentDetail): string {
  const isFailed = deployment.status === 'failed'
  const isBuilding = deployment.status === 'building' || deployment.status === 'deploying'
  const fw = deployment.project?.framework === 'nextjs' ? 'next' : (deployment.project?.framework || 'node')
  const now = new Date(deployment.createdAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  const ts = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`

  if (isFailed) {
    return `${ts} > Cloning repository...
${ts} ✓ Repository cloned successfully
${ts} > Installing dependencies...
${ts} > npm install --production
${ts} ✓ Dependencies installed (1.2s)
${ts} > Building application...
${ts} > ${fw} build
${ts} ✗ Type error: Property 'fetchData' does not exist on type 'never'.
${ts} ✗ Build failed with 1 error
${ts} > Error: Build process exited with code 1
${ts} > Deployment failed!`
  }

  if (isBuilding) {
    return `${ts} > Cloning repository...
${ts} ✓ Repository cloned successfully
${ts} > Installing dependencies...
${ts} > npm install --production
${ts} ✓ Dependencies installed (1.2s)
${ts} > Building application...
${ts} > ${fw} build
${ts} ⠹ Compiling...`
  }

  return `${ts} > Cloning repository...
${ts} ✓ Repository cloned successfully
${ts} > Installing dependencies...
${ts} > npm install --production
${ts} ✓ Dependencies installed (1.2s)
${ts} > Building application...
${ts} > ${fw} build
${ts} ✓ Compiled successfully
${ts} ✓ Linting and checking validity of types
${ts} ✓ Collecting page data
${ts} ✓ Generating static pages
${ts} ✓ Finalizing page optimization
${ts} > Deploying to server...
${ts} ✓ Deployment successful!
${ts} > Live at https://${deployment.project?.subdomain || 'myapp.apsamo.com'}`
}

function colorizeLogLine(line: string): React.ReactNode {
  if (line.includes('✓') || line.includes('successful') || line.includes('Live at')) {
    return <span className="text-indigo-400">{line}</span>
  }
  if (line.includes('✗') || line.includes('Error') || line.includes('failed')) {
    return <span className="text-red-400">{line}</span>
  }
  if (line.includes('Warning') || line.includes('warn') || line.includes('⠹') || line.includes('⠋') || line.includes('⠼')) {
    return <span className="text-yellow-400">{line}</span>
  }
  if (line.startsWith('>')) {
    return <span className="text-zinc-400">{line}</span>
  }
  return <span className="text-zinc-200">{line}</span>
}

// ── Component ──────────────────────────────────────────────────────────
export function DeploymentsPanel() {
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DeploymentDetail | null>(null)
  const [logs, setLogs] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [rollbackLoading, setRollbackLoading] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [activeFilter, setActiveFilter] = useState('all')
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('') // debounced
  const autoRefreshRef = useRef<NodeJS.Timeout | null>(null)

  // Real-time WebSocket state
  const [liveLogs, setLiveLogs] = useState<string[]>([])
  const [liveStatus, setLiveStatus] = useState<string | null>(null)
  const [isLiveConnected, setIsLiveConnected] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)

  const fetchDeployments = useCallback(async () => {
    try {
      const data = await apiFetch<{ deployments: Deployment[] }>('/deployments')
      setDeployments(data.deployments)
    } catch {
      toast.error('Failed to load deployments')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchDeployments()
  }, [fetchDeployments])

  // ── Debounce search input (300ms) ─────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput.trim().toLowerCase()), 300)
    return () => clearTimeout(t)
  }, [searchInput])

  // Auto-refresh when there are active deployments
  useEffect(() => {
    const hasActiveDeployments = deployments.some(
      (d) => d.status === 'building' || d.status === 'deploying' || d.status === 'queued'
    )

    if (hasActiveDeployments) {
      autoRefreshRef.current = setInterval(() => {
        fetchDeployments()
      }, 3000)
    }

    return () => {
      if (autoRefreshRef.current) {
        clearInterval(autoRefreshRef.current)
        autoRefreshRef.current = null
      }
    }
  }, [deployments, fetchDeployments])

  // ── WebSocket real-time log streaming with SSE fallback ────────────────
  useEffect(() => {
    if (!selectedId) return

    const isActive = detail?.status === 'building' || detail?.status === 'deploying' || detail?.status === 'queued' || liveStatus === 'building' || liveStatus === 'deploying' || liveStatus === 'queued'

    if (!isActive) return

    // Clear previous live logs when connecting to a new deployment
    setLiveLogs([])
    setIsLiveConnected(true)

    let cleanupFn: (() => void) | null = null

    // Try WebSocket first, fallback to SSE
    try {
      const handleLog = (data: DeploymentLogData) => {
        if (data.deploymentId === selectedId) {
          setLiveLogs((prev) => [...prev, data.line])
        }
      }

      const handleStatus = (data: DeploymentStatusData) => {
        if (data.deploymentId === selectedId) {
          setLiveStatus(data.status)

          if (data.status === 'live' || data.status === 'failed' || data.status === 'rolled_back') {
            setDetail((prev) => prev ? { ...prev, status: data.status, deployUrl: data.url || prev.deployUrl } : prev)
            setIsLiveConnected(false)
            fetchDeployments()
            if (data.status === 'live') {
              toast.success('Deployment is now live!')
            }
          }
        }
      }

      joinDeploymentRoom(selectedId, handleLog, handleStatus)
      cleanupFn = () => {
        leaveDeploymentRoom(selectedId)
      }
    } catch {
      // WebSocket not available, use SSE fallback
      const token = localStorage.getItem('apsamo_token')
      const eventSource = new EventSource(`/api/deployments/${selectedId}/events?token=${token}`)

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.status) {
            setLiveStatus(data.status)
          }
          if (data.buildLog) {
            const lines = data.buildLog.split('\n').filter(Boolean)
            setLiveLogs(lines)
          }
          if (data.status === 'live' || data.status === 'failed' || data.status === 'rolled_back') {
            setDetail((prev) => prev ? { ...prev, status: data.status, deployUrl: data.deployUrl || prev.deployUrl, duration: data.duration || prev.duration } : prev)
            setIsLiveConnected(false)
            eventSource.close()
            fetchDeployments()
            if (data.status === 'live') {
              toast.success('Deployment is now live!')
            }
          }
        } catch {
          // Ignore parse errors
        }
      }

      eventSource.onerror = () => {
        eventSource.close()
        setIsLiveConnected(false)
      }

      cleanupFn = () => {
        eventSource.close()
      }
    }

    return () => {
      if (cleanupFn) cleanupFn()
      setIsLiveConnected(false)
      setLiveStatus(null)
    }
  }, [selectedId, detail?.status, liveStatus, fetchDeployments])

  // Auto-scroll to bottom when new live logs arrive
  useEffect(() => {
    if (logEndRef.current && liveLogs.length > 0) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [liveLogs])

  // Clean up live logs when deselecting
  useEffect(() => {
    if (!selectedId) {
      setLiveLogs([])
      setLiveStatus(null)
      setIsLiveConnected(false)
    }
  }, [selectedId])

  const fetchDetail = useCallback(async (id: string) => {
    setDetailLoading(true)
    try {
      const data = await apiFetch<{
        deployment: DeploymentDetail
        logs: string
      }>(`/deployments/${id}/logs`)
      setDetail(data.deployment)
      setLogs(data.logs)
    } catch {
      toast.error('Failed to load deployment logs')
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    if (selectedId) {
      fetchDetail(selectedId)
    }
  }, [selectedId, fetchDetail])

  const handleDelete = async (id: string) => {
    if (
      !window.confirm(
        'Delete this deployment record?\n\nIt removes the build log and stage ' +
          'history. The site itself is not touched.'
      )
    ) {
      return
    }
    setDeleteLoading(true)
    try {
      await apiFetch(`/deployments/${id}`, { method: 'DELETE' })
      toast.success('Deployment removed')
      setSelectedId(null)
      setDetail(null)
      await fetchDeployments()
    } catch (err) {
      // The route explains itself — "currently serving the site", "the only
      // successful deployment" — so surface that, not a generic failure.
      toast.error(err instanceof Error ? err.message : 'Could not delete the deployment')
    } finally {
      setDeleteLoading(false)
    }
  }

  const handleRollback = async (id: string) => {
    setRollbackLoading(true)
    try {
      await apiFetch(`/deployments/${id}/rollback`, { method: 'POST' })
      toast.success('Deployment rolled back successfully')
      setSelectedId(null)
      setDetail(null)
      await fetchDeployments()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Rollback failed')
    } finally {
      setRollbackLoading(false)
    }
  }

  // Filter deployments by status tab + search query
  const filteredDeployments = deployments.filter((d) => {
    // Status filter
    if (activeFilter === 'live' && d.status !== 'live') return false
    if (
      activeFilter === 'building' &&
      !['building', 'deploying', 'queued'].includes(d.status)
    )
      return false
    if (
      activeFilter === 'failed' &&
      !['failed', 'rolled_back'].includes(d.status)
    )
      return false

    // Search filter (by project name, branch, or commit)
    if (searchQuery) {
      const haystack = `${d.project.name} ${d.branch} ${d.commit || ''} ${d.project.subdomain} ${d.project.slug} ${d.triggeredBy}`.toLowerCase()
      if (!haystack.includes(searchQuery)) return false
    }
    return true
  })

  // Count for tabs (apply search to counts too so the user sees how many
  // matches exist in each bucket)
  const searchFiltered = deployments.filter((d) => {
    if (!searchQuery) return true
    const haystack = `${d.project.name} ${d.branch} ${d.commit || ''} ${d.project.subdomain} ${d.project.slug} ${d.triggeredBy}`.toLowerCase()
    return haystack.includes(searchQuery)
  })
  const counts = {
    all: searchFiltered.length,
    live: searchFiltered.filter((d) => d.status === 'live').length,
    building: searchFiltered.filter((d) =>
      ['building', 'deploying', 'queued'].includes(d.status)
    ).length,
    failed: searchFiltered.filter((d) =>
      ['failed', 'rolled_back'].includes(d.status)
    ).length,
  }

  // ── Loading skeleton ────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    )
  }

  // ── Detail View ─────────────────────────────────────────────────────
  if (selectedId && detail) {
    // Use liveStatus from WebSocket if available, otherwise fall back to detail.status
    const currentStatus = liveStatus || detail.status
    const isLive = currentStatus === 'live'
    const isFailed = currentStatus === 'failed' || currentStatus === 'rolled_back'
    const isAnimating = currentStatus === 'building' || currentStatus === 'deploying' || currentStatus === 'queued'

    // For active deployments, use live logs if available; for completed ones, use static logs
    const useLiveLogs = isAnimating && liveLogs.length > 0
    const displayLog = useLiveLogs ? liveLogs.join('\n') : (logs || generateSimulatedBuildLog(detail))

    return (
      <div className="space-y-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSelectedId(null)
            setDetail(null)
          }}
          className="mb-2"
        >
          <ArrowLeft className="size-4 mr-1" />
          Back to deployments
        </Button>

        {/* Header */}
        <Card>
          <CardHeader>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2">
                  <Rocket className="size-5 text-indigo-600" />
                  {detail.project.name}
                  {/* Live status indicator */}
                  {isAnimating && (
                    <span className="flex items-center gap-1 text-sm text-indigo-600 ml-1">
                      <span className="relative flex size-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                        <span className="relative inline-flex size-2 rounded-full bg-indigo-500" />
                      </span>
                      Active
                    </span>
                  )}
                  {isLive && (
                    <span className="flex items-center gap-1 text-sm text-indigo-600 ml-1">
                      <span className="relative flex size-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                        <span className="relative inline-flex size-2 rounded-full bg-indigo-500" />
                      </span>
                      Live
                    </span>
                  )}
                </CardTitle>
                <CardDescription className="flex flex-wrap items-center gap-3">
                  <span className="flex items-center gap-1">
                    <GitBranch className="size-3.5" />
                    {detail.branch}
                  </span>
                  <span className="font-mono text-xs">
                    {(detail.commit || 'Initial deploy').slice(0, 7)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="size-3.5" />
                    {formatDuration(detail.duration)}
                  </span>
                </CardDescription>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <DeployStatusBadge status={detail.status} />
                {isLive && detail.deployUrl && (
                  <Button variant="outline" size="sm" asChild>
                    <a href={detail.deployUrl} target="_blank" rel="noopener noreferrer">
                      <Globe className="size-4 mr-1" />
                      Visit Site
                    </a>
                  </Button>
                )}
                {(isLive || isFailed) && (
                  <Button
                    variant={isLive ? 'destructive' : 'outline'}
                    size="sm"
                    disabled={rollbackLoading}
                    onClick={() => handleRollback(detail.id)}
                  >
                    {rollbackLoading ? (
                      <Loader2 className="size-4 animate-spin mr-1" />
                    ) : (
                      <RotateCcw className="size-4 mr-1" />
                    )}
                    Rollback
                  </Button>
                )}
                {/* Shown even when it cannot apply, disabled with the reason.
                    Hiding it made the feature look absent — which is exactly
                    what happened when the only deployment was live. */}
                {true && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive disabled:text-muted-foreground"
                    title={
                      isLive
                        ? 'This deployment is serving the site. Deploy again first.'
                        : 'Remove this deployment record'
                    }
                    disabled={deleteLoading || isLive}
                    onClick={() => handleDelete(detail.id)}
                  >
                    {deleteLoading ? (
                      <Loader2 className="size-4 animate-spin mr-1" />
                    ) : (
                      <Trash2 className="size-4 mr-1" />
                    )}
                    Delete
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
        </Card>

        {/* Deployment Metadata */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Deployment Metadata</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Triggered By</p>
                <div className="flex items-center gap-1.5 text-sm font-medium capitalize">
                  {triggeredByIcon(detail.triggeredBy)}
                  {detail.triggeredBy}
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Branch</p>
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <GitBranch className="size-3.5 text-muted-foreground" />
                  {detail.branch}
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Commit</p>
                <p className="text-sm font-mono font-medium">
                  {detail.commit ? detail.commit.slice(0, 7) : '—'}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Duration</p>
                <p className="text-sm font-medium">{formatDuration(detail.duration)}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Created</p>
                <p className="text-sm">{new Date(detail.createdAt).toLocaleString()}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Updated</p>
                <p className="text-sm">{new Date(detail.updatedAt).toLocaleString()}</p>
              </div>
              {detail.deployUrl && (
                <div className="space-y-1 col-span-2">
                  <p className="text-xs text-muted-foreground">Deploy URL</p>
                  <a
                    href={detail.deployUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-mono text-indigo-600 hover:underline flex items-center gap-1"
                  >
                    {detail.deployUrl}
                    <ExternalLink className="size-3" />
                  </a>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Build Logs */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Terminal className="size-4 text-indigo-600" />
              Build Logs
              {isAnimating && (
                <span className="flex items-center gap-1 text-sm text-indigo-600 ml-2">
                  <span className="relative flex size-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                    <span className="relative inline-flex size-2 rounded-full bg-indigo-500" />
                  </span>
                  Live
                </span>
              )}
              {/* WebSocket connection indicator */}
              {isAnimating && (
                <span className={`flex items-center gap-1 text-xs ml-auto px-2 py-0.5 rounded-full ${isLiveConnected ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'}`}>
                  {isLiveConnected ? (
                    <>
                      <Wifi className="size-3" />
                      Streaming
                    </>
                  ) : (
                    <>
                      <WifiOff className="size-3" />
                      Connecting...
                    </>
                  )}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg bg-zinc-950 border border-zinc-800 overflow-hidden">
              {/* Terminal header bar */}
              <div className="flex items-center gap-2 px-4 py-2 bg-zinc-900 border-b border-zinc-800">
                <div className="size-3 rounded-full bg-red-500/80" />
                <div className="size-3 rounded-full bg-yellow-500/80" />
                <div className="size-3 rounded-full bg-green-500/80" />
                <span className="ml-2 text-xs text-zinc-500 font-mono">build log — {detail.project.name}</span>
                {useLiveLogs && (
                  <span className="ml-auto text-xs text-indigo-400 font-mono flex items-center gap-1">
                    <span className="relative flex size-1.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                      <span className="relative inline-flex size-1.5 rounded-full bg-indigo-500" />
                    </span>
                    {liveLogs.length} lines
                  </span>
                )}
              </div>
              {/* Terminal content */}
              <div className="p-4 font-mono text-xs leading-relaxed max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700">
                <pre className="whitespace-pre-wrap break-words">
                  {detailLoading
                    ? 'Loading logs...'
                    : displayLog.split('\n').map((line, i) => (
                        <div key={i}>{colorizeLogLine(line)}</div>
                      ))
                  }
                  {/* Auto-scroll anchor */}
                  <div ref={logEndRef} />
                </pre>
              </div>
            </div>
          </CardContent>
          <CardFooter className="text-xs text-muted-foreground gap-4">
            <span>Created: {new Date(detail.createdAt).toLocaleString()}</span>
            <span>Updated: {new Date(detail.updatedAt).toLocaleString()}</span>
            {useLiveLogs && (
              <span className="ml-auto text-indigo-600 dark:text-indigo-400 flex items-center gap-1">
                <Wifi className="size-3" />
                Real-time
              </span>
            )}
          </CardFooter>
        </Card>
      </div>
    )
  }

  // ── Detail loading ──────────────────────────────────────────────────
  if (selectedId && detailLoading) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" className="mb-2" disabled>
          <ArrowLeft className="size-4 mr-1" />
          Back to deployments
        </Button>
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    )
  }

  // ── List View ───────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-xl font-semibold">Recent Deployments</h2>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              type="search"
              placeholder="Search by project, branch, commit..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-9 pr-8 h-9 w-48 sm:w-64"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchInput('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={fetchDeployments}>
            <RotateCcw className="size-4 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      {deployments.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Rocket className="size-10 text-muted-foreground mb-3" />
            <p className="text-muted-foreground">No deployments yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Deploy a project to see it here
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Filter Tabs + Search */}
          <Tabs value={activeFilter} onValueChange={setActiveFilter}>
            <TabsList>
              <TabsTrigger value="all" className="gap-1">
                <Filter className="size-3.5" />
                All
                <Badge variant="secondary" className="ml-1 h-5 min-w-5 text-[10px] px-1.5">
                  {counts.all}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="live" className="gap-1">
                <CheckCircle2 className="size-3.5 text-indigo-500" />
                Live
                {counts.live > 0 && (
                  <Badge variant="secondary" className="ml-1 h-5 min-w-5 text-[10px] px-1.5 bg-indigo-100 text-indigo-700">
                    {counts.live}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="building" className="gap-1">
                <Loader2 className="size-3.5 text-indigo-500" />
                Building
                {counts.building > 0 && (
                  <Badge variant="secondary" className="ml-1 h-5 min-w-5 text-[10px] px-1.5 bg-indigo-100 text-indigo-700">
                    {counts.building}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="failed" className="gap-1">
                <XCircle className="size-3.5 text-red-500" />
                Failed
                {counts.failed > 0 && (
                  <Badge variant="secondary" className="ml-1 h-5 min-w-5 text-[10px] px-1.5 bg-red-100 text-red-700">
                    {counts.failed}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>

            <TabsContent value={activeFilter} className="mt-4">
              {filteredDeployments.length === 0 ? (
                <Card>
                  <CardContent className="flex flex-col items-center justify-center py-8 text-center">
                    <p className="text-muted-foreground text-sm">
                      {searchQuery
                        ? `No deployments matching "${searchInput}"`
                        : 'No deployments matching this filter'}
                    </p>
                    {searchQuery && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSearchInput('')}
                        className="mt-3"
                      >
                        <X className="size-3.5 mr-1" />
                        Clear search
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="p-0">
                    <div className="max-h-[500px] overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Project</TableHead>
                            <TableHead>Branch</TableHead>
                            <TableHead>Commit</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Triggered By</TableHead>
                            <TableHead>Duration</TableHead>
                            <TableHead>Time</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {filteredDeployments.map((d) => (
                            <TableRow
                              key={d.id}
                              className="cursor-pointer hover:bg-indigo-50/50 dark:hover:bg-indigo-950/20 transition-colors"
                              onClick={() => setSelectedId(d.id)}
                            >
                              <TableCell className="font-medium">
                                {d.project.name}
                              </TableCell>
                              <TableCell>
                                <span className="flex items-center gap-1 text-muted-foreground">
                                  <GitBranch className="size-3.5" />
                                  {d.branch}
                                </span>
                              </TableCell>
                              <TableCell className="font-mono text-xs text-muted-foreground">
                                {(d.commit || '—').slice(0, 7)}
                              </TableCell>
                              <TableCell>
                                <DeployStatusBadge status={d.status} />
                              </TableCell>
                              <TableCell>
                                <span className="flex items-center gap-1 text-muted-foreground capitalize text-sm">
                                  {triggeredByIcon(d.triggeredBy)}
                                  {d.triggeredBy}
                                </span>
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {formatDuration(d.duration)}
                              </TableCell>
                              <TableCell className="text-muted-foreground text-xs">
                                {timeAgo(d.createdAt)}
                              </TableCell>
                              <TableCell className="text-right">
                                {/* Shown on every row, disabled where it cannot
                                    apply. "You cannot delete this, and here is
                                    why" is more useful than no button at all. */}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-xs text-destructive hover:text-destructive disabled:text-muted-foreground"
                                  disabled={
                                    deleteLoading ||
                                    d.status === 'live' ||
                                    d.status === 'building' ||
                                    d.status === 'deploying'
                                  }
                                  title={
                                    d.status === 'live'
                                      ? 'This deployment is serving the site. Deploy again first.'
                                      : d.status === 'building' || d.status === 'deploying'
                                      ? 'Still running — wait for it to finish.'
                                      : 'Remove this deployment record'
                                  }
                                  onClick={(e) => {
                                    // The row opens the detail view; a delete
                                    // click must not also navigate.
                                    e.stopPropagation()
                                    handleDelete(d.id)
                                  }}
                                >
                                  <Trash2 className="size-3.5" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  )
}
