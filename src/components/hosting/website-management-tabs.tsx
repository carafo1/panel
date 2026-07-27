'use client'

/**
 * website-management-tabs.tsx
 *
 * Six new website-management tab components for the upgraded Website Deployment
 * module of Apsamo Panel. Each component is a self-contained client UI that
 * consumes the new REST endpoints documented in the API contract:
 *
 *   1. DatabaseTab    — auto-provisioned MySQL/MariaDB/PostgreSQL databases (CRUD + reveal + test)
 *   2. BackupsTab     — project-level backup files (CRUD + blob download + restore)
 *   3. FilesTab       — file manager (navigate/upload/edit/rename/mkdir/delete)
 *   4. TerminalTab    — interactive shell inside the project container
 *   5. ResourcesTab   — live CPU/RAM/Storage/network usage + 24h history charts
 *   6. DomainsTab     — multi-domain management (CRUD + primary + SSL + verify)
 *
 * The components follow the existing patterns in `hosting-panel.tsx`:
 *   - shadcn/ui components only (Card, Button, Input, Label, Select, Dialog, …)
 *   - emerald accent color (NO indigo or blue as primary)
 *   - lucide-react icons
 *   - toast notifications via sonner
 *   - mobile-first responsive design
 *   - light + dark mode via Tailwind CSS variables
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import {
  Database as DatabaseIcon,
  HardDrive,
  Archive,
  File as FileIcon,
  Folder,
  FolderOpen,
  FilePlus,
  FolderPlus,
  Upload,
  Download,
  Edit,
  Trash2,
  Eye,
  EyeOff,
  Plus,
  RefreshCw,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Terminal as TerminalIcon,
  Activity,
  Cpu,
  MemoryStick,
  Network,
  Globe,
  Shield,
  ShieldCheck,
  ShieldAlert,
  Copy,
  ChevronRight,
  Home,
  Clock,
  X,
  ArrowUp,
  Save,
  PlugZap,
  Server,
  Link2,
  CircleAlert,
  TrendingUp,
  Mail,
  AtSign,
  KeyRound,
  ChevronDown,
  ChevronUp,
  ExternalLink,
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
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Progress } from '@/components/ui/progress'
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

// ─── Shared helpers ──────────────────────────────────────────────────

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('apsamo_token')
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

function timeAgo(dateStr: string): string {
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

function formatDate(dateStr: string): string {
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

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

function formatUptime(seconds: number): string {
  if (!seconds || seconds < 0) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  parts.push(`${minutes}m`)
  return parts.join(' ')
}

function maskPassword(value: string): string {
  if (!value) return '—'
  if (value.length <= 4) return '****'
  return `****${value.slice(-4)}`
}

async function copyToClipboard(text: string, label = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(label)
  } catch {
    // Fallback for browsers without clipboard API
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

// Emerald-flavored primary button class (NO indigo/blue).
const primaryBtn = 'bg-emerald-600 hover:bg-emerald-700 text-white'
const primaryText = 'text-emerald-600 dark:text-emerald-400'

// ─── Types ───────────────────────────────────────────────────────────

interface WebsiteDatabase {
  id: string
  name: string
  type: string // mysql | mariadb | postgres | sqlite
  host: string
  port: number
  username: string
  /** Always present: first 2 chars + "****". */
  passwordMasked: string
  /** Plaintext — only populated when the row was fetched with ?reveal=true. */
  passwordPlain?: string
  externalRef?: string | null
  isPrimary: boolean
  createdAt: string
}

/**
 * Shape returned by POST /databases right after provisioning. Distinct from
 * {@link WebsiteDatabase}: the freshly generated password is returned in
 * plaintext exactly once here, so it can be shown for the customer to save.
 */
interface CreatedDatabase {
  name: string
  type: string
  host: string
  port: number
  username: string
  password: string
  externalRef?: string | null
}

interface WebsiteBackup {
  id: string
  filename: string
  sizeBytes: number
  status: string // pending | running | completed | failed
  type: string // manual | scheduled | pre-deploy
  note?: string | null
  createdAt: string
}

interface FileEntry {
  name: string
  path: string
  absolutePath?: string
  type: 'file' | 'directory' | 'symlink'
  size: number
  modifiedAt?: string
  permissions?: string
}

interface FileListResponse {
  files: FileEntry[]
  currentPath: string
  parentPath?: string | null
}

interface TerminalSession {
  id: string
  createdAt: string
  lastActivity?: string
  cwd?: string
}

interface TerminalRunResult {
  stdout: string
  stderr: string
  exitCode: number
  cwd: string
  durationMs: number
}

interface ResourceCurrent {
  cpuCores: number
  cpuPercent: number
  ramMB: number
  ramUsedMB: number
  storageGB: number
  storageUsedGB: number
  networkRxBytes: number
  networkTxBytes: number
  uptimeSeconds: number
  status: string
}

interface ResourceHistoryPoint {
  timestamp: string
  cpuPercent: number
  ramUsedMB: number
  storageUsedGB: number
}

interface ResourceResponse {
  current: ResourceCurrent
  history: ResourceHistoryPoint[]
}

interface WebsiteDomain {
  id: string
  domain: string
  isPrimary: boolean
  sslEnabled: boolean
  sslStatus: string // none | pending | issued | failed | renewing
  verified: boolean
  verificationMethod?: string | null
  /** Present only while unverified — the value to publish as TXT. */
  verificationToken?: string | null
  verifiedAt?: string | null
  lastCheckError?: string | null
  lastCheckedAt?: string | null
  /** Server-derived pipeline stage. */
  connection?: {
    stage:
      | 'awaiting_nameservers'
      | 'nameservers_verified'
      | 'configuring_dns'
      | 'installing_ssl'
      | 'live'
      | 'blocked'
    label: string
    detail: string
    percent: number
    needsAction: boolean
  }
  createdAt: string
}

/**
 * The connection pipeline for a custom domain.
 *
 * Every stage reflects something OBSERVED: "Live" means an HTTPS request to
 * the domain succeeded, not that the hostname was written to a config file.
 */
const CONNECTION_STEPS = [
  { key: 'awaiting_nameservers', label: 'Nameservers' },
  { key: 'nameservers_verified', label: 'DNS' },
  { key: 'installing_ssl', label: 'SSL' },
  { key: 'live', label: 'Live' },
] as const

function ConnectionPipeline({ d }: { d: WebsiteDomain }) {
  const conn = d.connection
  if (!conn) return null
  const reached =
    conn.stage === 'live' ? 3
      : conn.stage === 'installing_ssl' ? 2
      : conn.stage === 'nameservers_verified' || conn.stage === 'configuring_dns' ? 1
      : 0
  const blocked = conn.stage === 'blocked'

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center gap-1">
        {CONNECTION_STEPS.map((step, i) => {
          const done = !blocked && i <= reached
          const current = !blocked && i === reached && conn.stage !== 'live'
          return (
            <div key={step.key} className="flex flex-1 items-center gap-1">
              <div
                className={`h-1.5 flex-1 rounded-full transition-all duration-500 ${
                  blocked
                    ? 'bg-red-500/30'
                    : done
                      ? 'bg-emerald-500'
                      : 'bg-muted'
                }`}
                title={step.label}
              />
              {current && (
                <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
              )}
            </div>
          )
        })}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium">
          {CONNECTION_STEPS.map((s) => s.label).join(' → ')}
        </span>
        <span
          className={`text-[11px] ${
            blocked
              ? 'text-red-600 dark:text-red-400'
              : conn.stage === 'live'
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-muted-foreground'
          }`}
        >
          {conn.label}
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground">{conn.detail}</p>
    </div>
  )
}

interface EmailMailbox {
  id: string
  address: string
  localPart: string
  domainId: string
  domainName: string | null
  password: string // masked unless just-created
  quota: number // bytes
  active: boolean
  isDefault: boolean
  mailcowId?: string | null
  dkimEnabled: boolean
  createdAt: string
  updatedAt: string
}

interface EmailDnsRecord {
  type: string
  name: string
  value: string
  priority?: number
}

interface EmailDnsRecordsResponse {
  domain: string
  mailServer: string
  records: {
    mx: EmailDnsRecord
    spf: EmailDnsRecord
    dmarc: EmailDnsRecord
    dkim: EmailDnsRecord
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 1. DatabaseTab
// ═══════════════════════════════════════════════════════════════════════

export function DatabaseTab({ projectId }: { projectId: string }) {
  const [databases, setDatabases] = useState<WebsiteDatabase[]>([])
  const [loading, setLoading] = useState(true)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [revealing, setRevealing] = useState<Record<string, boolean>>({})
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [openingPma, setOpeningPma] = useState<Record<string, boolean>>({})
  const [openingPgAdmin, setOpeningPgAdmin] = useState<Record<string, boolean>>({})
  const [resetPwFor, setResetPwFor] = useState<WebsiteDatabase | null>(null)
  const [resettingPw, setResettingPw] = useState(false)
  const [newPw, setNewPw] = useState<{
    name: string
    username: string
    password: string
  } | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createType, setCreateType] = useState<'mysql' | 'mariadb' | 'postgres' | 'sqlite'>('mysql')
  const [createName, setCreateName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createdDb, setCreatedDb] = useState<CreatedDatabase | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const fetchDatabases = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/databases`, {
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        setDatabases(data.databases || [])
      } else {
        toast.error(data.error || 'Failed to load databases')
      }
    } catch {
      toast.error('Network error loading databases')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    fetchDatabases()
  }, [fetchDatabases])

  const handleReveal = async (db: WebsiteDatabase) => {
    if (revealed[db.id]) {
      // Toggle off
      setRevealed((prev) => {
        const next = { ...prev }
        delete next[db.id]
        return next
      })
      return
    }
    setRevealing((p) => ({ ...p, [db.id]: true }))
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/databases/${db.id}?reveal=true`,
        { headers: getAuthHeaders() }
      )
      const data = await res.json()
      const plain = data?.database?.passwordPlain
      if (res.ok && typeof plain === 'string' && plain !== '') {
        setRevealed((prev) => ({ ...prev, [db.id]: plain }))
      } else if (res.ok) {
        // Row exists but the stored secret could not be decrypted (e.g. the
        // ENCRYPTION_KEY changed since it was provisioned). Say so plainly
        // instead of silently showing a blank field.
        toast.error(
          'This password could not be decrypted. Use "Reset password" to generate a new one.'
        )
      } else {
        toast.error(data.error || 'Failed to reveal password')
      }
    } catch {
      toast.error('Network error revealing password')
    } finally {
      setRevealing((p) => ({ ...p, [db.id]: false }))
    }
  }

  const handleTest = async (db: WebsiteDatabase) => {
    setTesting((p) => ({ ...p, [db.id]: true }))
    try {
      const res = await fetch(`/api/hosting/${projectId}/databases/${db.id}`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ action: 'test' }),
      })
      const data = await res.json()
      if (res.ok && data.ok) {
        toast.success(data.message || `Connection to ${db.name} successful`)
      } else {
        toast.error(data.message || data.error || `Connection to ${db.name} failed`)
      }
    } catch {
      toast.error('Network error testing connection')
    } finally {
      setTesting((p) => ({ ...p, [db.id]: false }))
    }
  }

  /**
   * Open pgAdmin for a PostgreSQL database via panel SSO. Same popup-blocker
   * dance as phpMyAdmin: claim the tab on the click, fill it in afterwards.
   */
  const handleOpenPgAdmin = async (db: WebsiteDatabase) => {
    const tab = window.open('', '_blank')
    setOpeningPgAdmin((p) => ({ ...p, [db.id]: true }))
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/databases/${db.id}/pgadmin?json=1`,
        { headers: getAuthHeaders() }
      )
      const data = await res.json()
      if (!res.ok || !data.url) {
        throw new Error(data.error || 'Could not start a pgAdmin session')
      }
      if (tab) tab.location.href = data.url
      else window.location.href = data.url
    } catch (err) {
      tab?.close()
      toast.error(err instanceof Error ? err.message : 'Failed to open pgAdmin')
    } finally {
      setOpeningPgAdmin((p) => ({ ...p, [db.id]: false }))
    }
  }

  /**
   * Rotate a database user's password. The new secret comes back once, so we
   * surface it in a dialog for the customer to copy before it is masked again.
   */
  const handleResetPassword = async (db: WebsiteDatabase) => {
    setResettingPw(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/databases/${db.id}`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ action: 'reset-password' }),
      })
      const data = await res.json()
      if (!res.ok || !data.password) {
        throw new Error(data.error || 'Failed to reset password')
      }
      setResetPwFor(null)
      setNewPw({ name: db.name, username: db.username, password: data.password })
      // Show the fresh secret in the row too, so it lines up with the dialog.
      setRevealed((prev) => ({ ...prev, [db.id]: data.password }))
      fetchDatabases()
      toast.success('Database password reset')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reset password')
    } finally {
      setResettingPw(false)
    }
  }

  /**
   * Open phpMyAdmin for a database via panel SSO. The blank tab is opened up
   * front, while we still have the user's click, so the popup blocker doesn't
   * swallow it while the one-time session is being minted.
   */
  const handleOpenPma = async (db: WebsiteDatabase) => {
    const tab = window.open('', '_blank')
    setOpeningPma((p) => ({ ...p, [db.id]: true }))
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/databases/${db.id}/pma?json=1`,
        { headers: getAuthHeaders() }
      )
      const data = await res.json()
      if (!res.ok || !data.url) {
        throw new Error(data.error || 'Could not start a phpMyAdmin session')
      }
      if (tab) tab.location.href = data.url
      else window.location.href = data.url
    } catch (err) {
      tab?.close()
      toast.error(err instanceof Error ? err.message : 'Failed to open phpMyAdmin')
    } finally {
      setOpeningPma((p) => ({ ...p, [db.id]: false }))
    }
  }

  const handleCreate = async () => {
    setCreating(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/databases`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          type: createType,
          name: createName.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (res.ok && data.database) {
        setCreatedDb(data.database)
        setCreateOpen(false)
        setCreateName('')
        setCreateType('mysql')
        fetchDatabases()
        toast.success('Database provisioned')
      } else {
        toast.error(data.error || 'Failed to create database')
      }
    } catch {
      toast.error('Network error creating database')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    setDeleting(true)
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/databases/${deleteId}`,
        { method: 'DELETE', headers: getAuthHeaders() }
      )
      const data = await res.json()
      if (res.ok) {
        toast.success('Database deleted')
        setRevealed((prev) => {
          const next = { ...prev }
          delete next[deleteId]
          return next
        })
        setDeleteId(null)
        fetchDatabases()
      } else {
        toast.error(data.error || 'Failed to delete database')
      }
    } catch {
      toast.error('Network error deleting database')
    } finally {
      setDeleting(false)
    }
  }

  const dbTypeBadge = (type: string) => {
    const lower = (type || '').toLowerCase()
    if (lower === 'mariadb') {
      return (
        <Badge variant="outline" className="bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 border-amber-200 dark:border-amber-900/50">
          MariaDB
        </Badge>
      )
    }
    if (lower === 'postgres' || lower === 'postgresql') {
      return (
        <Badge variant="outline" className="bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300 border-cyan-200 dark:border-cyan-900/50">
          PostgreSQL
        </Badge>
      )
    }
    if (lower === 'sqlite') {
      return (
        <Badge variant="outline" className="bg-gray-50 text-gray-700 dark:bg-gray-800/30 dark:text-gray-400 border-gray-200 dark:border-gray-700">
          SQLite
        </Badge>
      )
    }
    return (
      <Badge variant="outline" className="bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/50">
        MySQL
      </Badge>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <DatabaseIcon className={`size-5 ${primaryText}`} />
              Databases
            </CardTitle>
            <CardDescription className="mt-1">
              Auto-provisioned MySQL / MariaDB / PostgreSQL databases for this project.
              Credentials are encrypted at rest.
            </CardDescription>
          </div>
          <Button
            size="sm"
            className={primaryBtn}
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-3.5 mr-1" />
            Create Database
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : databases.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground">
            <DatabaseIcon className="size-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">No databases</p>
            <p className="text-xs mt-1">
              Click &ldquo;Create Database&rdquo; to provision one.
            </p>
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Host</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Password</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {databases.map((db) => (
                  <TableRow
                    key={db.id}
                    className="hover:bg-emerald-50/40 dark:hover:bg-emerald-950/10 transition-colors"
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium">{db.name}</span>
                        {db.isPrimary && (
                          <Badge variant="outline" className="bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/50 text-[10px] h-5">
                            Primary
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{dbTypeBadge(db.type)}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {db.host}:{db.port}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{db.username}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">
                          {revealed[db.id] ?? db.passwordMasked}
                        </span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              disabled={!!revealing[db.id]}
                              onClick={() => handleReveal(db)}
                            >
                              {revealing[db.id] ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : revealed[db.id] ? (
                                <EyeOff className="size-3.5" />
                              ) : (
                                <Eye className="size-3.5" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {revealed[db.id] ? 'Hide password' : 'Reveal password'}
                          </TooltipContent>
                        </Tooltip>
                        {revealed[db.id] && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                onClick={() => copyToClipboard(revealed[db.id], 'Password copied')}
                              >
                                <Copy className="size-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Copy password</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {/* Database Studio speaks MySQL/MariaDB and PostgreSQL;
                            only SQLite is unsupported. */}
                        {['mysql', 'mariadb', 'postgres', 'postgresql'].includes(
                          (db.type || '').toLowerCase()
                        ) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className={`h-7 text-xs ${primaryText}`}
                            onClick={() =>
                              window.open(`/db-studio/${projectId}/${db.id}`, '_blank')
                            }
                          >
                            <DatabaseIcon className="size-3 mr-1" />
                            Studio
                          </Button>
                        )}
                        {['mysql', 'mariadb'].includes((db.type || '').toLowerCase()) && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs text-[#706FD3] hover:text-[#8888FF] hover:bg-[#706FD3]/10"
                              disabled={!!openingPma[db.id]}
                              onClick={() => handleOpenPma(db)}
                              title="Open phpMyAdmin (signed in automatically)"
                            >
                              {openingPma[db.id] ? (
                                <Loader2 className="size-3 mr-1 animate-spin" />
                              ) : (
                                <ExternalLink className="size-3 mr-1" />
                              )}
                              phpMyAdmin
                            </Button>
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={!!testing[db.id]}
                          onClick={() => handleTest(db)}
                        >
                          {testing[db.id] ? (
                            <Loader2 className="size-3 mr-1 animate-spin" />
                          ) : (
                            <PlugZap className="size-3 mr-1" />
                          )}
                          Test
                        </Button>
                        {['postgres', 'postgresql'].includes((db.type || '').toLowerCase()) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs text-[#706FD3] hover:text-[#8888FF] hover:bg-[#706FD3]/10"
                            disabled={!!openingPgAdmin[db.id]}
                            onClick={() => handleOpenPgAdmin(db)}
                            title="Open pgAdmin (signed in automatically)"
                          >
                            {openingPgAdmin[db.id] ? (
                              <Loader2 className="size-3 mr-1 animate-spin" />
                            ) : (
                              <ExternalLink className="size-3 mr-1" />
                            )}
                            pgAdmin
                          </Button>
                        )}
                        {(db.type || '').toLowerCase() !== 'sqlite' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setResetPwFor(db)}
                            title="Generate a new password for this database user"
                          >
                            <KeyRound className="size-3 mr-1" />
                            Reset password
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20"
                          onClick={() => setDeleteId(db.id)}
                        >
                          <Trash2 className="size-3 mr-1" />
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {/* Create Database Dialog */}
      <Dialog open={createOpen} onOpenChange={(v) => !v && setCreateOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <DatabaseIcon className={`size-5 ${primaryText}`} />
              Create Database
            </DialogTitle>
            <DialogDescription>
              Provision a new database for this project. A random secure
              password will be generated and shown once.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>Type</Label>
              <Select value={createType} onValueChange={(v) => setCreateType(v as 'mysql' | 'mariadb' | 'postgres' | 'sqlite')}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mysql">MySQL</SelectItem>
                  <SelectItem value="mariadb">MariaDB</SelectItem>
                  <SelectItem value="postgres">PostgreSQL</SelectItem>
                  <SelectItem value="sqlite">SQLite (local file)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="db-name">Database name (optional)</Label>
              <Input
                id="db-name"
                placeholder="auto-generated if blank"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, numbers and underscores only.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button className={primaryBtn} onClick={handleCreate} disabled={creating}>
              {creating ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Provisioning...
                </>
              ) : (
                <>
                  <Plus className="size-4 mr-2" />
                  Create
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Show password once after creation */}
      <Dialog open={!!createdDb} onOpenChange={(v) => !v && setCreatedDb(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="size-5 text-emerald-600" />
              Database Created
            </DialogTitle>
            <DialogDescription>
              Save these credentials now — the password is masked afterwards.
            </DialogDescription>
          </DialogHeader>
          {createdDb && (
            <div className="grid gap-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Name</span>
                <span className="font-mono">{createdDb.name}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Host</span>
                <span className="font-mono">{createdDb.host}:{createdDb.port}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">User</span>
                <span className="font-mono">{createdDb.username}</span>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Password</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => copyToClipboard(createdDb.password, 'Password copied')}
                  >
                    <Copy className="size-3 mr-1" />
                    Copy
                  </Button>
                </div>
                <code className="block w-full rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">
                  {createdDb.password}
                </code>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button className={primaryBtn} onClick={() => setCreatedDb(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm password reset */}
      <Dialog open={!!resetPwFor} onOpenChange={(v) => !v && setResetPwFor(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-5 text-amber-500" />
              Reset database password
            </DialogTitle>
            <DialogDescription>
              A new secure password will be generated for{' '}
              <span className="font-mono">{resetPwFor?.username}</span> on{' '}
              <span className="font-mono">{resetPwFor?.name}</span>.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-amber-300/60 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20 p-3 text-sm">
            <p className="font-medium text-amber-800 dark:text-amber-300">
              Any app using the old password will stop connecting
            </p>
            <p className="mt-1 text-amber-700 dark:text-amber-400/90">
              If a site (WordPress, Laravel, …) connects to this database, update its
              config with the new password right after resetting.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetPwFor(null)}>
              Cancel
            </Button>
            <Button
              className={primaryBtn}
              disabled={resettingPw}
              onClick={() => resetPwFor && handleResetPassword(resetPwFor)}
            >
              {resettingPw ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Resetting…
                </>
              ) : (
                <>
                  <KeyRound className="size-4 mr-2" />
                  Reset password
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Show the newly generated password once */}
      <Dialog open={!!newPw} onOpenChange={(v) => !v && setNewPw(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="size-5 text-emerald-600" />
              New password generated
            </DialogTitle>
            <DialogDescription>
              Copy it now and update any app that connects to{' '}
              <span className="font-mono">{newPw?.name}</span>.
            </DialogDescription>
          </DialogHeader>
          {newPw && (
            <div className="grid gap-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">User</span>
                <span className="font-mono">{newPw.username}</span>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">New password</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => copyToClipboard(newPw.password, 'Password copied')}
                  >
                    <Copy className="size-3 mr-1" />
                    Copy
                  </Button>
                </div>
                <code className="block w-full rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">
                  {newPw.password}
                </code>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button className={primaryBtn} onClick={() => setNewPw(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={(v) => !v && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-red-500" />
              Delete Database
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently drops the database and all of its data.
              This action cannot be undone.
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
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="size-4 mr-2" />
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
// 2. BackupsTab
// ═══════════════════════════════════════════════════════════════════════

export function BackupsTab({ projectId }: { projectId: string }) {
  const [backups, setBackups] = useState<WebsiteBackup[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [createType, setCreateType] = useState<'manual' | 'scheduled'>('manual')
  const [createNote, setCreateNote] = useState('')
  const [creating, setCreating] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [restoreId, setRestoreId] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const fetchBackups = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/backups`, {
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        setBackups(data.backups || [])
      } else {
        toast.error(data.error || 'Failed to load backups')
      }
    } catch {
      toast.error('Network error loading backups')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    fetchBackups()
  }, [fetchBackups])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/backups`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ type: createType, note: createNote.trim() || undefined }),
      })
      const data = await res.json()
      if (res.ok && data.backup) {
        toast.success('Backup created')
        setCreateOpen(false)
        setCreateNote('')
        setCreateType('manual')
        fetchBackups()
      } else {
        toast.error(data.error || 'Failed to create backup')
      }
    } catch {
      toast.error('Network error creating backup')
    } finally {
      setCreating(false)
    }
  }

  const handleDownload = async (backup: WebsiteBackup) => {
    setDownloadingId(backup.id)
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/backups/${backup.id}`,
        { headers: getAuthHeaders() }
      )
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error || 'Download failed')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = backup.filename || `backup-${backup.id}.tar.gz`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.success('Download started')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setDownloadingId(null)
    }
  }

  const handleRestore = async () => {
    if (!restoreId) return
    setRestoring(true)
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/backups/${restoreId}`,
        {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ action: 'restore' }),
        }
      )
      const data = await res.json()
      if (res.ok) {
        toast.success(data.message || 'Restore completed')
        setRestoreId(null)
        fetchBackups()
      } else {
        toast.error(data.message || data.error || 'Restore failed')
      }
    } catch {
      toast.error('Network error during restore')
    } finally {
      setRestoring(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    setDeleting(true)
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/backups/${deleteId}`,
        { method: 'DELETE', headers: getAuthHeaders() }
      )
      const data = await res.json()
      if (res.ok) {
        toast.success('Backup deleted')
        setDeleteId(null)
        fetchBackups()
      } else {
        toast.error(data.error || 'Failed to delete backup')
      }
    } catch {
      toast.error('Network error deleting backup')
    } finally {
      setDeleting(false)
    }
  }

  const statusBadge = (status: string) => {
    const lower = (status || '').toLowerCase()
    if (lower === 'completed') {
      return (
        <Badge variant="outline" className="bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/50">
          <CheckCircle2 className="size-3 mr-1" />
          Completed
        </Badge>
      )
    }
    if (lower === 'failed') {
      return (
        <Badge variant="outline" className="bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 border-red-200 dark:border-red-900/50">
          <XCircle className="size-3 mr-1" />
          Failed
        </Badge>
      )
    }
    if (lower === 'running' || lower === 'pending') {
      return (
        <Badge variant="outline" className="bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 border-amber-200 dark:border-amber-900/50">
          <Loader2 className="size-3 mr-1 animate-spin" />
          {lower === 'pending' ? 'Pending' : 'Running'}
        </Badge>
      )
    }
    return <Badge variant="outline">{status}</Badge>
  }

  const typeBadge = (type: string) => {
    const lower = (type || '').toLowerCase()
    if (lower === 'scheduled') {
      return (
        <Badge variant="outline" className="bg-violet-50 text-violet-700 dark:bg-violet-900/20 dark:text-violet-400 border-violet-200 dark:border-violet-900/50 text-xs">
          Scheduled
        </Badge>
      )
    }
    if (lower === 'pre-deploy') {
      return (
        <Badge variant="outline" className="bg-sky-50 text-sky-700 dark:bg-sky-900/20 dark:text-sky-400 border-sky-200 dark:border-sky-900/50 text-xs">
          Pre-deploy
        </Badge>
      )
    }
    return (
      <Badge variant="outline" className="bg-gray-50 text-gray-700 dark:bg-gray-800/30 dark:text-gray-400 border-gray-200 dark:border-gray-700 text-xs">
        Manual
      </Badge>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Archive className={`size-5 ${primaryText}`} />
              Backups
            </CardTitle>
            <CardDescription className="mt-1">
              Database + files snapshots. One-click restore in case of emergency.
            </CardDescription>
          </div>
          <Button size="sm" className={primaryBtn} onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5 mr-1" />
            Create Backup
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : backups.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground">
            <Archive className="size-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">No backups yet</p>
            <p className="text-xs mt-1">
              Create your first backup to enable one-click restore.
            </p>
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Filename</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {backups.map((b) => (
                  <TableRow
                    key={b.id}
                    className="hover:bg-emerald-50/40 dark:hover:bg-emerald-950/10 transition-colors"
                  >
                    <TableCell>
                      <span className="font-mono text-xs break-all">{b.filename}</span>
                    </TableCell>
                    <TableCell className="text-xs">{formatBytes(b.sizeBytes)}</TableCell>
                    <TableCell>{typeBadge(b.type)}</TableCell>
                    <TableCell>{statusBadge(b.status)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>{timeAgo(b.createdAt)}</span>
                        </TooltipTrigger>
                        <TooltipContent>{formatDate(b.createdAt)}</TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[160px] truncate">
                      {b.note || '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              disabled={downloadingId === b.id}
                              onClick={() => handleDownload(b)}
                            >
                              {downloadingId === b.id ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Download className="size-3.5" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Download</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              onClick={() => setRestoreId(b.id)}
                            >
                              <RotateCwRestore />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Restore</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20"
                              onClick={() => setDeleteId(b.id)}
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

      {/* Create backup dialog */}
      <Dialog open={createOpen} onOpenChange={(v) => !v && setCreateOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Archive className={`size-5 ${primaryText}`} />
              Create Backup
            </DialogTitle>
            <DialogDescription>
              Snapshot the project files and database now.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>Type</Label>
              <Select value={createType} onValueChange={(v) => setCreateType(v as 'manual' | 'scheduled')}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="scheduled">Scheduled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bk-note">Note (optional)</Label>
              <Input
                id="bk-note"
                placeholder="e.g. before WordPress upgrade"
                value={createNote}
                onChange={(e) => setCreateNote(e.target.value)}
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
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Plus className="size-4 mr-2" />
                  Create
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restore confirmation */}
      <AlertDialog open={!!restoreId} onOpenChange={(v) => !v && setRestoreId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-amber-500" />
              Restore Backup
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will replace current files and database with the contents
              of this backup. This action cannot be undone. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoring}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRestore}
              disabled={restoring}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {restoring ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Restoring...
                </>
              ) : (
                <>
                  <RotateCwRestore className="size-4 mr-2" />
                  Restore Now
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={(v) => !v && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-red-500" />
              Delete Backup
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the backup file from disk. Continue?
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
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="size-4 mr-2" />
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

// Small inline restore icon (lucide doesn't have a "RotateCwRestore" export by default)
function RotateCwRestore({ className }: { className?: string }) {
  return <RefreshCw className={className} />
}

// ═══════════════════════════════════════════════════════════════════════
// 3. FilesTab
// ═══════════════════════════════════════════════════════════════════════

const TEXT_FILE_EXTENSIONS = [
  'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'xml', 'csv', 'tsv', 'log',
  'env', 'ini', 'conf', 'cfg', 'toml', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'py', 'rb', 'php', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift',
  'kt', 'sh', 'bash', 'zsh', 'sql', 'graphql', 'gql', 'vue', 'svelte', 'astro',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg',
]

function isLikelyTextFile(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower.startsWith('.')) {
    const ext = lower.slice(1)
    return TEXT_FILE_EXTENSIONS.includes(ext)
  }
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return false
  return TEXT_FILE_EXTENSIONS.includes(lower.slice(dot + 1))
}

export function FilesTab({ projectId }: { projectId: string }) {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [currentPath, setCurrentPath] = useState('')
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)

  // Editor dialog
  const [editorFile, setEditorFile] = useState<FileEntry | null>(null)
  const [editorContent, setEditorContent] = useState('')
  const [editorOriginal, setEditorOriginal] = useState('')
  const [editorTruncated, setEditorTruncated] = useState(false)
  const [editorLoading, setEditorLoading] = useState(false)
  const [editorSaving, setEditorSaving] = useState(false)

  // New folder / new file / rename dialogs
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [newFileOpen, setNewFileOpen] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [renameEntry, setRenameEntry] = useState<FileEntry | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteEntry, setDeleteEntry] = useState<FileEntry | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)

  // Encode a project-relative path for use as URL path segments in the
  // /files/[...path] routes: encode each segment but keep the "/" separators
  // so nested paths (e.g. wp-content/themes/style.css) route correctly.
  // For a single segment (root files) this is identical to encodeURIComponent.
  const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/')

  const fetchFiles = useCallback(
    async (path: string) => {
      setLoading(true)
      try {
        const qs = path ? `?path=${encodeURIComponent(path)}` : ''
        const res = await fetch(`/api/hosting/${projectId}/files${qs}`, {
          headers: getAuthHeaders(),
        })
        const data: FileListResponse = await res.json()
        if (res.ok) {
          setFiles(data.files || [])
          setCurrentPath(data.currentPath || '')
          setParentPath(data.parentPath ?? null)
        } else {
          toast.error((data as unknown as { error?: string }).error || 'Failed to load files')
        }
      } catch {
        toast.error('Network error loading files')
      } finally {
        setLoading(false)
      }
    },
    [projectId]
  )

  useEffect(() => {
    fetchFiles('')
  }, [fetchFiles])

  const crumbs = currentPath ? currentPath.split('/').filter(Boolean) : []

  const navigateTo = (path: string) => {
    if (path.includes('..')) return // safety
    fetchFiles(path)
  }

  const navigateToCrumb = (index: number) => {
    const sub = crumbs.slice(0, index + 1).join('/')
    navigateTo(sub)
  }

  const handleUpload = async (file: File, targetPath: string) => {
    setUploading(true)
    setUploadProgress(0)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('path', targetPath)
      const token = localStorage.getItem('apsamo_token')
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api/hosting/${projectId}/files`)
      xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          setUploadProgress(Math.round((e.loaded / e.total) * 100))
        }
      }
      const result = await new Promise<{ ok: boolean; message?: string; error?: string }>(
        (resolve, reject) => {
          xhr.onload = () => {
            try {
              const data = JSON.parse(xhr.responseText)
              if (xhr.status >= 200 && xhr.status < 300) {
                resolve({ ok: true, message: data.message })
              } else {
                resolve({ ok: false, error: data.error || data.message || 'Upload failed' })
              }
            } catch {
              reject(new Error('Invalid server response'))
            }
          }
          xhr.onerror = () => reject(new Error('Network error during upload'))
        }
      )
      if (result.ok) {
        toast.success(`Uploaded ${file.name}`)
        fetchFiles(currentPath)
      } else {
        toast.error(result.error || 'Upload failed')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      setUploadProgress(0)
    }
  }

  const handleUploadFiles = async (fileList: FileList) => {
    for (const f of Array.from(fileList)) {
      await handleUpload(f, currentPath)
    }
  }

  const handleDownload = async (entry: FileEntry) => {
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/files/${encodePath(entry.path)}?action=download`,
        { headers: getAuthHeaders() }
      )
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error || 'Download failed')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = entry.name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.success('Download started')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed')
    }
  }

  // Export the current folder (or whole site at root) as a downloadable archive.
  const handleExport = async () => {
    setExporting(true)
    try {
      const qs = currentPath ? `&path=${encodeURIComponent(currentPath)}` : ''
      const res = await fetch(`/api/hosting/${projectId}/files?action=export${qs}`, {
        headers: getAuthHeaders(),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error || 'Export failed')
      }
      const blob = await res.blob()
      const cd = res.headers.get('Content-Disposition') || ''
      const match = cd.match(/filename="?([^"]+)"?/)
      const fallback = `${currentPath ? currentPath.split('/').pop() : 'website'}-export.zip`
      const filename = match?.[1] || fallback
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.success('Export ready — download started')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  // Import a .zip / .tar.gz archive and extract it into the current folder.
  const handleImport = async (file: File) => {
    setImporting(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('path', currentPath)
      formData.append('action', 'import')
      const token = localStorage.getItem('apsamo_token')
      const res = await fetch(`/api/hosting/${projectId}/files`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      const data = await res.json().catch(() => null)
      if (res.ok) {
        toast.success(data?.message || `Imported ${file.name}`)
        fetchFiles(currentPath)
      } else {
        toast.error(data?.error || 'Import failed')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  const openEditor = async (entry: FileEntry) => {
    setEditorFile(entry)
    setEditorContent('')
    setEditorOriginal('')
    setEditorTruncated(false)
    setEditorLoading(true)
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/files/${encodePath(entry.path)}?action=content`,
        { headers: getAuthHeaders() }
      )
      const data = await res.json()
      if (res.ok) {
        setEditorContent(data.content || '')
        setEditorOriginal(data.content || '')
        setEditorTruncated(!!data.truncated)
      } else {
        toast.error(data.error || 'Failed to load file content')
        setEditorFile(null)
      }
    } catch {
      toast.error('Network error loading file content')
      setEditorFile(null)
    } finally {
      setEditorLoading(false)
    }
  }

  const handleSaveFile = async () => {
    if (!editorFile) return
    setEditorSaving(true)
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/files/${encodePath(editorFile.path)}`,
        {
          method: 'PUT',
          headers: getAuthHeaders(),
          body: JSON.stringify({ content: editorContent }),
        }
      )
      const data = await res.json()
      if (res.ok) {
        toast.success(data.message || 'File saved')
        setEditorOriginal(editorContent)
        fetchFiles(currentPath)
      } else {
        toast.error(data.error || 'Failed to save file')
      }
    } catch {
      toast.error('Network error saving file')
    } finally {
      setEditorSaving(false)
    }
  }

  const handleMkdir = async () => {
    const name = newFolderName.trim()
    if (!name) {
      toast.error('Folder name required')
      return
    }
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/files/${encodePath(currentPath)}`,
        {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ action: 'mkdir', newPath: name }),
        }
      )
      const data = await res.json()
      if (res.ok) {
        toast.success('Folder created')
        setNewFolderOpen(false)
        setNewFolderName('')
        fetchFiles(currentPath)
      } else {
        toast.error(data.error || 'Failed to create folder')
      }
    } catch {
      toast.error('Network error creating folder')
    }
  }

  const handleNewFile = async () => {
    const name = newFileName.trim()
    if (!name) {
      toast.error('File name required')
      return
    }
    const fullPath = currentPath ? `${currentPath}/${name}` : name
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/files/${encodePath(fullPath)}`,
        {
          method: 'PUT',
          headers: getAuthHeaders(),
          body: JSON.stringify({ content: '' }),
        }
      )
      const data = await res.json()
      if (res.ok) {
        toast.success('File created')
        setNewFileOpen(false)
        setNewFileName('')
        fetchFiles(currentPath)
      } else {
        toast.error(data.error || 'Failed to create file')
      }
    } catch {
      toast.error('Network error creating file')
    }
  }

  const handleRename = async () => {
    if (!renameEntry) return
    const name = renameValue.trim()
    if (!name) {
      toast.error('New name required')
      return
    }
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/files/${encodePath(renameEntry.path)}`,
        {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ action: 'rename', newPath: name }),
        }
      )
      const data = await res.json()
      if (res.ok) {
        toast.success('Renamed')
        setRenameEntry(null)
        setRenameValue('')
        fetchFiles(currentPath)
      } else {
        toast.error(data.error || 'Failed to rename')
      }
    } catch {
      toast.error('Network error renaming')
    }
  }

  const handleDelete = async () => {
    if (!deleteEntry) return
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/files/${encodePath(deleteEntry.path)}`,
        { method: 'DELETE', headers: getAuthHeaders() }
      )
      const data = await res.json()
      if (res.ok) {
        toast.success('Deleted')
        setDeleteEntry(null)
        fetchFiles(currentPath)
      } else {
        toast.error(data.error || 'Failed to delete')
      }
    } catch {
      toast.error('Network error deleting')
    }
  }

  const fileIcon = (entry: FileEntry) => {
    if (entry.type === 'directory') {
      return <Folder className="size-4 text-amber-500 shrink-0" />
    }
    if (entry.type === 'symlink') {
      return <Link2 className="size-4 text-violet-500 shrink-0" />
    }
    return <FileIcon className="size-4 text-muted-foreground shrink-0" />
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <HardDrive className={`size-5 ${primaryText}`} />
                Files
              </CardTitle>
              <CardDescription className="mt-1">
                Browse, edit and upload files inside the project deploy path.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    handleUploadFiles(e.target.files)
                    e.target.value = ''
                  }
                }}
              />
              <input
                ref={importInputRef}
                type="file"
                accept=".zip,.tar.gz,.tgz,.tar"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) {
                    handleImport(e.target.files[0])
                    e.target.value = ''
                  }
                }}
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? (
                  <Loader2 className="size-3.5 mr-1 animate-spin" />
                ) : (
                  <Upload className="size-3.5 mr-1" />
                )}
                Upload
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setNewFolderOpen(true)}
              >
                <FolderPlus className="size-3.5 mr-1" />
                New Folder
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setNewFileOpen(true)}
              >
                <FilePlus className="size-3.5 mr-1" />
                New File
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={handleExport}
                disabled={exporting}
                title="Download this folder (or the whole site at the root) as an archive"
              >
                {exporting ? (
                  <Loader2 className="size-3.5 mr-1 animate-spin" />
                ) : (
                  <Download className="size-3.5 mr-1" />
                )}
                Export
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => importInputRef.current?.click()}
                disabled={importing}
                title="Upload a .zip / .tar.gz archive and extract it into this folder"
              >
                {importing ? (
                  <Loader2 className="size-3.5 mr-1 animate-spin" />
                ) : (
                  <Archive className="size-3.5 mr-1" />
                )}
                Import
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => fetchFiles(currentPath)}
                disabled={loading}
              >
                <RefreshCw className={`size-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
          </div>

          {/* Breadcrumb */}
          <div className="flex items-center gap-1 text-xs flex-wrap">
            <button
              type="button"
              onClick={() => navigateTo('')}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-muted ${
                currentPath === '' ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-muted-foreground'
              }`}
            >
              <Home className="size-3.5" />
              deployPath
            </button>
            {crumbs.map((c, i) => (
              <span key={i} className="inline-flex items-center">
                <ChevronRight className="size-3 text-muted-foreground" />
                <button
                  type="button"
                  onClick={() => navigateToCrumb(i)}
                  className={`px-2 py-1 rounded hover:bg-muted ${
                    i === crumbs.length - 1
                      ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                      : 'text-muted-foreground'
                  }`}
                >
                  {c}
                </button>
              </span>
            ))}
          </div>

          {uploading && (
            <div className="space-y-1">
              <Progress value={uploadProgress} className="h-1.5" />
              <p className="text-xs text-muted-foreground">Uploading... {uploadProgress}%</p>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div
          className={`rounded-lg border-2 border-dashed transition-colors ${
            dragOver
              ? 'border-emerald-400 bg-emerald-50/50 dark:bg-emerald-950/10'
              : 'border-border'
          }`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
              handleUploadFiles(e.dataTransfer.files)
            }
          }}
        >
          {loading ? (
            <div className="p-4 space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : files.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              <FolderOpen className="size-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-medium">Empty folder</p>
              <p className="text-xs mt-1">
                Drag files here or use the Upload button to add files.
              </p>
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden sm:block max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead>Modified</TableHead>
                      <TableHead>Perms</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parentPath !== null && parentPath !== undefined && (
                      <TableRow
                        className="hover:bg-muted/40 cursor-pointer"
                        onClick={() => navigateTo(parentPath)}
                      >
                        <TableCell colSpan={5} className="text-xs">
                          <span className="inline-flex items-center gap-2 text-muted-foreground">
                            <ArrowUp className="size-4" />
                            ..
                          </span>
                        </TableCell>
                      </TableRow>
                    )}
                    {files.map((f) => (
                      <TableRow
                        key={f.path}
                        className="hover:bg-emerald-50/40 dark:hover:bg-emerald-950/10 transition-colors cursor-pointer"
                        onClick={() => {
                          if (f.type === 'directory') {
                            navigateTo(f.path)
                          } else if (f.type === 'file' && isLikelyTextFile(f.name)) {
                            openEditor(f)
                          }
                        }}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2 min-w-0">
                            {fileIcon(f)}
                            <span className="font-mono text-sm truncate">{f.name}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {f.type === 'directory' ? '—' : formatBytes(f.size)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {f.modifiedAt ? timeAgo(f.modifiedAt) : '—'}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {f.permissions || '—'}
                        </TableCell>
                        <TableCell className="text-right">
                          <div
                            className="flex items-center justify-end gap-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {f.type === 'file' && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="size-7"
                                    onClick={() => handleDownload(f)}
                                  >
                                    <Download className="size-3.5" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Download</TooltipContent>
                              </Tooltip>
                            )}
                            {f.type === 'file' && isLikelyTextFile(f.name) && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="size-7"
                                    onClick={() => openEditor(f)}
                                  >
                                    <Edit className="size-3.5" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Edit</TooltipContent>
                              </Tooltip>
                            )}
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-7"
                                  onClick={() => {
                                    setRenameEntry(f)
                                    setRenameValue(f.name)
                                  }}
                                >
                                  <Edit2Pencil />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Rename</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-7 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20"
                                  onClick={() => setDeleteEntry(f)}
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

              {/* Mobile cards */}
              <div className="sm:hidden max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20 divide-y">
                {parentPath !== null && parentPath !== undefined && (
                  <button
                    type="button"
                    onClick={() => navigateTo(parentPath)}
                    className="w-full text-left p-3 text-xs text-muted-foreground hover:bg-muted/40"
                  >
                    <span className="inline-flex items-center gap-2">
                      <ArrowUp className="size-4" />
                      ..
                    </span>
                  </button>
                )}
                {files.map((f) => (
                  <div
                    key={f.path}
                    className="p-3 hover:bg-emerald-50/40 dark:hover:bg-emerald-950/10"
                  >
                    <button
                      type="button"
                      className="w-full text-left"
                      onClick={() => {
                        if (f.type === 'directory') {
                          navigateTo(f.path)
                        } else if (f.type === 'file' && isLikelyTextFile(f.name)) {
                          openEditor(f)
                        } else if (f.type === 'file') {
                          handleDownload(f)
                        }
                      }}
                    >
                      <div className="flex items-center gap-2">
                        {fileIcon(f)}
                        <span className="font-mono text-sm truncate flex-1">{f.name}</span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 pl-6">
                        {f.type === 'directory' ? 'folder' : formatBytes(f.size)}
                        {f.modifiedAt ? ` · ${timeAgo(f.modifiedAt)}` : ''}
                        {f.permissions ? ` · ${f.permissions}` : ''}
                      </div>
                    </button>
                    <div className="flex items-center gap-1 mt-2 pl-6">
                      {f.type === 'file' && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handleDownload(f)}
                        >
                          <Download className="size-3 mr-1" />
                          Download
                        </Button>
                      )}
                      {f.type === 'file' && isLikelyTextFile(f.name) && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => openEditor(f)}
                        >
                          <Edit className="size-3 mr-1" />
                          Edit
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => {
                          setRenameEntry(f)
                          setRenameValue(f.name)
                        }}
                      >
                        <Edit2Pencil className="size-3 mr-1" />
                        Rename
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs text-red-600 hover:text-red-700"
                        onClick={() => setDeleteEntry(f)}
                      >
                        <Trash2 className="size-3 mr-1" />
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </CardContent>

      {/* Editor Dialog */}
      <Dialog open={!!editorFile} onOpenChange={(v) => !v && setEditorFile(null)}>
        <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Edit className={`size-4 ${primaryText}`} />
              <span className="font-mono truncate">{editorFile?.name}</span>
            </DialogTitle>
            <DialogDescription className="font-mono text-xs">
              {editorFile?.path}
            </DialogDescription>
          </DialogHeader>
          {editorTruncated && (
            <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20 p-2 text-xs text-amber-700 dark:text-amber-400 flex items-center gap-2">
              <AlertTriangle className="size-3.5 shrink-0" />
              File truncated — only the first portion is shown for editing.
            </div>
          )}
          <div className="flex-1 min-h-0">
            {editorLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-64 w-full" />
              </div>
            ) : (
              <Textarea
                value={editorContent}
                onChange={(e) => setEditorContent(e.target.value)}
                className="font-mono text-xs h-64 sm:h-80 resize-none"
                spellCheck={false}
              />
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorFile(null)} disabled={editorSaving}>
              Cancel
            </Button>
            <Button
              className={primaryBtn}
              onClick={handleSaveFile}
              disabled={editorSaving || editorLoading || editorContent === editorOriginal}
            >
              {editorSaving ? (
                <Loader2 className="size-4 mr-2 animate-spin" />
              ) : (
                <Save className="size-4 mr-2" />
              )}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Folder Dialog */}
      <Dialog open={newFolderOpen} onOpenChange={(v) => !v && setNewFolderOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderPlus className={`size-5 ${primaryText}`} />
              New Folder
            </DialogTitle>
            <DialogDescription>
              Create a folder inside the current directory.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-4">
            <Label htmlFor="folder-name">Name</Label>
            <Input
              id="folder-name"
              placeholder="my-folder"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              className="font-mono text-sm"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFolderOpen(false)}>Cancel</Button>
            <Button className={primaryBtn} onClick={handleMkdir}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New File Dialog */}
      <Dialog open={newFileOpen} onOpenChange={(v) => !v && setNewFileOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FilePlus className={`size-5 ${primaryText}`} />
              New File
            </DialogTitle>
            <DialogDescription>
              Create an empty text file you can edit inline.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-4">
            <Label htmlFor="file-name">Name</Label>
            <Input
              id="file-name"
              placeholder="index.html"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              className="font-mono text-sm"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFileOpen(false)}>Cancel</Button>
            <Button className={primaryBtn} onClick={handleNewFile}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog open={!!renameEntry} onOpenChange={(v) => !v && setRenameEntry(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Edit className={`size-5 ${primaryText}`} />
              Rename {renameEntry?.type === 'directory' ? 'Folder' : 'File'}
            </DialogTitle>
            <DialogDescription className="font-mono text-xs">
              {renameEntry?.path}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-4">
            <Label htmlFor="rename-value">New name</Label>
            <Input
              id="rename-value"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              className="font-mono text-sm"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameEntry(null)}>Cancel</Button>
            <Button className={primaryBtn} onClick={handleRename}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteEntry} onOpenChange={(v) => !v && setDeleteEntry(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-red-500" />
              Delete {deleteEntry?.type === 'directory' ? 'Folder' : 'File'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete <span className="font-mono">{deleteEntry?.name}</span>?
              {deleteEntry?.type === 'directory' && ' This will also delete everything inside the folder.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              <Trash2 className="size-4 mr-2" />
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

// lucide-react doesn't export a "pencil" by default — alias to Edit
function Edit2Pencil({ className }: { className?: string }) {
  return <Edit className={className} />
}

// ═══════════════════════════════════════════════════════════════════════
// 4. TerminalTab
// ═══════════════════════════════════════════════════════════════════════

interface TerminalLine {
  id: number
  kind: 'input' | 'stdout' | 'stderr' | 'system'
  text: string
}

export function TerminalTab({ projectId }: { projectId: string }) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [creating, setCreating] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lines, setLines] = useState<TerminalLine[]>([])
  const [input, setInput] = useState('')
  const [cwd, setCwd] = useState('/app')
  const [running, setRunning] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number>(-1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const lineIdRef = useRef(0)
  const containerNameRef = useRef<string>('container')

  const pushLine = useCallback((kind: TerminalLine['kind'], text: string) => {
    lineIdRef.current += 1
    setLines((prev) => [...prev, { id: lineIdRef.current, kind, text }])
  }, [])

  const createSession = useCallback(async () => {
    setCreating(true)
    setError(null)
    try {
      const res = await fetch(`/api/hosting/${projectId}/terminal`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ action: 'create' }),
      })
      const data = await res.json()
      if (res.ok && data.sessionId) {
        setSessionId(data.sessionId)
        if (data.cwd) setCwd(data.cwd)
        if (data.containerName) containerNameRef.current = data.containerName
        setLines([])
        pushLine('system', `Session ${data.sessionId.slice(0, 8)} started.`)
      } else {
        setError(data.error || data.message || 'Failed to start session')
      }
    } catch {
      setError('Network error starting session')
    } finally {
      setCreating(false)
    }
  }, [projectId, pushLine])

  useEffect(() => {
    createSession()
    return () => {
      // Best-effort cleanup on unmount
      if (sessionId) {
        const token = localStorage.getItem('apsamo_token')
        fetch(`/api/hosting/${projectId}/terminal?sessionId=${sessionId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {})
      }
    }
  }, [projectId])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [lines])

  const runCommand = async (cmd: string) => {
    if (!sessionId || !cmd.trim()) return
    setRunning(true)
    pushLine('input', `${getPrompt()}${cmd}`)
    setHistory((h) => [...h, cmd])
    setHistoryIndex(-1)
    try {
      const res = await fetch(`/api/hosting/${projectId}/terminal`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ action: 'run', sessionId, command: cmd }),
      })
      const data: TerminalRunResult & { error?: string; message?: string } = await res.json()
      if (res.ok) {
        if (data.stdout) {
          data.stdout.split('\n').forEach((l) => pushLine('stdout', l))
        }
        if (data.stderr) {
          data.stderr.split('\n').forEach((l) => pushLine('stderr', l))
        }
        if (!data.stdout && !data.stderr) {
          pushLine('system', '(no output)')
        }
        if (data.exitCode !== 0 && data.exitCode != null) {
          pushLine('stderr', `exit ${data.exitCode}`)
        }
        if (data.cwd) setCwd(data.cwd)
      } else {
        pushLine('stderr', data.error || data.message || 'Command failed')
      }
    } catch {
      pushLine('stderr', 'Network error')
    } finally {
      setRunning(false)
      inputRef.current?.focus()
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || running) return
    const cmd = input
    setInput('')
    runCommand(cmd)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (history.length === 0) return
      const nextIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(nextIndex)
      setInput(history[nextIndex])
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (history.length === 0 || historyIndex === -1) return
      const nextIndex = historyIndex + 1
      if (nextIndex >= history.length) {
        setHistoryIndex(-1)
        setInput('')
      } else {
        setHistoryIndex(nextIndex)
        setInput(history[nextIndex])
      }
    }
  }

  const handleClear = () => {
    setLines([])
  }

  const handleClose = async () => {
    if (!sessionId) return
    try {
      await fetch(`/api/hosting/${projectId}/terminal?sessionId=${sessionId}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      })
    } catch {
      // ignore
    }
    setSessionId(null)
    setLines([])
    pushLine('system', 'Session closed.')
  }

  const getPrompt = () => `root@${containerNameRef.current}:${cwd}$ `

  if (creating) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <TerminalIcon className={`size-5 ${primaryText}`} />
            Terminal
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="size-4 animate-spin" />
          Starting session...
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <TerminalIcon className={`size-5 ${primaryText}`} />
            Terminal
          </CardTitle>
        </CardHeader>
        <CardContent className="py-8 text-center">
          <CircleAlert className="size-10 mx-auto mb-3 text-amber-500 opacity-70" />
          <p className="text-sm font-medium">{error}</p>
          <p className="text-xs text-muted-foreground mt-1">
            Start the website to use the terminal.
          </p>
          <Button className={`${primaryBtn} mt-4`} size="sm" onClick={createSession}>
            <RefreshCw className="size-3.5 mr-1" />
            Retry
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (!sessionId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <TerminalIcon className={`size-5 ${primaryText}`} />
            Terminal
          </CardTitle>
        </CardHeader>
        <CardContent className="py-8 text-center">
          <TerminalIcon className="size-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm font-medium">Session closed</p>
          <p className="text-xs text-muted-foreground mt-1">
            Click to start a new session.
          </p>
          <Button className={`${primaryBtn} mt-4`} size="sm" onClick={createSession}>
            <Plus className="size-3.5 mr-1" />
            New Session
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <TerminalIcon className={`size-5 ${primaryText}`} />
              Terminal
            </CardTitle>
            <CardDescription className="mt-1">
              Interactive shell inside the project container.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={handleClear}>
              <X className="size-3.5 mr-1" />
              Clear
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20"
              onClick={handleClose}
            >
              <XCircle className="size-3.5 mr-1" />
              Close Session
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20 p-3 text-xs text-amber-700 dark:text-amber-400 flex items-start gap-2 mb-3">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">This is a real shell inside your container.</p>
            <p className="opacity-90 mt-0.5">Commands run as root. Be careful.</p>
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 border-b border-zinc-800">
            <span className="size-2 rounded-full bg-red-500/80" />
            <span className="size-2 rounded-full bg-amber-500/80" />
            <span className="size-2 rounded-full bg-emerald-500/80" />
            <span className="ml-2 text-[10px] text-zinc-500 font-mono truncate">
              {containerNameRef.current} · session {sessionId.slice(0, 8)}
            </span>
          </div>
          <div
            ref={scrollRef}
            className="p-3 text-xs font-mono text-emerald-400 overflow-auto h-80 sm:h-96 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700"
          >
            {lines.length === 0 ? (
              <div className="text-zinc-500">
                Ready. Type a command and press Enter.
              </div>
            ) : (
              lines.map((l) => {
                if (l.kind === 'input') {
                  return (
                    <div key={l.id} className="text-zinc-200 leading-relaxed whitespace-pre-wrap break-all">
                      {l.text}
                    </div>
                  )
                }
                if (l.kind === 'stderr') {
                  return (
                    <div key={l.id} className="text-red-400 leading-relaxed whitespace-pre-wrap break-all">
                      {l.text || ' '}
                    </div>
                  )
                }
                if (l.kind === 'system') {
                  return (
                    <div key={l.id} className="text-zinc-500 italic leading-relaxed whitespace-pre-wrap break-all">
                      {l.text || ' '}
                    </div>
                  )
                }
                return (
                  <div key={l.id} className="text-zinc-300 leading-relaxed whitespace-pre-wrap break-all">
                    {l.text || ' '}
                  </div>
                )
              })
            )}
            <form onSubmit={handleSubmit} className="flex items-center gap-2 mt-1">
              <span className="text-emerald-400 shrink-0">{getPrompt()}</span>
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={running}
                spellCheck={false}
                autoComplete="off"
                className="flex-1 bg-transparent border-0 outline-none text-zinc-100 font-mono text-xs"
                placeholder={running ? 'running...' : ''}
              />
              {running && <Loader2 className="size-3 text-zinc-500 animate-spin shrink-0" />}
            </form>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// 5. ResourcesTab
// ═══════════════════════════════════════════════════════════════════════

function usageColor(percent: number): string {
  if (percent > 85) return 'bg-red-500'
  if (percent > 60) return 'bg-amber-500'
  return 'bg-emerald-500'
}

function usageTextColor(percent: number): string {
  if (percent > 85) return 'text-red-600 dark:text-red-400'
  if (percent > 60) return 'text-amber-600 dark:text-amber-400'
  return 'text-emerald-600 dark:text-emerald-400'
}

function Sparkline({
  data,
  color = '#10b981',
  height = 40,
  max,
}: {
  data: number[]
  color?: string
  height?: number
  max?: number
}) {
  if (!data || data.length === 0) {
    return (
      <div
        className="text-xs text-muted-foreground flex items-center justify-center"
        style={{ height }}
      >
        No history yet
      </div>
    )
  }
  const w = 100
  const maxVal = max ?? Math.max(...data, 1)
  const step = data.length > 1 ? w / (data.length - 1) : 0
  const points = data
    .map((v, i) => {
      const x = i * step
      const y = height - (v / maxVal) * height
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className="w-full"
      style={{ height }}
    >
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

export function ResourcesTab({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ResourceResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchResources = useCallback(
    async (initial = false) => {
      if (initial) {
        setLoading(true)
        setError(null)
      }
      try {
        const res = await fetch(`/api/hosting/${projectId}/resources?hours=24`, {
          headers: getAuthHeaders(),
        })
        const json = await res.json()
        if (res.ok) {
          setData(json as ResourceResponse)
        } else {
          if (initial) setError(json.error || 'Failed to load resources')
        }
      } catch {
        if (initial) setError('Network error loading resources')
      } finally {
        if (initial) setLoading(false)
      }
    },
    [projectId]
  )

  useEffect(() => {
    fetchResources(true)
    pollRef.current = setInterval(() => fetchResources(false), 5000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [fetchResources])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Activity className={`size-5 ${primaryText}`} />
            Resources
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Activity className={`size-5 ${primaryText}`} />
            Resources
          </CardTitle>
        </CardHeader>
        <CardContent className="py-10 text-center">
          <CircleAlert className="size-10 mx-auto mb-3 text-amber-500 opacity-70" />
          <p className="text-sm font-medium">{error}</p>
          <p className="text-xs text-muted-foreground mt-1">
            Start the website to see resource usage.
          </p>
          <Button className={`${primaryBtn} mt-4`} size="sm" onClick={() => fetchResources(true)}>
            <RefreshCw className="size-3.5 mr-1" />
            Retry
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (!data) return null

  const c = data.current
  const cpuPercent = Math.min(100, Math.max(0, c.cpuPercent || 0))
  const ramPercent = c.ramMB > 0 ? Math.min(100, (c.ramUsedMB / c.ramMB) * 100) : 0
  const storagePercent = c.storageGB > 0 ? Math.min(100, (c.storageUsedGB / c.storageGB) * 100) : 0

  const cpuHistory = data.history.map((h) => h.cpuPercent || 0)
  const ramHistory = data.history.map((h) => h.ramUsedMB || 0)
  const storageHistory = data.history.map((h) => h.storageUsedGB || 0)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Activity className={`size-5 ${primaryText}`} />
              Resources
            </CardTitle>
            <CardDescription className="mt-1">
              Live CPU, RAM, storage and network usage (refreshed every 5s).
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => fetchResources(false)}
          >
            <RefreshCw className="size-3.5 mr-1" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Top stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-lg border p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Cpu className="size-3.5" />
                CPU
              </span>
              <span className={`text-sm font-mono font-medium ${usageTextColor(cpuPercent)}`}>
                {cpuPercent.toFixed(1)}%
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full transition-all ${usageColor(cpuPercent)}`}
                style={{ width: `${cpuPercent}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {c.cpuCores ? `${c.cpuCores} core${c.cpuCores !== 1 ? 's' : ''} allocated` : 'Unlimited'}
            </p>
          </div>

          <div className="rounded-lg border p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                <MemoryStick className="size-3.5" />
                Memory
              </span>
              <span className={`text-sm font-mono font-medium ${usageTextColor(ramPercent)}`}>
                {c.ramUsedMB} / {c.ramMB} MB
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full transition-all ${usageColor(ramPercent)}`}
                style={{ width: `${ramPercent}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {ramPercent.toFixed(1)}% used
            </p>
          </div>

          <div className="rounded-lg border p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                <HardDrive className="size-3.5" />
                Storage
              </span>
              <span className={`text-sm font-mono font-medium ${usageTextColor(storagePercent)}`}>
                {c.storageUsedGB.toFixed(2)} / {c.storageGB} GB
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full transition-all ${usageColor(storagePercent)}`}
                style={{ width: `${storagePercent}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {storagePercent.toFixed(1)}% used
            </p>
          </div>
        </div>

        {/* History charts */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-lg border p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                <TrendingUp className="size-3.5" />
                CPU · 24h
              </span>
              <span className="text-xs font-mono">
                {cpuHistory.length > 0 ? `${Math.max(...cpuHistory).toFixed(1)}% peak` : '—'}
              </span>
            </div>
            <Sparkline data={cpuHistory} color="#10b981" max={100} />
          </div>
          <div className="rounded-lg border p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                <TrendingUp className="size-3.5" />
                RAM · 24h
              </span>
              <span className="text-xs font-mono">
                {ramHistory.length > 0 ? `${Math.max(...ramHistory).toFixed(0)} MB peak` : '—'}
              </span>
            </div>
            <Sparkline data={ramHistory} color="#f59e0b" max={c.ramMB || undefined} />
          </div>
          <div className="rounded-lg border p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                <TrendingUp className="size-3.5" />
                Storage · 24h
              </span>
              <span className="text-xs font-mono">
                {storageHistory.length > 0 ? `${Math.max(...storageHistory).toFixed(2)} GB peak` : '—'}
              </span>
            </div>
            <Sparkline data={storageHistory} color="#8b5cf6" max={c.storageGB || undefined} />
          </div>
        </div>

        {/* Network + uptime + limits */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded-lg border p-3 space-y-1">
            <span className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Network className="size-3.5" />
              Network RX
            </span>
            <p className="text-sm font-mono font-medium">{formatBytes(c.networkRxBytes)}</p>
          </div>
          <div className="rounded-lg border p-3 space-y-1">
            <span className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Network className="size-3.5" />
              Network TX
            </span>
            <p className="text-sm font-mono font-medium">{formatBytes(c.networkTxBytes)}</p>
          </div>
          <div className="rounded-lg border p-3 space-y-1">
            <span className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Clock className="size-3.5" />
              Uptime
            </span>
            <p className="text-sm font-mono font-medium">{formatUptime(c.uptimeSeconds)}</p>
          </div>
          <div className="rounded-lg border p-3 space-y-1">
            <span className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Server className="size-3.5" />
              Status
            </span>
            <Badge variant="outline" className={c.status === 'running' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/50' : 'bg-muted'}>
              {c.status}
            </Badge>
          </div>
        </div>

        <Separator />

        {/* Plan limits */}
        <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/40 dark:bg-emerald-950/10 p-4">
          <div className="flex items-start gap-2">
            <Server className={`size-4 mt-0.5 shrink-0 ${primaryText}`} />
            <div>
              <p className="text-sm font-medium">Resource limits</p>
              <p className="text-xs text-muted-foreground mt-1">
                Allocated CPU: <span className="font-mono">{c.cpuCores || '∞'} cores</span> ·
                RAM: <span className="font-mono">{c.ramMB || '∞'} MB</span> ·
                Storage: <span className="font-mono">{c.storageGB || '∞'} GB</span>
              </p>
              <p className="text-xs text-muted-foreground mt-1.5">
                Limits come from your hosting plan. Upgrade to increase.
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ═══════════════════════════════════════════════════════════════════════
// 6. DomainsTab
// ═══════════════════════════════════════════════════════════════════════

export function DomainsTab({
  projectId,
  onProjectChanged,
}: {
  projectId: string
  onProjectChanged?: () => void
}) {
  const [domains, setDomains] = useState<WebsiteDomain[]>([])
  /** Where an A record should point + the TXT prefix, from the API. */
  const [connectTarget, setConnectTarget] = useState<{
    nameservers: string[]
    advanced: { cname?: string; ips: string[]; txtPrefix: string }
  } | null>(null)
  /** Advanced (keep-your-own-DNS) records are hidden unless asked for. */
  const [showAdvancedDns, setShowAdvancedDns] = useState(false)
  /** DNS records still required, returned by a failed verification attempt. */
  const [verifyHint, setVerifyHint] = useState<{
    message: string
    txt: { type: string; name: string; value: string } | null
    a: { type: string; name: string; value: string[] } | null
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [createDomain, setCreateDomain] = useState('')
  const [createSsl, setCreateSsl] = useState(true)
  const [createPrimary, setCreatePrimary] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleteDomain, setDeleteDomain] = useState<WebsiteDomain | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [verifyDomain, setVerifyDomain] = useState<WebsiteDomain | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [patching, setPatching] = useState<Record<string, boolean>>({})

  const fetchDomains = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/domains`, {
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        setDomains(data.domains || [])
        setConnectTarget(data.connectTarget || null)
      } else {
        toast.error(data.error || 'Failed to load domains')
      }
    } catch {
      toast.error('Network error loading domains')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    fetchDomains()
  }, [fetchDomains])

  /**
   * Poll while a domain is still connecting.
   *
   * The background sweep advances these stages on its own every couple of
   * minutes, so the page must refresh itself — otherwise the customer stares
   * at "Waiting for DNS" long after it has actually gone live. Polling stops
   * once nothing is in flight, so a settled page makes no requests.
   */
  const connecting = domains.some(
    (d) => d.connection && d.connection.stage !== 'live' && d.connection.stage !== 'blocked'
  )
  useEffect(() => {
    if (!connecting) return
    const t = setInterval(fetchDomains, 20_000)
    return () => clearInterval(t)
  }, [connecting, fetchDomains])

  const patchDomain = async (
    d: WebsiteDomain,
    body: { isPrimary?: boolean; sslEnabled?: boolean; verified?: boolean },
    successMsg: string
  ) => {
    setPatching((p) => ({ ...p, [d.id]: true }))
    try {
      const res = await fetch(`/api/hosting/${projectId}/domains/${d.id}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(successMsg)
        fetchDomains()
        onProjectChanged?.()
      } else {
        toast.error(data.error || 'Update failed')
      }
    } catch {
      toast.error('Network error updating domain')
    } finally {
      setPatching((p) => ({ ...p, [d.id]: false }))
    }
  }

  const handleCreate = async () => {
    const name = createDomain.trim().toLowerCase()
    if (!name) {
      toast.error('Domain is required')
      return
    }
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(name)) {
      toast.error('Enter a valid domain like www.example.com')
      return
    }
    setCreating(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/domains`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          domain: name,
          sslEnabled: createSsl,
          isPrimary: createPrimary,
        }),
      })
      const data = await res.json()
      if (res.ok && data.domain) {
        toast.success('Domain added')
        setCreateOpen(false)
        setCreateDomain('')
        setCreateSsl(true)
        setCreatePrimary(false)
        fetchDomains()
        onProjectChanged?.()
      } else {
        toast.error(data.error || 'Failed to add domain')
      }
    } catch {
      toast.error('Network error adding domain')
    } finally {
      setCreating(false)
    }
  }

  /**
   * Ask the server to prove domain ownership via DNS.
   *
   * This previously PATCHed `{ verified: true }` — the client simply asserting
   * it was verified, which the API accepted. Real verification now happens
   * server-side against DNS; a failure returns the records still to be added.
   */
  const handleVerify = async () => {
    if (!verifyDomain) return
    setVerifying(true)
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/domains/${verifyDomain.id}/verify`,
        { method: 'POST', headers: getAuthHeaders() }
      )
      const data = await res.json()
      if (res.ok && data.verified) {
        toast.success(data.message || 'Domain verified — now live.')
        setVerifyDomain(null)
        setVerifyHint(null)
        fetchDomains()
        onProjectChanged?.()
      } else if (res.ok) {
        // Not an error: DNS just hasn't propagated yet. Keep the dialog open
        // and show exactly what still needs adding.
        toast.message(data.message || 'Not verified yet')
        setVerifyHint({
          message: data.message || '',
          txt: data.txtRecord || null,
          a: data.aRecord || null,
        })
      } else {
        toast.error(data.error || 'Verification failed')
      }
    } catch {
      toast.error('Network error verifying domain')
    } finally {
      setVerifying(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteDomain) return
    setDeleting(true)
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/domains/${deleteDomain.id}`,
        { method: 'DELETE', headers: getAuthHeaders() }
      )
      const data = await res.json()
      if (res.ok) {
        toast.success('Domain removed')
        setDeleteDomain(null)
        fetchDomains()
        onProjectChanged?.()
      } else {
        toast.error(data.error || 'Failed to remove domain')
      }
    } catch {
      toast.error('Network error removing domain')
    } finally {
      setDeleting(false)
    }
  }

  const sslBadge = (d: WebsiteDomain) => {
    if (!d.sslEnabled) {
      return (
        <Badge variant="outline" className="bg-gray-50 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400 border-gray-200 dark:border-gray-700 text-xs">
          <Shield className="size-3 mr-1" />
          SSL off
        </Badge>
      )
    }
    const status = (d.sslStatus || 'none').toLowerCase()
    if (status === 'issued') {
      return (
        <Badge variant="outline" className="bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/50 text-xs">
          <ShieldCheck className="size-3 mr-1" />
          Issued
        </Badge>
      )
    }
    if (status === 'pending' || status === 'renewing') {
      return (
        <Badge variant="outline" className="bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 border-amber-200 dark:border-amber-900/50 text-xs">
          <Loader2 className="size-3 mr-1 animate-spin" />
          Configuring SSL…
        </Badge>
      )
    }
    if (status === 'failed') {
      return (
        <Badge variant="outline" className="bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 border-red-200 dark:border-red-900/50 text-xs">
          <ShieldAlert className="size-3 mr-1" />
          Failed
        </Badge>
      )
    }
    return (
      <Badge variant="outline" className="bg-gray-50 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400 border-gray-200 dark:border-gray-700 text-xs">
        <Shield className="size-3 mr-1" />
        None
      </Badge>
    )
  }

  const brandDomain = process.env.NEXT_PUBLIC_BRAND_DOMAIN || 'apsamo.com'
  const subdomainHint = projectId ? `${projectId.slice(-6)}.${brandDomain}` : `your-subdomain.${brandDomain}`

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Globe className={`size-5 ${primaryText}`} />
              Custom Domains
            </CardTitle>
            <CardDescription className="mt-1">
              Point your own domains at this project with automatic SSL.
            </CardDescription>
          </div>
          <Button size="sm" className={primaryBtn} onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5 mr-1" />
            Add Domain
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : domains.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground">
            <Globe className="size-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">No custom domains</p>
            <p className="text-xs mt-1">
              Your website is accessible at <span className="font-mono">{subdomainHint}</span>.
              Add a custom domain to use your own.
            </p>
            <Button className={`${primaryBtn} mt-4`} size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-3.5 mr-1" />
              Add Your First Domain
            </Button>
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>SSL</TableHead>
                  <TableHead>Verified</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {domains.map((d) => (
                  <TableRow
                    key={d.id}
                    className="hover:bg-emerald-50/40 dark:hover:bg-emerald-950/10 transition-colors"
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Globe className="size-4 text-muted-foreground shrink-0" />
                        <span className="font-mono text-sm">{d.domain}</span>
                      </div>
                      {/* Live connection pipeline. Only meaningful for a
                          custom domain that is still being connected. */}
                      {d.connection && d.connection.stage !== 'live' && (
                        <ConnectionPipeline d={d} />
                      )}
                    </TableCell>
                    <TableCell>
                      {d.isPrimary ? (
                        <Badge variant="outline" className="bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/50 text-xs">
                          Primary
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-gray-50 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400 border-gray-200 dark:border-gray-700 text-xs">
                          Addon
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{sslBadge(d)}</TableCell>
                    <TableCell>
                      {d.verified ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                              <CheckCircle2 className="size-4" />
                              Yes
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            {d.verificationMethod ? `via ${d.verificationMethod}` : 'Verified'}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                          <XCircle className="size-4" />
                          Pending
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {!d.isPrimary && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs"
                                disabled={!!patching[d.id]}
                                onClick={() =>
                                  patchDomain(d, { isPrimary: true }, 'Set as primary')
                                }
                              >
                                {patching[d.id] ? (
                                  <Loader2 className="size-3 mr-1 animate-spin" />
                                ) : (
                                  <StarIcon />
                                )}
                                Set Primary
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Promote to primary</TooltipContent>
                          </Tooltip>
                        )}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs"
                              disabled={!!patching[d.id]}
                              onClick={() =>
                                patchDomain(
                                  d,
                                  { sslEnabled: !d.sslEnabled },
                                  d.sslEnabled ? 'SSL disabled' : 'SSL enabled'
                                )
                              }
                            >
                              {patching[d.id] ? (
                                <Loader2 className="size-3 mr-1 animate-spin" />
                              ) : (
                                <Shield className="size-3 mr-1" />
                              )}
                              {d.sslEnabled ? 'SSL Off' : 'SSL On'}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Toggle SSL</TooltipContent>
                        </Tooltip>
                        {!d.verified && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setVerifyDomain(d)}
                          >
                            <CheckCircle2 className="size-3 mr-1" />
                            Verify
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20"
                          onClick={() => setDeleteDomain(d)}
                        >
                          <Trash2 className="size-3 mr-1" />
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {/* Add domain dialog */}
      <Dialog open={createOpen} onOpenChange={(v) => !v && setCreateOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Globe className={`size-5 ${primaryText}`} />
              Add Custom Domain
            </DialogTitle>
            <DialogDescription>
              Point a domain you own at this project. SSL is provisioned
              automatically via Let&apos;s Encrypt.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="domain-input">Domain</Label>
              <Input
                id="domain-input"
                placeholder="www.example.com"
                value={createDomain}
                onChange={(e) => setCreateDomain(e.target.value)}
                className="font-mono text-sm"
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                First point an A record at your server IP, or a CNAME at
                <span className="font-mono"> {subdomainHint}</span>.
              </p>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label className="text-sm">Enable SSL</Label>
                <p className="text-xs text-muted-foreground">Free Let&apos;s Encrypt cert.</p>
              </div>
              <Switch checked={createSsl} onCheckedChange={setCreateSsl} />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label className="text-sm">Set as primary</Label>
                <p className="text-xs text-muted-foreground">
                  Demotes the current primary automatically.
                </p>
              </div>
              <Switch checked={createPrimary} onCheckedChange={setCreatePrimary} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button className={primaryBtn} onClick={handleCreate} disabled={creating}>
              {creating ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Adding...
                </>
              ) : (
                <>
                  <Plus className="size-4 mr-2" />
                  Add
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Connect dialog — nameserver-led */}
      <Dialog open={!!verifyDomain} onOpenChange={(v) => !v && setVerifyDomain(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Globe className={`size-5 ${primaryText}`} />
              Connect Domain
            </DialogTitle>
            <DialogDescription>
              <span className="font-mono">{verifyDomain?.domain}</span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2 text-sm">
            {/* Live pipeline so the customer can see where they are. */}
            {verifyDomain && <ConnectionPipeline d={verifyDomain} />}

            <p className="text-muted-foreground">
              Sign in to your domain registrar and set your nameservers to the
              two below. That is the only step — we handle DNS, SSL and going
              live automatically once the change is detected.
            </p>

            {/* Delegation makes us authoritative for the WHOLE domain, not
                just the website. We copy across what we can find, but DNS has
                no way to list a zone, so anything unusual has to be re-added.
                Saying so up front is cheaper than a customer discovering it
                when their mail starts failing DMARC a week later. */}
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5">
              <p className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  <strong>Already using this domain for email or other
                  services?</strong> Changing nameservers moves all DNS for the
                  domain to us. We copy across the records we can detect
                  (mail, SPF, DKIM and common subdomains), but anything unusual
                  should be re-added here afterwards. If you&apos;d rather not
                  risk it, use the advanced option below and keep your current
                  DNS provider.
                </span>
              </p>
            </div>

            <div className="rounded-md border p-3 space-y-1.5">
              <p className="text-xs font-medium">Nameservers</p>
              <div className="font-mono text-xs space-y-1">
                {(connectTarget?.nameservers ?? ['ns1.apsamo.com', 'ns2.apsamo.com']).map(
                  (ns) => (
                    <div key={ns} className="rounded bg-muted/50 px-2 py-1">
                      {ns}
                    </div>
                  )
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Replace any existing nameservers. Registrar changes usually
                apply within an hour, occasionally up to 24.
              </p>
            </div>

            {/* Advanced: keep your own DNS host. Hidden by default so the
                common path stays a two-field change. */}
            <button
              type="button"
              onClick={() => setShowAdvancedDns((v) => !v)}
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {showAdvancedDns ? 'Hide' : 'Advanced:'} keep my current DNS host
            </button>

            {showAdvancedDns && (
              /* For customers who must keep their existing DNS provider —
                 most commonly Cloudflare, where delegating to us would drop
                 their CDN and WAF. Deliberately shows ONLY the A record: the
                 record itself proves control, so the TXT challenge that used
                 to be printed here was redundant and read as developer
                 clutter in a customer-facing screen. */
              <div className="rounded-md border border-dashed p-3 space-y-2">
                <p className="text-[11px] text-muted-foreground">
                  Staying with Cloudflare or another DNS provider? Create this
                  record there instead — everything else still happens
                  automatically.
                </p>

                {/* CNAME is the preferred target: it points at a hostname we
                    control, so we can move a site between servers without every
                    customer having to edit their DNS. */}
                <div className="rounded bg-muted/50 px-2 py-1.5 font-mono text-[11px] break-all">
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>
                      <span className="text-muted-foreground">Type </span>CNAME
                    </span>
                    <span>
                      <span className="text-muted-foreground">Name </span>www
                    </span>
                    <span>
                      <span className="text-muted-foreground">Value </span>
                      {connectTarget?.advanced?.cname ?? 'connect.apsamo.com'}
                    </span>
                  </div>
                </div>

                {/* A record for the apex only — RFC 1034 forbids a CNAME at the
                    root of a zone, which is why every platform still hands out
                    an address here. */}
                <div className="rounded bg-muted/50 px-2 py-1.5 font-mono text-[11px] break-all">
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>
                      <span className="text-muted-foreground">Type </span>A
                    </span>
                    <span>
                      <span className="text-muted-foreground">Name </span>@
                    </span>
                    <span>
                      <span className="text-muted-foreground">Value </span>
                      {connectTarget?.advanced?.ips?.length
                        ? connectTarget.advanced.ips.join(', ')
                        : '—'}
                    </span>
                  </div>
                </div>

                <p className="text-[11px] text-muted-foreground">
                  The root of a domain can&apos;t use a CNAME, so it needs the
                  address above. If your DNS provider supports ALIAS or ANAME
                  records (Cloudflare and Route&nbsp;53 do), you can point the
                  root at{' '}
                  <span className="font-mono">
                    {connectTarget?.advanced?.cname ?? 'connect.apsamo.com'}
                  </span>{' '}
                  instead.
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Your MX and other records stay under your control, so email is
                  unaffected.
                </p>
              </div>
            )}

            {verifyHint?.message && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
                {verifyHint.message}
              </p>
            )}

            <p className="text-xs text-muted-foreground">
              We re-check automatically every couple of minutes — you can close
              this and come back.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVerifyDomain(null)} disabled={verifying}>
              Cancel
            </Button>
            <Button className={primaryBtn} onClick={handleVerify} disabled={verifying}>
              {verifying ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Checking…
                </>
              ) : (
                <>
                  <CheckCircle2 className="size-4 mr-2" />
                  Verify Now
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteDomain} onOpenChange={(v) => !v && setDeleteDomain(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-red-500" />
              Remove Domain
            </AlertDialogTitle>
            <AlertDialogDescription>
              Remove <span className="font-mono">{deleteDomain?.domain}</span> from this project?
              {deleteDomain?.isPrimary && (
                <>
                  {' '}
                  This is your primary domain — set another domain as primary
                  first.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting || deleteDomain?.isPrimary}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deleting ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Removing...
                </>
              ) : (
                <>
                  <Trash2 className="size-4 mr-2" />
                  Remove
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
// 7. EmailTab
// ═══════════════════════════════════════════════════════════════════════

function generateRandomPassword(): string {
  // 24-char password with letters, digits and a fixed set of specials.
  // Avoids ambiguous characters (O/0/I/1/l) for readability.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*-_=+'
  const bytes = new Uint32Array(24)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    // Fallback for very old browsers
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 0xffffffff)
  }
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += alphabet[bytes[i] % alphabet.length]
  }
  return out
}

function formatQuota(bytes: number): string {
  if (!bytes || bytes <= 0) return '—'
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(0)} MB`
}

export function EmailTab({ projectId }: { projectId: string }) {
  const [mailboxes, setMailboxes] = useState<EmailMailbox[]>([])
  const [projectDomains, setProjectDomains] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [createLocalPart, setCreateLocalPart] = useState('')
  const [createDomain, setCreateDomain] = useState('')
  const [createPassword, setCreatePassword] = useState('')
  const [createShowPw, setCreateShowPw] = useState(false)
  const [createQuotaGb, setCreateQuotaGb] = useState('1')
  const [creating, setCreating] = useState(false)
  const [createdMailbox, setCreatedMailbox] = useState<{
    address: string
    password: string
  } | null>(null)

  // Change-password dialog state
  const [pwMailbox, setPwMailbox] = useState<EmailMailbox | null>(null)
  const [pwNew, setPwNew] = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwShow, setPwShow] = useState(false)
  const [pwSaving, setPwSaving] = useState(false)

  // Delete state
  const [deleteMailbox, setDeleteMailbox] = useState<EmailMailbox | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Toggle active state
  const [toggling, setToggling] = useState<Record<string, boolean>>({})

  // DNS records state
  const [dnsOpen, setDnsOpen] = useState(false)
  const [dnsDomain, setDnsDomain] = useState('')
  const [dnsRecords, setDnsRecords] = useState<EmailDnsRecordsResponse | null>(null)
  const [dnsLoading, setDnsLoading] = useState(false)

  const fetchMailboxes = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/email`, {
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        setMailboxes(data.mailboxes || [])
        const domains: string[] = data.domains || []
        setProjectDomains(domains)
        // Pre-select the first domain for the create + DNS dropdowns.
        setCreateDomain((prev) => prev || domains[0] || '')
        setDnsDomain((prev) => prev || domains[0] || '')
      } else {
        toast.error(data.error || 'Failed to load mailboxes')
      }
    } catch {
      toast.error('Network error loading mailboxes')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    fetchMailboxes()
  }, [fetchMailboxes])

  const fetchDnsRecords = useCallback(async (domain: string) => {
    if (!domain) {
      setDnsRecords(null)
      return
    }
    setDnsLoading(true)
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/email/dns-records?domain=${encodeURIComponent(domain)}`,
        { headers: getAuthHeaders() }
      )
      const data = await res.json()
      if (res.ok) {
        setDnsRecords(data)
      } else {
        toast.error(data.error || 'Failed to load DNS records')
        setDnsRecords(null)
      }
    } catch {
      toast.error('Network error loading DNS records')
      setDnsRecords(null)
    } finally {
      setDnsLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (dnsOpen && dnsDomain && !dnsRecords) {
      fetchDnsRecords(dnsDomain)
    }
  }, [dnsOpen, dnsDomain, dnsRecords, fetchDnsRecords])

  const handleCreate = async () => {
    const localPart = createLocalPart.trim().toLowerCase()
    const domainName = createDomain.trim().toLowerCase()
    if (!localPart) {
      toast.error('Enter a local part (e.g. "info")')
      return
    }
    if (!domainName) {
      toast.error('Select a domain')
      return
    }
    if (createPassword.length < 8) {
      toast.error('Password must be at least 8 characters')
      return
    }
    const gb = parseFloat(createQuotaGb) || 1
    if (gb <= 0 || gb > 50) {
      toast.error('Quota must be between 0.1 and 50 GB')
      return
    }
    setCreating(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/email`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          localPart,
          domainName,
          password: createPassword,
          quota: Math.round(gb * 1024 * 1024 * 1024),
        }),
      })
      const data = await res.json()
      if (res.ok && data.mailbox) {
        setCreatedMailbox({
          address: data.mailbox.address,
          password: data.mailbox.plaintextPassword || createPassword,
        })
        setCreateOpen(false)
        setCreateLocalPart('')
        setCreatePassword('')
        setCreateQuotaGb('1')
        setCreateShowPw(false)
        fetchMailboxes()
        toast.success('Mailbox created')
      } else {
        toast.error(data.error || 'Failed to create mailbox')
      }
    } catch {
      toast.error('Network error creating mailbox')
    } finally {
      setCreating(false)
    }
  }

  const handleToggleActive = async (mb: EmailMailbox) => {
    setToggling((p) => ({ ...p, [mb.id]: true }))
    try {
      const res = await fetch(`/api/hosting/${projectId}/email/${mb.id}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({ active: !mb.active }),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(mb.active ? 'Mailbox disabled' : 'Mailbox enabled')
        fetchMailboxes()
      } else {
        toast.error(data.error || 'Failed to update mailbox')
      }
    } catch {
      toast.error('Network error updating mailbox')
    } finally {
      setToggling((p) => ({ ...p, [mb.id]: false }))
    }
  }

  const handleChangePassword = async () => {
    if (!pwMailbox) return
    if (pwNew.length < 8) {
      toast.error('Password must be at least 8 characters')
      return
    }
    if (pwNew !== pwConfirm) {
      toast.error('Passwords do not match')
      return
    }
    setPwSaving(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/email/${pwMailbox.id}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({ password: pwNew }),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success('Password updated')
        setPwMailbox(null)
        setPwNew('')
        setPwConfirm('')
        setPwShow(false)
        fetchMailboxes()
      } else {
        toast.error(data.error || 'Failed to update password')
      }
    } catch {
      toast.error('Network error updating password')
    } finally {
      setPwSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteMailbox) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/email/${deleteMailbox.id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success('Mailbox deleted')
        setDeleteMailbox(null)
        fetchMailboxes()
      } else {
        toast.error(data.error || 'Failed to delete mailbox')
      }
    } catch {
      toast.error('Network error deleting mailbox')
    } finally {
      setDeleting(false)
    }
  }

  const dnsRows: Array<{ label: string; record: EmailDnsRecord }> = dnsRecords
    ? [
        { label: 'MX', record: dnsRecords.records.mx },
        { label: 'SPF (TXT)', record: dnsRecords.records.spf },
        { label: 'DMARC (TXT)', record: dnsRecords.records.dmarc },
        { label: 'DKIM (TXT)', record: dnsRecords.records.dkim },
      ]
    : []

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Mail className={`size-5 ${primaryText}`} />
              Email Accounts
            </CardTitle>
            <CardDescription className="mt-1">
              Create mailboxes at your domain. Passwords are encrypted at rest;
              DNS records are generated for easy setup.
            </CardDescription>
          </div>
          <Button
            size="sm"
            className={primaryBtn}
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-3.5 mr-1" />
            Create Mailbox
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : mailboxes.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground">
            <Mail className="size-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">No email accounts</p>
            <p className="text-xs mt-1 max-w-md mx-auto">
              Create your first mailbox to start sending and receiving mail at
              your domain.
            </p>
            <Button className={`${primaryBtn} mt-4`} size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-3.5 mr-1" />
              Create First Mailbox
            </Button>
          </div>
        ) : (
          <>
            <div className="max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Address</TableHead>
                    <TableHead>Quota</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>DKIM</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mailboxes.map((mb) => (
                    <TableRow
                      key={mb.id}
                      className="hover:bg-emerald-50/40 dark:hover:bg-emerald-950/10 transition-colors"
                    >
                      <TableCell>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-sm font-medium">{mb.address}</span>
                          {mb.isDefault && (
                            <Badge
                              variant="outline"
                              className="bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/50 text-[10px] h-5"
                            >
                              Default
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {formatQuota(mb.quota)}
                      </TableCell>
                      <TableCell>
                        {mb.active ? (
                          <Badge
                            variant="outline"
                            className="bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/50 text-xs"
                          >
                            <span className="size-1.5 rounded-full bg-emerald-500 mr-1.5" />
                            Active
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="bg-gray-50 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400 border-gray-200 dark:border-gray-700 text-xs"
                          >
                            <span className="size-1.5 rounded-full bg-gray-400 mr-1.5" />
                            Disabled
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {mb.dkimEnabled ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                                <ShieldCheck className="size-4" />
                                On
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>DKIM signing enabled</TooltipContent>
                          </Tooltip>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                                <ShieldAlert className="size-4" />
                                Off
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>DKIM not configured</TooltipContent>
                          </Tooltip>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {timeAgo(mb.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1 flex-wrap">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => {
                              setPwMailbox(mb)
                              setPwNew('')
                              setPwConfirm('')
                              setPwShow(false)
                            }}
                          >
                            <KeyRound className="size-3 mr-1" />
                            Password
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={!!toggling[mb.id]}
                            onClick={() => handleToggleActive(mb)}
                          >
                            {toggling[mb.id] ? (
                              <Loader2 className="size-3 mr-1 animate-spin" />
                            ) : mb.active ? (
                              <XCircle className="size-3 mr-1" />
                            ) : (
                              <CheckCircle2 className="size-3 mr-1" />
                            )}
                            {mb.active ? 'Disable' : 'Enable'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20"
                            onClick={() => setDeleteMailbox(mb)}
                          >
                            <Trash2 className="size-3 mr-1" />
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* DNS records helper */}
            <Collapsible open={dnsOpen} onOpenChange={setDnsOpen} className="mt-4">
              <div className="flex items-center justify-between gap-2 flex-wrap rounded-lg border bg-muted/30 px-3 py-2">
                <div className="flex items-center gap-2 text-sm">
                  <Globe className="size-4 text-muted-foreground" />
                  <span className="font-medium">DNS records for email delivery</span>
                  <span className="text-xs text-muted-foreground">
                    MX / SPF / DKIM / DMARC
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Select
                    value={dnsDomain}
                    onValueChange={(v) => {
                      setDnsDomain(v)
                      setDnsRecords(null)
                    }}
                  >
                    <SelectTrigger className="h-8 w-[200px] text-xs">
                      <SelectValue placeholder="Select domain" />
                    </SelectTrigger>
                    <SelectContent>
                      {projectDomains.length === 0 ? (
                        <SelectItem value="_none" disabled>
                          No domains — add one first
                        </SelectItem>
                      ) : (
                        projectDomains.map((d) => (
                          <SelectItem key={d} value={d}>
                            {d}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8">
                      {dnsOpen ? (
                        <ChevronUp className="size-4" />
                      ) : (
                        <ChevronDown className="size-4" />
                      )}
                    </Button>
                  </CollapsibleTrigger>
                </div>
              </div>
              <CollapsibleContent>
                <div className="mt-3 rounded-lg border p-3 space-y-2">
                  {dnsLoading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-10 w-full" />
                    </div>
                  ) : !dnsDomain || dnsDomain === '_none' ? (
                    <p className="text-xs text-muted-foreground py-2">
                      Add a custom domain to your project to see its DNS records.
                    </p>
                  ) : dnsRecords ? (
                    <>
                      <p className="text-xs text-muted-foreground">
                        Add these records at your DNS provider to enable mail
                        delivery for <span className="font-mono">{dnsRecords.domain}</span>.
                        Mail server:{' '}
                        <span className="font-mono">{dnsRecords.mailServer}</span>
                      </p>
                      {dnsRows.map((row) => (
                        <div
                          key={row.label}
                          className="grid grid-cols-1 sm:grid-cols-[100px_120px_1fr_auto] gap-2 sm:items-center rounded-md border bg-background px-3 py-2 text-xs"
                        >
                          <span className="font-medium text-muted-foreground">
                            {row.label}
                          </span>
                          <span className="font-mono">{row.record.name}</span>
                          <code className="font-mono text-[11px] break-all text-foreground">
                            {row.record.priority
                              ? `${row.record.priority} ${row.record.value}`
                              : row.record.value}
                          </code>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            onClick={() =>
                              copyToClipboard(
                                row.record.priority
                                  ? `${row.record.priority} ${row.record.value}`
                                  : row.record.value,
                                `${row.label} record copied`
                              )
                            }
                          >
                            <Copy className="size-3.5" />
                          </Button>
                        </div>
                      ))}
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground py-2">
                      No DNS records available.
                    </p>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </>
        )}
      </CardContent>

      {/* Create Mailbox Dialog */}
      <Dialog open={createOpen} onOpenChange={(v) => !v && setCreateOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className={`size-5 ${primaryText}`} />
              Create Mailbox
            </DialogTitle>
            <DialogDescription>
              Provision a new email account at your domain. The password is
              shown once after creation — save it somewhere safe.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="email-local">Local part</Label>
              <div className="flex items-center gap-2">
                <AtSign className="size-4 text-muted-foreground shrink-0" />
                <Input
                  id="email-local"
                  placeholder="info"
                  value={createLocalPart}
                  onChange={(e) =>
                    setCreateLocalPart(e.target.value.replace(/[^a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]/g, ''))
                  }
                  className="font-mono text-sm flex-1"
                  autoFocus
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Domain</Label>
              <Select value={createDomain} onValueChange={setCreateDomain}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select domain" />
                </SelectTrigger>
                <SelectContent>
                  {projectDomains.length === 0 ? (
                    <SelectItem value="_none" disabled>
                      No domains — add a custom domain first
                    </SelectItem>
                  ) : (
                    projectDomains.map((d) => (
                      <SelectItem key={d} value={d}>
                        {d}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {projectDomains.length === 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Add a custom domain in the Custom Domains section above to
                  create mailboxes.
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="email-password">Password</Label>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => {
                    const pw = generateRandomPassword()
                    setCreatePassword(pw)
                    setCreateShowPw(true)
                  }}
                >
                  Generate
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="email-password"
                  type={createShowPw ? 'text' : 'password'}
                  placeholder="At least 8 characters"
                  value={createPassword}
                  onChange={(e) => setCreatePassword(e.target.value)}
                  className="font-mono text-sm flex-1"
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-9 shrink-0"
                      onClick={() => setCreateShowPw((v) => !v)}
                    >
                      {createShowPw ? (
                        <EyeOff className="size-4" />
                      ) : (
                        <Eye className="size-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {createShowPw ? 'Hide password' : 'Show password'}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="email-quota">Quota (GB)</Label>
              <Input
                id="email-quota"
                type="number"
                min="0.1"
                max="50"
                step="0.1"
                value={createQuotaGb}
                onChange={(e) => setCreateQuotaGb(e.target.value)}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Storage limit for this mailbox. Default: 1 GB.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button
              className={primaryBtn}
              onClick={handleCreate}
              disabled={creating || !createDomain || createDomain === '_none'}
            >
              {creating ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Plus className="size-4 mr-2" />
                  Create
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Show credentials once after creation */}
      <Dialog open={!!createdMailbox} onOpenChange={(v) => !v && setCreatedMailbox(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="size-5 text-emerald-600" />
              Mailbox Created
            </DialogTitle>
            <DialogDescription>
              Save these credentials now — the password will be masked
              afterwards and cannot be recovered.
            </DialogDescription>
          </DialogHeader>
          {createdMailbox && (
            <div className="grid gap-3 py-2 text-sm">
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Email address</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() =>
                      copyToClipboard(createdMailbox.address, 'Address copied')
                    }
                  >
                    <Copy className="size-3 mr-1" />
                    Copy
                  </Button>
                </div>
                <code className="block w-full rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">
                  {createdMailbox.address}
                </code>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Password</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() =>
                      copyToClipboard(createdMailbox.password, 'Password copied')
                    }
                  >
                    <Copy className="size-3 mr-1" />
                    Copy
                  </Button>
                </div>
                <code className="block w-full rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">
                  {createdMailbox.password}
                </code>
              </div>
              <div className="rounded-md border border-amber-200 dark:border-amber-900/50 bg-amber-50/50 dark:bg-amber-950/10 p-3 text-xs text-amber-700 dark:text-amber-400 flex items-start gap-2">
                <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                <span>
                  These credentials are shown only once. Use a password manager
                  or copy them somewhere safe before closing this dialog.
                </span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button className={primaryBtn} onClick={() => setCreatedMailbox(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change Password Dialog */}
      <Dialog open={!!pwMailbox} onOpenChange={(v) => !v && setPwMailbox(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className={`size-5 ${primaryText}`} />
              Change Password
            </DialogTitle>
            <DialogDescription>
              Set a new password for{' '}
              <span className="font-mono">{pwMailbox?.address}</span>. The new
              password will be shown once after saving.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="pw-new">New password</Label>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => {
                    const pw = generateRandomPassword()
                    setPwNew(pw)
                    setPwConfirm(pw)
                    setPwShow(true)
                  }}
                >
                  Generate
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="pw-new"
                  type={pwShow ? 'text' : 'password'}
                  placeholder="At least 8 characters"
                  value={pwNew}
                  onChange={(e) => setPwNew(e.target.value)}
                  className="font-mono text-sm flex-1"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9 shrink-0"
                  onClick={() => setPwShow((v) => !v)}
                >
                  {pwShow ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pw-confirm">Confirm password</Label>
              <Input
                id="pw-confirm"
                type={pwShow ? 'text' : 'password'}
                placeholder="Re-enter the new password"
                value={pwConfirm}
                onChange={(e) => setPwConfirm(e.target.value)}
                className="font-mono text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPwMailbox(null)} disabled={pwSaving}>
              Cancel
            </Button>
            <Button
              className={primaryBtn}
              onClick={handleChangePassword}
              disabled={pwSaving || pwNew.length < 8 || pwNew !== pwConfirm}
            >
              {pwSaving ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <KeyRound className="size-4 mr-2" />
                  Update Password
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteMailbox}
        onOpenChange={(v) => !v && setDeleteMailbox(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-red-500" />
              Delete Mailbox
            </AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete <span className="font-mono">{deleteMailbox?.address}</span>?
              All messages stored in this mailbox will be lost. This action
              cannot be undone.
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
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="size-4 mr-2" />
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

function StarIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3 mr-1"
      aria-hidden="true"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}
