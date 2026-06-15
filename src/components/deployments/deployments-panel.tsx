'use client'

import { useState, useEffect, useCallback } from 'react'
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
import {
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
  const token = localStorage.getItem('deployhub_token')
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
  building: { className: 'bg-blue-100 text-blue-700 border-blue-200', label: 'Building' },
  deploying: { className: 'bg-purple-100 text-purple-700 border-purple-200', label: 'Deploying' },
  live: { className: 'bg-emerald-100 text-emerald-700 border-emerald-200', label: 'Live' },
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

// ── Component ──────────────────────────────────────────────────────────
export function DeploymentsPanel() {
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DeploymentDetail | null>(null)
  const [logs, setLogs] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [rollbackLoading, setRollbackLoading] = useState(false)

  const fetchDeployments = useCallback(async () => {
    setLoading(true)
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
    const isLive = detail.status === 'live'
    const isAnimating = detail.status === 'building' || detail.status === 'deploying'

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
                  <Rocket className="size-5 text-emerald-600" />
                  {detail.project.name}
                </CardTitle>
                <CardDescription className="flex flex-wrap items-center gap-3">
                  <span className="flex items-center gap-1">
                    <GitBranch className="size-3.5" />
                    {detail.branch}
                  </span>
                  <span className="font-mono text-xs">
                    {(detail.commit || '').slice(0, 7)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="size-3.5" />
                    {formatDuration(detail.duration)}
                  </span>
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <DeployStatusBadge status={detail.status} />
                {isLive && (
                  <Button
                    variant="destructive"
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
                {detail.deployUrl && (
                  <Button variant="outline" size="sm" asChild>
                    <a href={detail.deployUrl} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="size-4 mr-1" />
                      Visit
                    </a>
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
        </Card>

        {/* Build Logs */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Terminal className="size-4 text-emerald-600" />
              Build Logs
              {isAnimating && (
                <span className="flex items-center gap-1 text-sm text-emerald-600 ml-2">
                  <span className="relative flex size-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                  </span>
                  Live
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg bg-zinc-950 text-zinc-100 p-4 font-mono text-xs leading-relaxed">
              <ScrollArea className="max-h-96">
                <pre className="whitespace-pre-wrap break-words">
                  {detailLoading
                    ? 'Loading logs...'
                    : logs || 'No build logs available'}
                </pre>
              </ScrollArea>
            </div>
          </CardContent>
          <CardFooter className="text-xs text-muted-foreground gap-4">
            <span>Created: {new Date(detail.createdAt).toLocaleString()}</span>
            <span>Updated: {new Date(detail.updatedAt).toLocaleString()}</span>
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
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Recent Deployments</h2>
        <Button variant="outline" size="sm" onClick={fetchDeployments}>
          Refresh
        </Button>
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deployments.map((d) => (
                    <TableRow
                      key={d.id}
                      className="cursor-pointer hover:bg-emerald-50/50 transition-colors"
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
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
