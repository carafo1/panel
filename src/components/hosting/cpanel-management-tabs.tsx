'use client'

/**
 * cpanel-management-tabs.tsx
 * ==========================
 *
 * Four cPanel-style management tab components for the Apsamo Panel hosting
 * module. Each component is a self-contained client UI consuming its own
 * REST endpoints:
 *
 *   1. CronTab       — scheduled tasks (cron jobs) for the project container
 *   2. FtpTab        — FTP account CRUD with reveal-password + random-password
 *   3. RedirectsTab  — 301/302 URL redirects via Caddy redir directives
 *   4. SecurityTab   — IP block / allow rules with summary cards
 *
 * The components follow the exact same conventions as
 * `website-management-tabs.tsx`:
 *   - shadcn/ui components only (Card, Button, Input, Label, Select, Dialog, ...)
 *   - emerald accent color (NO indigo or blue as primary)
 *   - lucide-react icons
 *   - toast notifications via sonner
 *   - mobile-first responsive design
 *   - light + dark mode via Tailwind CSS variables
 *   - loading / error / empty states everywhere
 */

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
  Clock,
  Play,
  Plus,
  RefreshCw,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Trash2,
  Edit,
  Eye,
  EyeOff,
  Copy,
  FolderLock,
  HardDriveUpload,
  ArrowRightLeft,
  GitBranch,
  Shield,
  Ban,
  ShieldCheck,
  ShieldAlert,
  Calendar,
  Infinity as InfinityIcon,
  KeyRound,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// ─── Shared helpers (same as website-management-tabs.tsx) ──────────────

/** The httpOnly session cookie authenticates same-origin requests. */
function getAuthHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' }
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'never'
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 0) return 'just now'
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  try {
    return new Date(dateStr).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return dateStr
  }
}

async function copyToClipboard(text: string, label = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(label)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      toast.success(label)
    } catch {
      toast.error('Failed to copy')
    } finally {
      document.body.removeChild(ta)
    }
  }
}

function generateRandomPassword(len = 20): string {
  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*-_=+'
  const bytes = new Uint32Array(len)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 0xffffffff)
  }
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += alphabet[bytes[i] % alphabet.length]
  }
  return out
}

// Emerald-flavored primary button class (NO indigo/blue).
const primaryBtn = 'bg-emerald-600 hover:bg-emerald-700 text-white'
const primaryText = 'text-emerald-600 dark:text-emerald-400'

// ─── Types ───────────────────────────────────────────────────────────

interface CronJob {
  id: string
  expression: string
  command: string
  description: string | null
  enabled: boolean
  lastRunAt: string | null
  lastStatus: string | null
  lastOutput: string | null
  createdAt: string
  updatedAt: string
}

interface FtpAccount {
  id: string
  username: string
  passwordMasked: string
  passwordPlain?: string
  directory: string
  readOnly: boolean
  quotaMB: number | null
  enabled: boolean
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

interface RedirectRule {
  id: string
  fromPath: string
  toUrl: string
  statusCode: number
  matchQuery: string | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}

interface IpBlockRule {
  id: string
  ipAddress: string
  action: string // deny | allow
  reason: string | null
  enabled: boolean
  expiresAt: string | null
  createdAt: string
}

// ═══════════════════════════════════════════════════════════════════════
// 1. CronTab
// ═══════════════════════════════════════════════════════════════════════

const CRON_PRESETS: { label: string; expression: string }[] = [
  { label: 'Every minute', expression: '* * * * *' },
  { label: 'Hourly', expression: '0 * * * *' },
  { label: 'Daily (3am)', expression: '0 3 * * *' },
  { label: 'Weekly (Sun 3am)', expression: '0 3 * * 0' },
  { label: 'Monthly (1st 3am)', expression: '0 3 1 * *' },
]

export function CronTab({ projectId }: { projectId: string }) {
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [editJob, setEditJob] = useState<CronJob | null>(null)
  const [creating, setCreating] = useState(false)
  const [patching, setPatching] = useState<Record<string, boolean>>({})
  const [deleteJob, setDeleteJob] = useState<CronJob | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [runJob, setRunJob] = useState<CronJob | null>(null)
  const [running, setRunning] = useState(false)
  const [runOutput, setRunOutput] = useState<{
    status: string
    output: string
    exitCode: number | null
    durationMs: number
  } | null>(null)

  // form state shared between create + edit
  const [expression, setExpression] = useState('')
  const [command, setCommand] = useState('')
  const [description, setDescription] = useState('')

  const fetchJobs = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/cron`, {
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        setJobs(data.jobs || [])
      } else {
        toast.error(data.error || 'Failed to load cron jobs')
      }
    } catch {
      toast.error('Network error loading cron jobs')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    fetchJobs()
  }, [fetchJobs])

  const openCreate = () => {
    setExpression('* * * * *')
    setCommand('')
    setDescription('')
    setEditJob(null)
    setCreateOpen(true)
  }

  const openEdit = (j: CronJob) => {
    setExpression(j.expression)
    setCommand(j.command)
    setDescription(j.description || '')
    setEditJob(j)
    setCreateOpen(true)
  }

  const handleSave = async () => {
    const expr = expression.trim()
    const cmd = command.trim()
    if (!expr) {
      toast.error('Cron expression is required')
      return
    }
    if (!cmd) {
      toast.error('Command is required')
      return
    }
    setCreating(true)
    try {
      const url = editJob
        ? `/api/hosting/${projectId}/cron/${editJob.id}`
        : `/api/hosting/${projectId}/cron`
      const method = editJob ? 'PATCH' : 'POST'
      const body: Record<string, unknown> = { expression: expr, command: cmd }
      if (description.trim()) body.description = description.trim()
      const res = await fetch(url, {
        method,
        headers: getAuthHeaders(),
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(editJob ? 'Cron job updated' : 'Cron job created')
        setCreateOpen(false)
        setEditJob(null)
        fetchJobs()
      } else {
        toast.error(data.error || 'Failed to save cron job')
      }
    } catch {
      toast.error('Network error saving cron job')
    } finally {
      setCreating(false)
    }
  }

  const handleToggle = async (j: CronJob) => {
    setPatching((p) => ({ ...p, [j.id]: true }))
    try {
      const res = await fetch(`/api/hosting/${projectId}/cron/${j.id}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({ enabled: !j.enabled }),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(j.enabled ? 'Cron job disabled' : 'Cron job enabled')
        fetchJobs()
      } else {
        toast.error(data.error || 'Failed to toggle cron job')
      }
    } catch {
      toast.error('Network error updating cron job')
    } finally {
      setPatching((p) => ({ ...p, [j.id]: false }))
    }
  }

  const handleDelete = async () => {
    if (!deleteJob) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/cron/${deleteJob.id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success('Cron job deleted')
        setDeleteJob(null)
        fetchJobs()
      } else {
        toast.error(data.error || 'Failed to delete cron job')
      }
    } catch {
      toast.error('Network error deleting cron job')
    } finally {
      setDeleting(false)
    }
  }

  const handleRun = async () => {
    if (!runJob) return
    setRunning(true)
    setRunOutput(null)
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/cron/${runJob.id}?action=run`,
        { method: 'POST', headers: getAuthHeaders() }
      )
      const data = await res.json()
      if (res.ok) {
        setRunOutput({
          status: data.status,
          output: data.output || '',
          exitCode: data.exitCode,
          durationMs: data.durationMs || 0,
        })
        toast.success(data.ok ? 'Command succeeded' : 'Command finished')
        fetchJobs()
      } else {
        toast.error(data.error || 'Failed to run cron job')
      }
    } catch {
      toast.error('Network error running cron job')
    } finally {
      setRunning(false)
    }
  }

  const statusBadge = (status: string | null) => {
    if (!status) {
      return (
        <Badge variant="outline" className="bg-gray-50 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400 border-gray-200 dark:border-gray-700 text-xs">
          Never
        </Badge>
      )
    }
    if (status === 'success') {
      return (
        <Badge variant="outline" className="bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/50 text-xs">
          <CheckCircle2 className="size-3 me-1" />
          Success
        </Badge>
      )
    }
    if (status === 'failed') {
      return (
        <Badge variant="outline" className="bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 border-red-200 dark:border-red-900/50 text-xs">
          <XCircle className="size-3 me-1" />
          Failed
        </Badge>
      )
    }
    if (status === 'running') {
      return (
        <Badge variant="outline" className="bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 border-amber-200 dark:border-amber-900/50 text-xs">
          <Loader2 className="size-3 me-1 animate-spin" />
          Running
        </Badge>
      )
    }
    return <Badge variant="outline" className="text-xs">{status}</Badge>
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Clock className={`size-5 ${primaryText}`} />
              Cron Jobs
            </CardTitle>
            <CardDescription className="mt-1">
              Scheduled tasks that run inside the project container.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={fetchJobs} disabled={loading}>
              <RefreshCw className={`size-3.5 me-1 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button size="sm" className={primaryBtn} onClick={openCreate}>
              <Plus className="size-3.5 me-1" />
              New Job
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : jobs.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground">
            <Clock className="size-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">No cron jobs</p>
            <p className="text-xs mt-1">
              Schedule recurring tasks like backups, cache clears or sync jobs.
            </p>
            <Button className={`${primaryBtn} mt-4`} size="sm" onClick={openCreate}>
              <Plus className="size-3.5 me-1" />
              Create Your First Job
            </Button>
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Expression</TableHead>
                  <TableHead>Command</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Run</TableHead>
                  <TableHead className="text-end">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((j) => (
                  <TableRow
                    key={j.id}
                    className="hover:bg-emerald-50/40 dark:hover:bg-emerald-950/10 transition-colors"
                  >
                    <TableCell>
                      <span className="font-mono text-xs">{j.expression}</span>
                      {!j.enabled && (
                        <Badge variant="outline" className="ms-2 bg-gray-50 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400 border-gray-200 dark:border-gray-700 text-[10px] h-5">
                          Disabled
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="font-mono text-xs text-muted-foreground block max-w-[180px] truncate cursor-help">
                            {j.command}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-md break-all font-mono text-xs">
                          {j.command}
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[160px] truncate">
                      {j.description || '—'}
                    </TableCell>
                    <TableCell>{statusBadge(j.lastStatus)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>{timeAgo(j.lastRunAt)}</span>
                        </TooltipTrigger>
                        <TooltipContent>{formatDate(j.lastRunAt)}</TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell className="text-end">
                      <div className="flex items-center justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              disabled={!!patching[j.id]}
                              onClick={() => {
                                setRunJob(j)
                                setRunOutput(null)
                              }}
                            >
                              <Play className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Run now</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              disabled={!!patching[j.id]}
                              onClick={() => openEdit(j)}
                            >
                              <Edit className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Edit</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              disabled={!!patching[j.id]}
                              onClick={() => handleToggle(j)}
                            >
                              {patching[j.id] ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : j.enabled ? (
                                <ShieldCheck className="size-3.5 text-emerald-600" />
                              ) : (
                                <ShieldAlert className="size-3.5 text-muted-foreground" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {j.enabled ? 'Disable' : 'Enable'}
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20"
                              onClick={() => setDeleteJob(j)}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Delete</TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {/* Create / Edit dialog */}
      <Dialog open={createOpen} onOpenChange={(v) => !v && setCreateOpen(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className={`size-5 ${primaryText}`} />
              {editJob ? 'Edit Cron Job' : 'New Cron Job'}
            </DialogTitle>
            <DialogDescription>
              The command runs inside the project container. Schedule it with a standard
              5-field cron expression or an @-string.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="cron-expr">Expression</Label>
              <Input
                id="cron-expr"
                placeholder="* * * * *  or  @daily"
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
                className="font-mono text-sm"
                autoFocus
              />
              <div className="flex flex-wrap gap-1.5 mt-1">
                {CRON_PRESETS.map((p) => (
                  <button
                    key={p.expression}
                    type="button"
                    onClick={() => setExpression(p.expression)}
                    className="text-[10px] px-2 py-1 rounded-md border bg-muted/50 hover:bg-emerald-50 hover:text-emerald-700 dark:hover:bg-emerald-900/20 dark:hover:text-emerald-400 transition-colors"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Format: <span className="font-mono">min hour day month weekday</span>. Specials: @yearly @monthly @weekly @daily @hourly @reboot.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cron-cmd">Command</Label>
              <Textarea
                id="cron-cmd"
                placeholder="e.g. php /app/artisan schedule:run"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                className="font-mono text-sm min-h-[80px]"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cron-desc">Description (optional)</Label>
              <Input
                id="cron-desc"
                placeholder="e.g. Laravel scheduler"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button className={primaryBtn} onClick={handleSave} disabled={creating}>
              {creating ? (
                <>
                  <Loader2 className="size-4 me-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Plus className="size-4 me-2" />
                  {editJob ? 'Save Changes' : 'Create'}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Run output dialog */}
      <Dialog open={!!runJob} onOpenChange={(v) => !v && setRunJob(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Play className={`size-5 ${primaryText}`} />
              Run Output
            </DialogTitle>
            <DialogDescription>
              <span className="font-mono text-xs">{runJob?.command}</span>
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 border-b border-zinc-800">
              <span className="size-2 rounded-full bg-red-500/80" />
              <span className="size-2 rounded-full bg-amber-500/80" />
              <span className="size-2 rounded-full bg-emerald-500/80" />
              <span className="ms-2 text-[10px] text-zinc-500 font-mono truncate">
                {runJob?.expression} · {runJob?.id.slice(0, 8)}
              </span>
              {runOutput && (
                <span className="ms-auto text-[10px] font-mono">
                  <span className={runOutput.status === 'success' ? 'text-emerald-400' : 'text-red-400'}>
                    {runOutput.status === 'success' ? 'EXIT 0' : `EXIT ${runOutput.exitCode ?? '?'}`}
                  </span>
                  <span className="text-zinc-500 ms-2">{runOutput.durationMs}ms</span>
                </span>
              )}
            </div>
            <div className="p-3 text-xs font-mono text-emerald-400 overflow-auto h-72 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700">
              {running ? (
                <div className="text-zinc-400 flex items-center gap-2">
                  <Loader2 className="size-3.5 animate-spin" />
                  Running command...
                </div>
              ) : runOutput ? (
                <pre className="whitespace-pre-wrap break-all text-zinc-300">
                  {runOutput.output || '(no output)'}
                </pre>
              ) : (
                <div className="text-zinc-500">Click &ldquo;Run Now&rdquo; to execute.</div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRunJob(null)} disabled={running}>
              Close
            </Button>
            <Button
              className={primaryBtn}
              onClick={handleRun}
              disabled={running}
            >
              {running ? (
                <>
                  <Loader2 className="size-4 me-2 animate-spin" />
                  Running...
                </>
              ) : (
                <>
                  <Play className="size-4 me-2" />
                  Run Now
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteJob} onOpenChange={(v) => !v && setDeleteJob(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-red-500" />
              Delete Cron Job
            </AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete the cron job{' '}
              <span className="font-mono">{deleteJob?.expression} {deleteJob?.command}</span>?
              This will remove it from the container crontab immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deleting ? (
                <>
                  <Loader2 className="size-4 me-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="size-4 me-2" />
                  Delete
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// 2. FtpTab
// ═══════════════════════════════════════════════════════════════════════

export function FtpTab({ projectId }: { projectId: string }) {
  const [accounts, setAccounts] = useState<FtpAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [patching, setPatching] = useState<Record<string, boolean>>({})
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [revealing, setRevealing] = useState<Record<string, boolean>>({})
  const [changePw, setChangePw] = useState<FtpAccount | null>(null)
  const [deleteAccount, setDeleteAccount] = useState<FtpAccount | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [createdAccount, setCreatedAccount] = useState<FtpAccount | null>(null)

  // form state
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [directory, setDirectory] = useState('/')
  const [readOnly, setReadOnly] = useState(false)
  const [quotaMB, setQuotaMB] = useState('')

  // change-password form
  const [newPw, setNewPw] = useState('')
  const [showNewPw, setShowNewPw] = useState(false)

  const fetchAccounts = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/ftp`, {
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        setAccounts(data.accounts || [])
      } else {
        toast.error(data.error || 'Failed to load FTP accounts')
      }
    } catch {
      toast.error('Network error loading FTP accounts')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    fetchAccounts()
  }, [fetchAccounts])

  const openCreate = () => {
    setUsername('')
    setPassword(generateRandomPassword(20))
    setShowPw(false)
    setDirectory('/')
    setReadOnly(false)
    setQuotaMB('')
    setCreateOpen(true)
  }

  const handleCreate = async () => {
    const u = username.trim()
    if (!u) {
      toast.error('Username is required')
      return
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_\-]{2,31}$/.test(u)) {
      toast.error('Username must start with a letter, 3-32 chars (letters, digits, _ or -)')
      return
    }
    if (!password || password.length < 6) {
      toast.error('Password must be at least 6 characters')
      return
    }
    setCreating(true)
    try {
      const body: Record<string, unknown> = {
        username: u,
        password,
        directory: directory.trim() || '/',
        readOnly,
      }
      if (quotaMB.trim()) {
        const q = parseInt(quotaMB, 10)
        if (!Number.isNaN(q) && q > 0) body.quotaMB = q
      }
      const res = await fetch(`/api/hosting/${projectId}/ftp`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (res.ok && data.account) {
        toast.success('FTP account created')
        setCreateOpen(false)
        setCreatedAccount(data.account)
        fetchAccounts()
      } else {
        toast.error(data.error || 'Failed to create FTP account')
      }
    } catch {
      toast.error('Network error creating FTP account')
    } finally {
      setCreating(false)
    }
  }

  const handleReveal = async (a: FtpAccount) => {
    if (revealed[a.id]) {
      setRevealed((prev) => {
        const next = { ...prev }
        delete next[a.id]
        return next
      })
      return
    }
    setRevealing((p) => ({ ...p, [a.id]: true }))
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/ftp/${a.id}?reveal=true`,
        { headers: getAuthHeaders() }
      )
      const data = await res.json()
      if (res.ok && data.account?.passwordPlain) {
        setRevealed((prev) => ({ ...prev, [a.id]: data.account.passwordPlain }))
      } else {
        toast.error(data.error || 'Failed to reveal password')
      }
    } catch {
      toast.error('Network error revealing password')
    } finally {
      setRevealing((p) => ({ ...p, [a.id]: false }))
    }
  }

  const handleToggle = async (a: FtpAccount) => {
    setPatching((p) => ({ ...p, [a.id]: true }))
    try {
      const res = await fetch(`/api/hosting/${projectId}/ftp/${a.id}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({ enabled: !a.enabled }),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(a.enabled ? 'Account disabled' : 'Account enabled')
        fetchAccounts()
      } else {
        toast.error(data.error || 'Failed to toggle account')
      }
    } catch {
      toast.error('Network error updating account')
    } finally {
      setPatching((p) => ({ ...p, [a.id]: false }))
    }
  }

  const openChangePw = (a: FtpAccount) => {
    setNewPw(generateRandomPassword(20))
    setShowNewPw(false)
    setChangePw(a)
  }

  const handleChangePw = async () => {
    if (!changePw) return
    if (newPw.length < 6) {
      toast.error('Password must be at least 6 characters')
      return
    }
    setPatching((p) => ({ ...p, [changePw.id]: true }))
    try {
      const res = await fetch(`/api/hosting/${projectId}/ftp/${changePw.id}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({ password: newPw }),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success('Password updated')
        setChangePw(null)
        // Pre-reveal the new password.
        if (data.account?.passwordPlain) {
          setRevealed((prev) => ({ ...prev, [changePw.id]: data.account.passwordPlain }))
        }
        fetchAccounts()
      } else {
        toast.error(data.error || 'Failed to update password')
      }
    } catch {
      toast.error('Network error updating password')
    } finally {
      setPatching((p) => ({ ...p, [changePw.id]: false }))
    }
  }

  const handleDelete = async () => {
    if (!deleteAccount) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/ftp/${deleteAccount.id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success('Account deleted')
        setDeleteAccount(null)
        setRevealed((prev) => {
          const next = { ...prev }
          delete next[deleteAccount.id]
          return next
        })
        fetchAccounts()
      } else {
        toast.error(data.error || 'Failed to delete account')
      }
    } catch {
      toast.error('Network error deleting account')
    } finally {
      setDeleting(false)
    }
  }

  const accessBadge = (readOnly: boolean) =>
    readOnly ? (
      <Badge variant="outline" className="bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 border-amber-200 dark:border-amber-900/50 text-xs">
        Read-Only
      </Badge>
    ) : (
      <Badge variant="outline" className="bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/50 text-xs">
        Read-Write
      </Badge>
    )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <FolderLock className={`size-5 ${primaryText}`} />
              FTP Accounts
            </CardTitle>
            <CardDescription className="mt-1">
              Per-project FTP/SFTP credentials. Passwords are encrypted at rest.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={fetchAccounts} disabled={loading}>
              <RefreshCw className={`size-3.5 me-1 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button size="sm" className={primaryBtn} onClick={openCreate}>
              <Plus className="size-3.5 me-1" />
              New Account
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : accounts.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground">
            <FolderLock className="size-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">No FTP accounts</p>
            <p className="text-xs mt-1">
              Create an FTP account to upload files without using the panel.
            </p>
            <Button className={`${primaryBtn} mt-4`} size="sm" onClick={openCreate}>
              <Plus className="size-3.5 me-1" />
              Create Your First Account
            </Button>
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Username</TableHead>
                  <TableHead>Directory</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead>Quota</TableHead>
                  <TableHead>Last Login</TableHead>
                  <TableHead className="text-end">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((a) => (
                  <TableRow
                    key={a.id}
                    className={`hover:bg-emerald-50/40 dark:hover:bg-emerald-950/10 transition-colors ${!a.enabled ? 'opacity-60' : ''}`}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{a.username}</span>
                        {!a.enabled && (
                          <Badge variant="outline" className="bg-gray-50 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400 border-gray-200 dark:border-gray-700 text-[10px] h-5">
                            Disabled
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {a.directory}
                    </TableCell>
                    <TableCell>{accessBadge(a.readOnly)}</TableCell>
                    <TableCell className="text-xs">
                      {a.quotaMB ? `${a.quotaMB} MB` : (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <InfinityIcon className="size-3" />
                          unlimited
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>{timeAgo(a.lastLoginAt)}</span>
                        </TooltipTrigger>
                        <TooltipContent>{formatDate(a.lastLoginAt)}</TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell className="text-end">
                      <div className="flex items-center justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              disabled={!!revealing[a.id]}
                              onClick={() => handleReveal(a)}
                            >
                              {revealing[a.id] ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : revealed[a.id] ? (
                                <EyeOff className="size-3.5" />
                              ) : (
                                <Eye className="size-3.5" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {revealed[a.id] ? 'Hide password' : 'Reveal password'}
                          </TooltipContent>
                        </Tooltip>
                        {revealed[a.id] && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                onClick={() => copyToClipboard(revealed[a.id], 'Password copied')}
                              >
                                <Copy className="size-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Copy password</TooltipContent>
                          </Tooltip>
                        )}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              disabled={!!patching[a.id]}
                              onClick={() => openChangePw(a)}
                            >
                              <KeyRound className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Change password</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              disabled={!!patching[a.id]}
                              onClick={() => handleToggle(a)}
                            >
                              {patching[a.id] ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : a.enabled ? (
                                <ShieldCheck className="size-3.5 text-emerald-600" />
                              ) : (
                                <ShieldAlert className="size-3.5 text-muted-foreground" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {a.enabled ? 'Disable' : 'Enable'}
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20"
                              onClick={() => setDeleteAccount(a)}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Delete</TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={(v) => !v && setCreateOpen(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HardDriveUpload className={`size-5 ${primaryText}`} />
              New FTP Account
            </DialogTitle>
            <DialogDescription>
              The full username will be suffixed automatically to avoid collisions.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="ftp-user">Username</Label>
              <Input
                id="ftp-user"
                placeholder="e.g. uploader"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="font-mono text-sm"
                autoFocus
              />
              {username.trim() && (
                <p className="text-xs text-muted-foreground">
                  Full username: <span className="font-mono text-emerald-700 dark:text-emerald-400">{username.trim()}_&lt;slug&gt;</span>
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ftp-pw">Password</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="ftp-pw"
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="font-mono text-sm flex-1"
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="size-9"
                      onClick={() => setShowPw((s) => !s)}
                    >
                      {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{showPw ? 'Hide' : 'Show'}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="size-9"
                      onClick={() => setPassword(generateRandomPassword(20))}
                    >
                      <RefreshCw className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Generate random</TooltipContent>
                </Tooltip>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ftp-dir">Directory</Label>
              <Input
                id="ftp-dir"
                placeholder="/"
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Path relative to the project root. &ldquo;/&rdquo; = entire site.
              </p>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label className="text-sm">Read-only access</Label>
                <p className="text-xs text-muted-foreground">Disable uploads for this account.</p>
              </div>
              <Switch checked={readOnly} onCheckedChange={setReadOnly} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ftp-quota">Quota (MB, optional)</Label>
              <Input
                id="ftp-quota"
                type="number"
                min="1"
                placeholder="unlimited"
                value={quotaMB}
                onChange={(e) => setQuotaMB(e.target.value)}
                className="text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button className={primaryBtn} onClick={handleCreate} disabled={creating}>
              {creating ? (
                <>
                  <Loader2 className="size-4 me-2 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Plus className="size-4 me-2" />
                  Create
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Show password once after creation */}
      <Dialog open={!!createdAccount} onOpenChange={(v) => !v && setCreatedAccount(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="size-5 text-emerald-600" />
              FTP Account Created
            </DialogTitle>
            <DialogDescription>
              Save these credentials now — the password will be masked afterwards.
            </DialogDescription>
          </DialogHeader>
          {createdAccount && (
            <div className="grid gap-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Username</span>
                <span className="font-mono">{createdAccount.username}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={() => copyToClipboard(createdAccount.username, 'Username copied')}
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Password</span>
                <span className="font-mono text-xs break-all">
                  {createdAccount.passwordPlain || '****'}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={() =>
                    copyToClipboard(createdAccount.passwordPlain || '', 'Password copied')
                  }
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Directory</span>
                <span className="font-mono text-xs">{createdAccount.directory}</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button className={primaryBtn} onClick={() => setCreatedAccount(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change password dialog */}
      <Dialog open={!!changePw} onOpenChange={(v) => !v && setChangePw(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className={`size-5 ${primaryText}`} />
              Change Password
            </DialogTitle>
            <DialogDescription>
              For account <span className="font-mono">{changePw?.username}</span>.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="flex items-center gap-2">
              <Input
                type={showNewPw ? 'text' : 'password'}
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                className="font-mono text-sm flex-1"
                autoFocus
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-9"
                    onClick={() => setShowNewPw((s) => !s)}
                  >
                    {showNewPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{showNewPw ? 'Hide' : 'Show'}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-9"
                    onClick={() => setNewPw(generateRandomPassword(20))}
                  >
                    <RefreshCw className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Generate random</TooltipContent>
              </Tooltip>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setChangePw(null)} disabled={!!patching[changePw?.id || '']}>
              Cancel
            </Button>
            <Button
              className={primaryBtn}
              onClick={handleChangePw}
              disabled={!!patching[changePw?.id || ''] || newPw.length < 6}
            >
              {patching[changePw?.id || ''] ? (
                <>
                  <Loader2 className="size-4 me-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <KeyRound className="size-4 me-2" />
                  Update Password
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteAccount} onOpenChange={(v) => !v && setDeleteAccount(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-red-500" />
              Delete FTP Account
            </AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete <span className="font-mono">{deleteAccount?.username}</span>?
              The user will no longer be able to log in.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deleting ? (
                <>
                  <Loader2 className="size-4 me-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="size-4 me-2" />
                  Delete
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// 3. RedirectsTab
// ═══════════════════════════════════════════════════════════════════════

export function RedirectsTab({ projectId }: { projectId: string }) {
  const [redirects, setRedirects] = useState<RedirectRule[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [editRedirect, setEditRedirect] = useState<RedirectRule | null>(null)
  const [creating, setCreating] = useState(false)
  const [patching, setPatching] = useState<Record<string, boolean>>({})
  const [deleteRedirect, setDeleteRedirect] = useState<RedirectRule | null>(null)
  const [deleting, setDeleting] = useState(false)

  // form state
  const [fromPath, setFromPath] = useState('/')
  const [toUrl, setToUrl] = useState('')
  const [statusCode, setStatusCode] = useState(301)
  const [matchQuery, setMatchQuery] = useState('')
  const [enabled, setEnabled] = useState(true)

  const fetchRedirects = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/redirects`, {
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        setRedirects(data.redirects || [])
      } else {
        toast.error(data.error || 'Failed to load redirects')
      }
    } catch {
      toast.error('Network error loading redirects')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    fetchRedirects()
  }, [fetchRedirects])

  const openCreate = () => {
    setFromPath('/')
    setToUrl('')
    setStatusCode(301)
    setMatchQuery('')
    setEnabled(true)
    setEditRedirect(null)
    setCreateOpen(true)
  }

  const openEdit = (r: RedirectRule) => {
    setFromPath(r.fromPath)
    setToUrl(r.toUrl)
    setStatusCode(r.statusCode)
    setMatchQuery(r.matchQuery || '')
    setEnabled(r.enabled)
    setEditRedirect(r)
    setCreateOpen(true)
  }

  const handleSave = async () => {
    const fp = fromPath.trim()
    const tu = toUrl.trim()
    if (!fp.startsWith('/')) {
      toast.error('From path must start with "/"')
      return
    }
    if (!tu) {
      toast.error('To URL is required')
      return
    }
    setCreating(true)
    try {
      const url = editRedirect
        ? `/api/hosting/${projectId}/redirects/${editRedirect.id}`
        : `/api/hosting/${projectId}/redirects`
      const method = editRedirect ? 'PATCH' : 'POST'
      const body: Record<string, unknown> = {
        fromPath: fp,
        toUrl: tu,
        statusCode,
        enabled,
      }
      if (matchQuery.trim()) body.matchQuery = matchQuery.trim()
      const res = await fetch(url, {
        method,
        headers: getAuthHeaders(),
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(editRedirect ? 'Redirect updated' : 'Redirect created')
        setCreateOpen(false)
        setEditRedirect(null)
        fetchRedirects()
      } else {
        toast.error(data.error || 'Failed to save redirect')
      }
    } catch {
      toast.error('Network error saving redirect')
    } finally {
      setCreating(false)
    }
  }

  const handleToggle = async (r: RedirectRule) => {
    setPatching((p) => ({ ...p, [r.id]: true }))
    try {
      const res = await fetch(`/api/hosting/${projectId}/redirects/${r.id}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({ enabled: !r.enabled }),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(r.enabled ? 'Redirect disabled' : 'Redirect enabled')
        fetchRedirects()
      } else {
        toast.error(data.error || 'Failed to toggle redirect')
      }
    } catch {
      toast.error('Network error updating redirect')
    } finally {
      setPatching((p) => ({ ...p, [r.id]: false }))
    }
  }

  const handleDelete = async () => {
    if (!deleteRedirect) return
    setDeleting(true)
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/redirects/${deleteRedirect.id}`,
        { method: 'DELETE', headers: getAuthHeaders() }
      )
      const data = await res.json()
      if (res.ok) {
        toast.success('Redirect deleted')
        setDeleteRedirect(null)
        fetchRedirects()
      } else {
        toast.error(data.error || 'Failed to delete redirect')
      }
    } catch {
      toast.error('Network error deleting redirect')
    } finally {
      setDeleting(false)
    }
  }

  const typeBadge = (code: number) =>
    code === 301 ? (
      <Badge variant="outline" className="bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 border-red-200 dark:border-red-900/50 text-xs">
        301 Permanent
      </Badge>
    ) : (
      <Badge variant="outline" className="bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 border-amber-200 dark:border-amber-900/50 text-xs">
        302 Temporary
      </Badge>
    )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <ArrowRightLeft className={`size-5 ${primaryText}`} />
              Redirects
            </CardTitle>
            <CardDescription className="mt-1">
              URL redirects (301/302) applied at the Caddy reverse-proxy layer.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={fetchRedirects} disabled={loading}>
              <RefreshCw className={`size-3.5 me-1 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button size="sm" className={primaryBtn} onClick={openCreate}>
              <Plus className="size-3.5 me-1" />
              New Redirect
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : redirects.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground">
            <ArrowRightLeft className="size-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">No redirects</p>
            <p className="text-xs mt-1">
              Redirect old URLs to new locations with 301 (permanent) or 302 (temporary) status codes.
            </p>
            <Button className={`${primaryBtn} mt-4`} size="sm" onClick={openCreate}>
              <Plus className="size-3.5 me-1" />
              Create Your First Redirect
            </Button>
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>From Path</TableHead>
                  <TableHead> </TableHead>
                  <TableHead>To URL</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Match Query</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-end">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {redirects.map((r) => (
                  <TableRow
                    key={r.id}
                    className={`hover:bg-emerald-50/40 dark:hover:bg-emerald-950/10 transition-colors ${!r.enabled ? 'opacity-60' : ''}`}
                  >
                    <TableCell className="font-mono text-xs">{r.fromPath}</TableCell>
                    <TableCell>
                      <ArrowRightLeft className="size-3.5 text-muted-foreground" />
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs break-all">{r.toUrl}</span>
                    </TableCell>
                    <TableCell>{typeBadge(r.statusCode)}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {r.matchQuery || '—'}
                    </TableCell>
                    <TableCell>
                      {r.enabled ? (
                        <Badge variant="outline" className="bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/50 text-xs">
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-gray-50 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400 border-gray-200 dark:border-gray-700 text-xs">
                          Disabled
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-end">
                      <div className="flex items-center justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              disabled={!!patching[r.id]}
                              onClick={() => openEdit(r)}
                            >
                              <Edit className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Edit</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              disabled={!!patching[r.id]}
                              onClick={() => handleToggle(r)}
                            >
                              {patching[r.id] ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : r.enabled ? (
                                <ShieldCheck className="size-3.5 text-emerald-600" />
                              ) : (
                                <ShieldAlert className="size-3.5 text-muted-foreground" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {r.enabled ? 'Disable' : 'Enable'}
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20"
                              onClick={() => setDeleteRedirect(r)}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Delete</TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {/* Create / Edit dialog */}
      <Dialog open={createOpen} onOpenChange={(v) => !v && setCreateOpen(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitBranch className={`size-5 ${primaryText}`} />
              {editRedirect ? 'Edit Redirect' : 'New Redirect'}
            </DialogTitle>
            <DialogDescription>
              Requests to the from-path will be redirected to the to-URL with the chosen status code.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="redir-from">From Path</Label>
              <Input
                id="redir-from"
                placeholder="/old-page"
                value={fromPath}
                onChange={(e) => setFromPath(e.target.value)}
                className="font-mono text-sm"
                autoFocus
              />
              <p className="text-xs text-muted-foreground">Must start with &ldquo;/&rdquo;.</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="redir-to">To URL</Label>
              <Input
                id="redir-to"
                placeholder="https://example.com/new-page  or  /new"
                value={toUrl}
                onChange={(e) => setToUrl(e.target.value)}
                className="font-mono text-sm"
              />
            </div>
            <div className="grid gap-2">
              <Label>Type</Label>
              <Select
                value={String(statusCode)}
                onValueChange={(v) => setStatusCode(Number(v))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="301">301 — Permanent</SelectItem>
                  <SelectItem value="302">302 — Temporary</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Use 301 for permanent moves (SEO passes link juice). Use 302 for temporary ones.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="redir-query">Match Query (optional)</Label>
              <Input
                id="redir-query"
                placeholder="e.g. ?ref=old"
                value={matchQuery}
                onChange={(e) => setMatchQuery(e.target.value)}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Only redirect when the query string matches. Leave blank to match any.
              </p>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label className="text-sm">Enabled</Label>
                <p className="text-xs text-muted-foreground">Activate the redirect immediately.</p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button className={primaryBtn} onClick={handleSave} disabled={creating}>
              {creating ? (
                <>
                  <Loader2 className="size-4 me-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Plus className="size-4 me-2" />
                  {editRedirect ? 'Save Changes' : 'Create'}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteRedirect} onOpenChange={(v) => !v && setDeleteRedirect(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-red-500" />
              Delete Redirect
            </AlertDialogTitle>
            <AlertDialogDescription>
              Remove the redirect from{' '}
              <span className="font-mono">{deleteRedirect?.fromPath}</span> to{' '}
              <span className="font-mono">{deleteRedirect?.toUrl}</span>?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deleting ? (
                <>
                  <Loader2 className="size-4 me-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="size-4 me-2" />
                  Delete
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// MalwareScanCard — the plan's malwareScanner tier, made real
// ═══════════════════════════════════════════════════════════════════════

interface ScanStatus {
  tier: string
  entitled: boolean
  onDemand?: boolean
  scheduled?: boolean
  scannerAvailable: boolean
  engine?: string | null
  reason?: string
  deployed?: boolean
}

interface ScanOutcome {
  scanned: boolean
  tier: string
  engine?: string | null
  infected: Array<{ path: string; signature: string }>
  filesScanned: number
  filesFailed?: number
  filesSkipped?: number
  partial?: boolean
  durationMs: number
  reason?: string
}

function MalwareScanCard({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<ScanStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<ScanOutcome | null>(null)

  const fetchStatus = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/malware-scan`, {
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) setStatus(data)
      else toast.error(data.error || 'Could not read scanner status')
    } catch {
      toast.error('Network error reading scanner status')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  const runScan = async () => {
    setScanning(true)
    setResult(null)
    try {
      const res = await fetch(`/api/hosting/${projectId}/malware-scan`, {
        method: 'POST',
        headers: getAuthHeaders(),
      })
      const data: ScanOutcome & { error?: string } = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Scan failed')
        return
      }
      setResult(data)
      if (!data.scanned) toast.info(data.reason || 'The scan could not run.')
      else if (data.infected.length > 0)
        toast.error(`${data.infected.length} infected file(s) found`)
      else if (data.partial) toast.warning(data.reason || 'Some files could not be scanned.')
      else toast.success(`Clean — ${data.filesScanned} files scanned`)
    } catch {
      toast.error('Network error running the scan')
    } finally {
      setScanning(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <ShieldCheck className={`size-5 ${primaryText}`} />
              Malware Scanning
            </CardTitle>
            <CardDescription className="mt-1">
              {loading
                ? 'Checking your plan and the scanner…'
                : status?.entitled
                ? `${status.tier} protection included in your plan.`
                : 'Not included in your plan.'}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={fetchStatus}
              disabled={loading || scanning}
            >
              <RefreshCw className={`size-3.5 me-1 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            {status?.entitled && status.onDemand && (
              <Button
                size="sm"
                className={primaryBtn}
                onClick={runScan}
                disabled={scanning || !status.scannerAvailable}
              >
                {scanning ? (
                  <>
                    <Loader2 className="size-3.5 me-1 animate-spin" />
                    Scanning…
                  </>
                ) : (
                  <>
                    <Shield className="size-3.5 me-1" />
                    Scan now
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {loading && <Skeleton className="h-16 w-full" />}

        {!loading && status && !status.entitled && (
          <div className="rounded-lg border p-3 text-sm text-muted-foreground">
            Malware scanning is available on higher plans. Upgrade to have your site
            files checked against the ClamAV signature database.
          </div>
        )}

        {/* An entitled customer whose scanner is off must be told plainly. A
            silent "no threats" from something that never ran is worse than
            nothing, because it gets believed. */}
        {!loading && status?.entitled && !status.scannerAvailable && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
            <div className="flex items-start gap-2 text-sm">
              <AlertTriangle className="size-4 text-amber-600 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Scanner unavailable — no scan has run</p>
                <p className="text-muted-foreground mt-0.5">
                  {status.reason || 'The scanning service is not running on this server.'}
                </p>
              </div>
            </div>
          </div>
        )}

        {!loading && status?.entitled && status.scannerAvailable && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Tier</div>
              <div className="text-sm font-medium mt-1">{status.tier}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Engine</div>
              <div className="text-sm font-medium mt-1 truncate">
                {status.engine || 'ClamAV'}
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Scheduled sweep</div>
              <div className="text-sm font-medium mt-1">
                {status.scheduled ? 'Included' : 'On demand only'}
              </div>
            </div>
          </div>
        )}

        {result && (
          <div
            className={`rounded-lg border p-3 ${
              !result.scanned
                ? ''
                : result.infected.length > 0
                ? 'border-destructive/40 bg-destructive/5'
                : 'border-emerald-500/40 bg-emerald-500/5'
            }`}
          >
            {!result.scanned ? (
              <p className="text-sm text-muted-foreground">{result.reason}</p>
            ) : result.infected.length === 0 && result.partial ? (
              <p className="text-sm">
                <span className="font-medium text-amber-600 dark:text-amber-400">
                  No threats found in the files that were checked.
                </span>{' '}
                <span className="text-muted-foreground">{result.reason}</span>
              </p>
            ) : result.infected.length === 0 ? (
              <p className="text-sm">
                <span className="font-medium text-emerald-600 dark:text-emerald-400">
                  No threats found.
                </span>{' '}
                <span className="text-muted-foreground">
                  {result.filesScanned} files, {(result.durationMs / 1000).toFixed(1)}s.
                </span>
              </p>
            ) : (
              <div className="text-sm">
                <p className="font-medium text-destructive mb-2">
                  {result.infected.length} infected file
                  {result.infected.length === 1 ? '' : 's'} found
                </p>
                <ul className="space-y-1 font-mono text-xs">
                  {result.infected.slice(0, 20).map((f) => (
                    <li key={f.path} className="break-all">
                      <span className="text-destructive">{f.signature}</span> — {f.path}
                    </li>
                  ))}
                </ul>
                {result.infected.length > 20 && (
                  <p className="text-muted-foreground mt-2">
                    …and {result.infected.length - 20} more.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// 4. SecurityTab
// ═══════════════════════════════════════════════════════════════════════

export function SecurityTab({ projectId }: { projectId: string }) {
  const [blocks, setBlocks] = useState<IpBlockRule[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [editBlock, setEditBlock] = useState<IpBlockRule | null>(null)
  const [creating, setCreating] = useState(false)
  const [patching, setPatching] = useState<Record<string, boolean>>({})
  const [deleteBlock, setDeleteBlock] = useState<IpBlockRule | null>(null)
  const [deleting, setDeleting] = useState(false)

  // form state
  const [ipAddress, setIpAddress] = useState('')
  const [action, setAction] = useState<'deny' | 'allow'>('deny')
  const [reason, setReason] = useState('')
  const [permanent, setPermanent] = useState(true)
  const [expiresAt, setExpiresAt] = useState('')

  const fetchBlocks = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/security`, {
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        setBlocks(data.blocks || [])
      } else {
        toast.error(data.error || 'Failed to load IP rules')
      }
    } catch {
      toast.error('Network error loading IP rules')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    fetchBlocks()
  }, [fetchBlocks])

  const openCreate = () => {
    setIpAddress('')
    setAction('deny')
    setReason('')
    setPermanent(true)
    setExpiresAt('')
    setEditBlock(null)
    setCreateOpen(true)
  }

  const openEdit = (b: IpBlockRule) => {
    setIpAddress(b.ipAddress)
    setAction(b.action === 'allow' ? 'allow' : 'deny')
    setReason(b.reason || '')
    if (b.expiresAt) {
      setPermanent(false)
      // Convert ISO to datetime-local format (yyyy-MM-ddTHH:mm)
      const d = new Date(b.expiresAt)
      const pad = (n: number) => String(n).padStart(2, '0')
      const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
      setExpiresAt(local)
    } else {
      setPermanent(true)
      setExpiresAt('')
    }
    setEditBlock(b)
    setCreateOpen(true)
  }

  const handleSave = async () => {
    const ip = ipAddress.trim()
    if (!ip) {
      toast.error('IP address is required')
      return
    }
    if (!/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(ip)) {
      toast.error('Must be an IPv4 address (e.g. 192.168.1.5) or CIDR (e.g. 10.0.0.0/8)')
      return
    }
    setCreating(true)
    try {
      const url = editBlock
        ? `/api/hosting/${projectId}/security/${editBlock.id}`
        : `/api/hosting/${projectId}/security`
      const method = editBlock ? 'PATCH' : 'POST'
      const body: Record<string, unknown> = {
        ipAddress: ip,
        action,
      }
      if (reason.trim()) body.reason = reason.trim()
      if (permanent) {
        body.permanent = true
      } else if (expiresAt) {
        body.expiresAt = new Date(expiresAt).toISOString()
      }
      const res = await fetch(url, {
        method,
        headers: getAuthHeaders(),
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(editBlock ? 'Rule updated' : 'Rule created')
        setCreateOpen(false)
        setEditBlock(null)
        fetchBlocks()
      } else {
        toast.error(data.error || 'Failed to save rule')
      }
    } catch {
      toast.error('Network error saving rule')
    } finally {
      setCreating(false)
    }
  }

  const handleToggle = async (b: IpBlockRule) => {
    setPatching((p) => ({ ...p, [b.id]: true }))
    try {
      const res = await fetch(`/api/hosting/${projectId}/security/${b.id}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({ enabled: !b.enabled }),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(b.enabled ? 'Rule disabled' : 'Rule enabled')
        fetchBlocks()
      } else {
        toast.error(data.error || 'Failed to toggle rule')
      }
    } catch {
      toast.error('Network error updating rule')
    } finally {
      setPatching((p) => ({ ...p, [b.id]: false }))
    }
  }

  const handleDelete = async () => {
    if (!deleteBlock) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/security/${deleteBlock.id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success('Rule removed')
        setDeleteBlock(null)
        fetchBlocks()
      } else {
        toast.error(data.error || 'Failed to remove rule')
      }
    } catch {
      toast.error('Network error removing rule')
    } finally {
      setDeleting(false)
    }
  }

  const actionBadge = (a: string) =>
    a === 'allow' ? (
      <Badge variant="outline" className="bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/50 text-xs">
        <ShieldCheck className="size-3 me-1" />
        Allow
      </Badge>
    ) : (
      <Badge variant="outline" className="bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 border-red-200 dark:border-red-900/50 text-xs">
        <Ban className="size-3 me-1" />
        Deny
      </Badge>
    )

  // Summary stats
  const total = blocks.length
  const denyCount = blocks.filter((b) => b.action !== 'allow').length
  const allowCount = blocks.filter((b) => b.action === 'allow').length
  const expiredCount = blocks.filter(
    (b) => b.expiresAt && new Date(b.expiresAt).getTime() < Date.now()
  ).length

  return (
    <div className="space-y-4">
    <MalwareScanCard projectId={projectId} />
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Shield className={`size-5 ${primaryText}`} />
              IP Blocker
            </CardTitle>
            <CardDescription className="mt-1">
              Deny or allow specific IP addresses and CIDR ranges.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={fetchBlocks} disabled={loading}>
              <RefreshCw className={`size-3.5 me-1 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button size="sm" className={primaryBtn} onClick={openCreate}>
              <Plus className="size-3.5 me-1" />
              New Rule
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <div className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">Total rules</div>
            <div className="text-2xl font-semibold mt-1">{total}</div>
          </div>
          <div className="rounded-lg border p-3 bg-red-50/50 dark:bg-red-950/10">
            <div className="text-xs text-red-700 dark:text-red-400">Deny</div>
            <div className="text-2xl font-semibold mt-1 text-red-700 dark:text-red-400">{denyCount}</div>
          </div>
          <div className="rounded-lg border p-3 bg-emerald-50/50 dark:bg-emerald-950/10">
            <div className="text-xs text-emerald-700 dark:text-emerald-400">Allow</div>
            <div className="text-2xl font-semibold mt-1 text-emerald-700 dark:text-emerald-400">{allowCount}</div>
          </div>
          <div className="rounded-lg border p-3 bg-amber-50/50 dark:bg-amber-950/10">
            <div className="text-xs text-amber-700 dark:text-amber-400">Expired</div>
            <div className="text-2xl font-semibold mt-1 text-amber-700 dark:text-amber-400">{expiredCount}</div>
          </div>
        </div>

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : blocks.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground">
            <Shield className="size-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">No IP rules</p>
            <p className="text-xs mt-1">
              Block malicious IPs or whitelist trusted ones (e.g. your office IP).
            </p>
            <Button className={`${primaryBtn} mt-4`} size="sm" onClick={openCreate}>
              <Plus className="size-3.5 me-1" />
              Create Your First Rule
            </Button>
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>IP / CIDR</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-end">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {blocks.map((b) => {
                  const expired =
                    !!b.expiresAt && new Date(b.expiresAt).getTime() < Date.now()
                  return (
                    <TableRow
                      key={b.id}
                      className={`hover:bg-emerald-50/40 dark:hover:bg-emerald-950/10 transition-colors ${
                        !b.enabled || expired ? 'opacity-60' : ''
                      }`}
                    >
                      <TableCell>
                        <span className="font-mono text-xs">{b.ipAddress}</span>
                        {!b.enabled && (
                          <Badge variant="outline" className="ms-2 bg-gray-50 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400 border-gray-200 dark:border-gray-700 text-[10px] h-5">
                            Disabled
                          </Badge>
                        )}
                        {expired && (
                          <Badge variant="outline" className="ms-2 bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 border-amber-200 dark:border-amber-900/50 text-[10px] h-5">
                            Expired
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>{actionBadge(b.action)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[160px] truncate">
                        {b.reason || '—'}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {b.expiresAt ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className={expired ? 'text-amber-600 dark:text-amber-400' : ''}>
                                {timeAgo(b.expiresAt)}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>{formatDate(b.expiresAt)}</TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <InfinityIcon className="size-3" />
                            Never
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>{timeAgo(b.createdAt)}</span>
                          </TooltipTrigger>
                          <TooltipContent>{formatDate(b.createdAt)}</TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell className="text-end">
                        <div className="flex items-center justify-end gap-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                disabled={!!patching[b.id]}
                                onClick={() => openEdit(b)}
                              >
                                <Edit className="size-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Edit</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                disabled={!!patching[b.id]}
                                onClick={() => handleToggle(b)}
                              >
                                {patching[b.id] ? (
                                  <Loader2 className="size-3.5 animate-spin" />
                                ) : b.enabled ? (
                                  <ShieldCheck className="size-3.5 text-emerald-600" />
                                ) : (
                                  <ShieldAlert className="size-3.5 text-muted-foreground" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {b.enabled ? 'Disable' : 'Enable'}
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20"
                                onClick={() => setDeleteBlock(b)}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Delete</TooltipContent>
                          </Tooltip>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {/* Create / Edit dialog */}
      <Dialog open={createOpen} onOpenChange={(v) => !v && setCreateOpen(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className={`size-5 ${primaryText}`} />
              {editBlock ? 'Edit IP Rule' : 'New IP Rule'}
            </DialogTitle>
            <DialogDescription>
              Block (deny) or whitelist (allow) an IP address or CIDR range.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="ip-addr">IP Address / CIDR</Label>
              <Input
                id="ip-addr"
                placeholder="192.168.1.5  or  10.0.0.0/8"
                value={ipAddress}
                onChange={(e) => setIpAddress(e.target.value)}
                className="font-mono text-sm"
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                IPv4 only. CIDR notation supported (e.g. /24, /16, /8).
              </p>
            </div>
            <div className="grid gap-2">
              <Label>Action</Label>
              <Select
                value={action}
                onValueChange={(v) => setAction(v as 'deny' | 'allow')}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="deny">Deny — block this IP</SelectItem>
                  <SelectItem value="allow">Allow — whitelist this IP</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ip-reason">Reason (optional)</Label>
              <Input
                id="ip-reason"
                placeholder="e.g. Brute-force attempts"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label className="text-sm">Permanent</Label>
                <p className="text-xs text-muted-foreground">Rule never expires.</p>
              </div>
              <Switch checked={permanent} onCheckedChange={setPermanent} />
            </div>
            {!permanent && (
              <div className="grid gap-2">
                <Label htmlFor="ip-expires">Expires At</Label>
                <div className="flex items-center gap-2">
                  <Calendar className="size-4 text-muted-foreground" />
                  <Input
                    id="ip-expires"
                    type="datetime-local"
                    value={expiresAt}
                    onChange={(e) => setExpiresAt(e.target.value)}
                    className="text-sm flex-1"
                  />
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button className={primaryBtn} onClick={handleSave} disabled={creating}>
              {creating ? (
                <>
                  <Loader2 className="size-4 me-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Plus className="size-4 me-2" />
                  {editBlock ? 'Save Changes' : 'Create'}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteBlock} onOpenChange={(v) => !v && setDeleteBlock(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-red-500" />
              Remove IP Rule
            </AlertDialogTitle>
            <AlertDialogDescription>
              Remove the {deleteBlock?.action === 'allow' ? 'allow' : 'deny'} rule for{' '}
              <span className="font-mono">{deleteBlock?.ipAddress}</span>?
              This IP will regain normal access to the site.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deleting ? (
                <>
                  <Loader2 className="size-4 me-2 animate-spin" />
                  Removing...
                </>
              ) : (
                <>
                  <Trash2 className="size-4 me-2" />
                  Remove
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
    </div>
  )
}
