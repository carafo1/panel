'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { siteHostname, NO_DOMAIN_LABEL } from '@/lib/site-address'
import { toast } from 'sonner'
import {
  HardDriveDownload,
  Plus,
  Rocket,
  StopCircle,
  Trash2,
  Shield,
  RefreshCw,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
  ChevronRight,
  FileCode,
  Triangle,
  Hexagon,
  Layout,
  Search,
  Filter,
  ArrowUpDown,
  Square,
  CheckSquare,
  X,
  RotateCcw,
  Container,
  Network,
  Users,
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
import CreateWebsiteWizard from '@/components/hosting/create-website-wizard'
import ImportWizard from '@/components/hosting/import-wizard'
import ImportDashboard from '@/components/hosting/import-dashboard'
import type { MigrationView } from '@/components/hosting/migration-progress'
import { isMigrationActive } from '@/components/hosting/new-website/import-progress'
import {
  ImportProgressDialog,
  ImportStatusLine,
  projectStatusLabel,
  relevantImport,
  useLatestImports,
} from '@/components/hosting/new-website/site-status'
import { ProjectDetailView } from '@/components/hosting/site/site-view'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'

// Types
interface Project {
  id: string
  name: string
  slug: string
  description?: string
  framework: string
  stack?: string | null
  deploymentMethod?: string | null
  status: string
  /** Internal identifier — never shown or linked. */
  subdomain: string
  customDomain?: string | null
  /** Public address (real domain) from the API, or null: no domain connected. */
  address?: string | null
  /** Attached domain still waiting for DNS verification. */
  pendingDomain?: string | null
  sslEnabled: boolean
  autoDeploy: boolean
  lastDeployment?: {
    id: string
    status: string
    createdAt: string
    deployUrl?: string
  } | null
  domains?: { id: string; name: string; status: string }[]
  /** Set when the project is shared with a team (lib/project-access). */
  team?: { id: string; name: string } | null
  ownedByMe?: boolean
  createdAt: string
  updatedAt: string
}

interface ProjectDetail extends Project {
  repoUrl?: string
  environment?: string
  parentProjectId?: string | null
  /** What the viewer may do; absent from older API responses (treat as owner). */
  access?: {
    role: string
    canDeploy: boolean
    canConfigure: boolean
    canAccessData: boolean
    isOwner: boolean
  }
  deployments: Deployment[]
  domains: { id: string; name: string; status: string; dnsRecords?: unknown[] }[]
  server?: {
    id: string
    name: string
    ip: string
    region: string
    status: string
  } | null
}

interface Deployment {
  id: string
  commit?: string
  branch: string
  status: string
  deployUrl?: string
  duration?: number
  triggeredBy: string
  createdAt: string
  updatedAt: string
}

interface EnvVar {
  id: string
  key: string
  value: string
  encrypted: boolean
  createdAt: string
  updatedAt: string
}

interface GithubIntegrationData {
  id: string
  userId: string
  projectId: string
  githubId: string
  username: string
  repoFullName: string
  repoUrl: string
  branch: string
  autoDeploy: boolean
  webhookId: string
  createdAt: string
}

interface CommitData {
  sha: string
  shortSha: string
  message: string
  author: string
  authorEmail: string
  date: string
  branch: string
}

// ─── Container + SSL types (VPS-UI) ────────────────────────────────────
interface ContainerStatus {
  containerId: string
  name: string
  state: 'running' | 'exited' | 'paused' | 'restarting' | 'not_found'
  status: string
  image: string
  ports: string[]
  createdAt: string
}

interface ContainerInfoResponse {
  projectId: string
  projectName: string
  projectStatus: string
  container: ContainerStatus | null
}

interface CertInfo {
  hostname: string
  issuer: string
  issuedAt: string | null
  expiresAt: string | null
  daysUntilExpiry: number | null
  autoRenew: boolean
  status: 'issued' | 'pending' | 'failed' | 'renewing' | 'none'
  keyType: string
  sans: string[]
}

interface SslInfoResponse {
  projectId: string
  projectName: string
  hostname: string
  sslEnabled: boolean
  sslCertStatus: string
  sslCertExpiry: string | null
  cert: CertInfo | null
}

interface Plan {
  id: string
  name: string
  slug: string
  description: string
  price: number
  ram: string
  cpu: string
  storage: string
  bandwidth: string
  projects: number
  ssl: boolean
  customDomain: boolean
  popular: boolean
}

// Helpers
/** The httpOnly session cookie authenticates same-origin requests. */
function getAuthHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' }
}

function statusColor(status: string) {
  switch (status) {
    case 'running':
    case 'live':
      return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
    case 'creating':
    case 'building':
    case 'deploying':
    case 'queued':
      return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
    case 'stopped':
    case 'rolled_back':
      return 'bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400'
    case 'error':
    case 'failed':
      return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    case 'suspended':
      return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400'
  }
}

function frameworkLabel(fw: string) {
  switch (fw) {
    case 'nextjs':
      return 'Next.js'
    case 'react':
      return 'React'
    case 'node':
      return 'Node.js'
    case 'static':
      return 'Static'
    default:
      return fw
  }
}

function frameworkColor(fw: string) {
  switch (fw) {
    case 'nextjs':
      return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
    case 'react':
      return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
    case 'node':
      return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
    case 'static':
      return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800/30 dark:text-gray-400'
  }
}

function frameworkIcon(fw: string) {
  switch (fw) {
    case 'nextjs':
      return <Triangle className="size-4 text-indigo-600 dark:text-indigo-400" />
    case 'react':
      return <Hexagon className="size-4 text-indigo-500 dark:text-indigo-400" />
    case 'node':
      return <FileCode className="size-4 text-indigo-600 dark:text-indigo-400" />
    case 'static':
      return <Layout className="size-4 text-indigo-500 dark:text-indigo-400" />
    default:
      return <FileCode className="size-4 text-gray-500" />
  }
}

function deployStatusIcon(status: string) {
  switch (status) {
    case 'live':
      return <CheckCircle2 className="size-4 text-indigo-500" />
    case 'building':
    case 'deploying':
      return <Loader2 className="size-4 text-yellow-500 animate-spin" />
    case 'failed':
    case 'rolled_back':
      return <XCircle className="size-4 text-red-500" />
    case 'queued':
      return <Clock className="size-4 text-gray-400" />
    default:
      return <Clock className="size-4 text-gray-400" />
  }
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
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

/** What to show when a deployment has no stored log — never an invented one. */
function emptyLogMessage(status: string | undefined): string {
  return status === 'building' || status === 'deploying' || status === 'queued'
    ? 'Waiting for build output…'
    : 'No build log was recorded for this deployment.'
}

function colorizeLogLine(line: string): React.ReactNode {
  if (line.includes('✓') || line.includes('successful') || line.includes('Live at')) {
    return <span className="text-indigo-400">{line}</span>
  }
  if (line.includes('✗') || line.includes('Error') || line.includes('failed')) {
    return <span className="text-red-400">{line}</span>
  }
  if (line.includes('Warning') || line.includes('warn')) {
    return <span className="text-yellow-400">{line}</span>
  }
  if (line.startsWith('>')) {
    return <span className="text-zinc-400">{line}</span>
  }
  return <span className="text-zinc-200">{line}</span>
}

// ─── Sub-components ─────────────────────────────────────────────

function ProjectCardSkeleton() {
  return (
    <Card className="transition-all">
      <CardHeader className="pb-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-48" />
      </CardHeader>
      <CardContent>
        <div className="flex gap-2">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-5 w-16" />
        </div>
        <Skeleton className="mt-3 h-4 w-40" />
      </CardContent>
    </Card>
  )
}

function ProjectCard({
  project,
  onClick,
  selected,
  onSelectToggle,
  onShiftSelect,
  importInfo,
  onOpenImport,
}: {
  project: Project
  onClick: () => void
  selected: boolean
  onSelectToggle: () => void
  onShiftSelect: () => void
  /** The import this site is waiting on or was stopped by, if any. */
  importInfo?: MigrationView | null
  onOpenImport?: () => void
}) {
  const importing = importInfo ? isMigrationActive(importInfo.status) : false
  return (
    <Card
      className={`group cursor-pointer transition-all hover:shadow-lg relative overflow-hidden ${
        selected
          ? 'border-indigo-500 ring-2 ring-indigo-500/30 bg-indigo-50/30 dark:bg-indigo-950/10'
          : 'hover:border-indigo-200 dark:hover:border-indigo-800'
      }`}
      onClick={onClick}
    >
      {/* Selection checkbox (top-right) */}
      <div
        className="absolute top-3 end-3 z-10"
        onClick={(e) => {
          e.stopPropagation()
          if (e.shiftKey) {
            onShiftSelect()
          } else {
            onSelectToggle()
          }
        }}
      >
        <button
          type="button"
          aria-label={selected ? 'Deselect project' : 'Select project'}
          className={`flex size-6 items-center justify-center rounded-md border transition-all ${
            selected
              ? 'border-indigo-500 bg-indigo-500 text-white'
              : 'border-input bg-background/80 opacity-0 group-hover:opacity-100 hover:border-indigo-400'
          }`}
        >
          {selected ? (
            <CheckSquare className="size-4" />
          ) : (
            <Square className="size-4 text-muted-foreground" />
          )}
        </button>
      </div>

      <CardHeader className="pb-2 relative">
        <div className="flex items-start justify-between pe-8">
          <div className="flex items-center gap-2">
            {frameworkIcon(project.framework)}
            <CardTitle className="text-base">{project.name}</CardTitle>
          </div>
          <Badge variant="outline" className={frameworkColor(project.framework)}>
            {frameworkLabel(project.framework)}
          </Badge>
        </div>
        <CardDescription className="text-xs font-mono">
          {(project.address ?? siteHostname(project)) ? (
            project.address ?? siteHostname(project)
          ) : project.pendingDomain ? (
            <span className="font-sans">{project.pendingDomain} · waiting for DNS</span>
          ) : (
            <span className="font-sans text-muted-foreground">{NO_DOMAIN_LABEL}</span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="relative">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className={importing ? statusColor('creating') : statusColor(project.status)}>
            {importing ? 'Importing' : importInfo ? 'Not live yet' : projectStatusLabel(project.status)}
          </Badge>
          {project.team && (
            <Badge variant="outline" className="text-xs" title={project.ownedByMe === false ? `Shared with you through ${project.team.name}` : `Shared with ${project.team.name}`}>
              <Users className="size-3 me-1" />
              {project.team.name}
            </Badge>
          )}
          {project.sslEnabled && (
            <Badge variant="outline" className="bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400 text-xs">
              <Shield className="size-3 me-1" />
              SSL
            </Badge>
          )}
        </div>
        {importInfo && onOpenImport && (
          <ImportStatusLine migration={importInfo} onOpen={onOpenImport} />
        )}
        <div className="mt-3 flex items-center justify-between">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="size-3" />
            {project.lastDeployment
              ? `Last deploy: ${timeAgo(project.lastDeployment.createdAt)}`
              : formatDate(project.createdAt)
            }
          </div>
          <ChevronRight className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      </CardContent>
    </Card>
  )
}

function CreateProjectDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [framework, setFramework] = useState('nextjs')
  const [planId, setPlanId] = useState('')
  const [plans, setPlans] = useState<Plan[]>([])
  const [loading, setLoading] = useState(false)
  const [plansLoading, setPlansLoading] = useState(false)

  useEffect(() => {
    if (open) {
      setPlansLoading(true)
      fetch('/api/billing/plans')
        .then((r) => r.json())
        .then((data) => {
          setPlans(data.plans || [])
          if (data.plans?.length > 0 && !planId) {
            setPlanId(data.plans[0].id)
          }
        })
        .catch(() => toast.error('Failed to load plans'))
        .finally(() => setPlansLoading(false))
    }
  }, [open, planId])

  const handleCreate = async () => {
    if (!name.trim()) {
      toast.error('Project name is required')
      return
    }
    setLoading(true)
    try {
      const res = await fetch('/api/hosting/create', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ name: name.trim(), framework, planId: planId || undefined }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to create project')
        return
      }
      toast.success('Project created successfully!')
      setName('')
      setFramework('nextjs')
      onCreated()
      onClose()
    } catch {
      toast.error('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create New Project</DialogTitle>
          <DialogDescription>
            Set up a new hosting project with your preferred framework and plan.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="project-name">Project Name</Label>
            <Input
              id="project-name"
              placeholder="my-awesome-app"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="grid gap-2">
            <Label>Framework</Label>
            <Select value={framework} onValueChange={setFramework}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select framework" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="nextjs">Next.js</SelectItem>
                <SelectItem value="react">React</SelectItem>
                <SelectItem value="node">Node.js</SelectItem>
                <SelectItem value="static">Static</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label>Plan</Label>
            {plansLoading ? (
              <div className="grid gap-2">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : (
              <div className="grid gap-2">
                {plans.map((plan) => (
                  <button
                    key={plan.id}
                    type="button"
                    onClick={() => setPlanId(plan.id)}
                    className={`relative flex items-center gap-3 rounded-lg border p-3 text-start transition-all hover:border-indigo-300 dark:hover:border-indigo-700 ${
                      planId === plan.id
                        ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20 ring-1 ring-indigo-500'
                        : 'border-border'
                    }`}
                  >
                    {plan.popular && (
                      <Badge className="absolute -top-2 end-3 bg-indigo-600 text-white text-[10px] px-1.5 py-0">
                        Popular
                      </Badge>
                    )}
                    <div className="flex-1">
                      <div className="font-medium text-sm">{plan.name}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {plan.cpu} &middot; {plan.ram} &middot; {plan.storage}
                      </div>
                    </div>
                    <div className="text-end">
                      <div className="font-semibold text-indigo-600 dark:text-indigo-400">
                        ${plan.price}
                      </div>
                      <div className="text-[10px] text-muted-foreground">/mo</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={loading || !name.trim()}
            className="bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            {loading ? (
              <>
                <RefreshCw className="size-4 me-2 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Rocket className="size-4 me-2" />
                Create Project
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// The per-website view (header, areas, file manager …) lives in
// src/components/hosting/site/site-view.tsx.

// ─── Address bar ↔ open website ─────────────────────────────────

/**
 * Put the open website in the query string, or take it out. History is
 * replaced, not pushed, and the hash (the site's area) is left alone.
 */
function writeSiteToUrl(projectId: string | null) {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (projectId) {
    url.searchParams.set('tab', 'hosting')
    url.searchParams.set('project', projectId)
  } else {
    if (!url.searchParams.has('project')) return
    url.searchParams.delete('project')
    if (url.searchParams.get('tab') === 'hosting') url.searchParams.delete('tab')
  }
  const next = `${url.pathname}${url.search}${url.hash}`
  if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(window.history.state, '', next)
  }
}

// ─── Main Component ─────────────────────────────────────────────

export default function HostingPanel() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [showImport, setShowImport] = useState(false)
  // 'projects' is the website list; 'imports' is the migration dashboard.
  const [view, setView] = useState<'projects' | 'imports'>('projects')
  // Notification links open a website directly (?tab=hosting&project=<id>).
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('project')
  )

  // The open website lives in the address bar (?tab=hosting&project=<id>,
  // plus the site's area hash, which site-view.tsx manages), so a reload or
  // a copied link opens the same site. Closing it, or leaving Hosting,
  // removes it again.
  useEffect(() => {
    writeSiteToUrl(selectedProjectId)
  }, [selectedProjectId])
  useEffect(() => () => writeSiteToUrl(null), [])

  // ── Search / filter / sort state ──────────────────────────────────
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('') // debounced
  const [statusFilter, setStatusFilter] = useState('all')
  const [frameworkFilter, setFrameworkFilter] = useState('all')
  const [sortBy, setSortBy] = useState<'name' | 'created' | 'deployed'>('created')

  // ── Multi-select state ────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const lastSelectedIndex = useRef<number | null>(null)

  // ── Bulk action state ─────────────────────────────────────────────
  const [bulkAction, setBulkAction] = useState<'deploy' | 'stop' | 'restart' | 'delete' | null>(null)
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false)

  // ── Imports: what each card shows while a site waits on one ──────
  const [importsKey, setImportsKey] = useState(0)
  const { byProject: latestImports, hasAny: hasImports } = useLatestImports(importsKey)
  const [openImport, setOpenImport] = useState<MigrationView | null>(null)

  // ── Debounce search input (300ms) ─────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput.trim()), 300)
    return () => clearTimeout(t)
  }, [searchInput])

  // ── Listen for command palette "create project" event ────────────
  useEffect(() => {
    const handler = () => setShowCreate(true)
    window.addEventListener('deployhub:command:create-project', handler)
    return () => window.removeEventListener('deployhub:command:create-project', handler)
  }, [])

  const fetchProjects = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (searchQuery) params.set('search', searchQuery)
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (frameworkFilter !== 'all') params.set('framework', frameworkFilter)
      params.set('sort', sortBy)

      const qs = params.toString()
      const res = await fetch(`/api/hosting${qs ? `?${qs}` : ''}`, {
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        setProjects(data.projects || [])
      } else {
        toast.error(data.error || 'Failed to load projects')
      }
    } catch {
      toast.error('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [searchQuery, statusFilter, frameworkFilter, sortBy])

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  // ── Selection helpers ─────────────────────────────────────────────
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  // Shift-click: select range from the last clicked card to this one
  const shiftSelectRange = (index: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      const from = lastSelectedIndex.current
      if (from === null) {
        const id = projects[index]?.id
        if (id) next.add(id)
        return next
      }
      const start = Math.min(from, index)
      const end = Math.max(from, index)
      for (let i = start; i <= end; i++) {
        const id = projects[i]?.id
        if (id) next.add(id)
      }
      return next
    })
  }

  const clearSelection = () => {
    setSelectedIds(new Set())
    lastSelectedIndex.current = null
  }

  const selectAll = () => {
    setSelectedIds(new Set(projects.map((p) => p.id)))
  }

  // ── Bulk action runner ────────────────────────────────────────────
  const runBulkAction = async (action: 'deploy' | 'stop' | 'restart' | 'delete') => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return

    if (action === 'delete') {
      setBulkDeleteConfirmOpen(true)
      return
    }

    setBulkLoading(true)
    setBulkAction(action)
    try {
      const res = await fetch('/api/hosting/bulk', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ action, projectIds: ids }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || `Bulk ${action} failed`)
        return
      }
      const { succeeded, failed } = data.summary
      if (failed === 0) {
        toast.success(`Successfully ${action}ed ${succeeded} project${succeeded !== 1 ? 's' : ''}`)
      } else {
        toast.warning(`${succeeded} succeeded, ${failed} failed`)
      }
      clearSelection()
      fetchProjects()
    } catch {
      toast.error('Network error during bulk action')
    } finally {
      setBulkLoading(false)
      setBulkAction(null)
    }
  }

  const confirmBulkDelete = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    setBulkLoading(true)
    setBulkAction('delete')
    try {
      const res = await fetch('/api/hosting/bulk', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ action: 'delete', projectIds: ids }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Bulk delete failed')
        return
      }
      const { succeeded, failed } = data.summary
      if (failed === 0) {
        toast.success(`Deleted ${succeeded} project${succeeded !== 1 ? 's' : ''}`)
      } else {
        toast.warning(`${succeeded} deleted, ${failed} failed`)
      }
      // Deletes that succeeded but left unconfirmed server-side cleanup.
      const partial = (data.results as Array<{ warning?: string }>).filter((r) => r.warning)
      if (partial.length > 0) {
        toast.warning(
          `${partial.length} project${partial.length !== 1 ? 's' : ''}: server-side cleanup could not be confirmed`,
          { description: partial.map((r) => r.warning).join(' · ') }
        )
      }
      clearSelection()
      setBulkDeleteConfirmOpen(false)
      fetchProjects()
    } catch {
      toast.error('Network error during delete')
    } finally {
      setBulkLoading(false)
      setBulkAction(null)
    }
  }

  // Detail View
  if (selectedProjectId) {
    return (
      <div>
        <ProjectDetailView
          key={selectedProjectId}
          projectId={selectedProjectId}
          onBack={() => setSelectedProjectId(null)}
          onRefresh={fetchProjects}
          onOpenProject={setSelectedProjectId}
        />
      </div>
    )
  }

  // The import dashboard is a peer view of the project list, not a tab inside
  // a project: an import creates the website it lands in, so it cannot live
  // under a website that does not exist yet.
  if (view === 'imports') {
    return (
      <ImportDashboard
        onBack={() => {
          setView('projects')
          setImportsKey((k) => k + 1)
        }}
        onCreated={() => void fetchProjects()}
      />
    )
  }

  const selectedCount = selectedIds.size
  const hasActiveFilters = searchInput !== '' || statusFilter !== 'all' || frameworkFilter !== 'all'

  const clearFilters = () => {
    setSearchInput('')
    setStatusFilter('all')
    setFrameworkFilter('all')
  }

  // List View
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold">Websites</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Your sites and apps.
            {hasImports && (
              <>
                {' '}
                <button
                  type="button"
                  onClick={() => setView('imports')}
                  className="font-medium text-primary underline-offset-2 hover:underline"
                >
                  Import history
                </button>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            onClick={() => setShowImport(true)}
            title="Move an existing website here from another host"
          >
            <HardDriveDownload className="size-4 me-2" />
            Import
          </Button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="size-4 me-2" />
            New website
          </Button>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <Input
            type="search"
            placeholder="Search by name, framework, or domain..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="ps-9 pe-4"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput('')}
              className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Status filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <Filter className="size-4" />
                <span className="hidden sm:inline">Status:</span>
                <span className="capitalize">{statusFilter === 'all' ? 'All' : statusFilter}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Filter by status</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {['all', 'running', 'stopped', 'error', 'creating'].map((s) => (
                <DropdownMenuItem
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={statusFilter === s ? 'bg-accent' : ''}
                >
                  <span className="capitalize">{s}</span>
                  {statusFilter === s && <CheckCircle2 className="size-3.5 ms-auto text-indigo-600" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Framework filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <FileCode className="size-4" />
                <span className="hidden sm:inline">Framework:</span>
                <span>{frameworkFilter === 'all' ? 'All' : frameworkLabel(frameworkFilter)}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Filter by framework</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {['all', 'nextjs', 'react', 'node', 'static'].map((f) => (
                <DropdownMenuItem
                  key={f}
                  onClick={() => setFrameworkFilter(f)}
                  className={frameworkFilter === f ? 'bg-accent' : ''}
                >
                  {f === 'all' ? 'All' : frameworkLabel(f)}
                  {frameworkFilter === f && <CheckCircle2 className="size-3.5 ms-auto text-indigo-600" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Sort */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <ArrowUpDown className="size-4" />
                <span className="hidden sm:inline">Sort:</span>
                <span className="capitalize">
                  {sortBy === 'created' ? 'Newest' : sortBy === 'name' ? 'Name' : 'Last deployed'}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setSortBy('created')}
                className={sortBy === 'created' ? 'bg-accent' : ''}
              >
                Created date (newest)
                {sortBy === 'created' && <CheckCircle2 className="size-3.5 ms-auto text-indigo-600" />}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setSortBy('name')}
                className={sortBy === 'name' ? 'bg-accent' : ''}
              >
                Name (A → Z)
                {sortBy === 'name' && <CheckCircle2 className="size-3.5 ms-auto text-indigo-600" />}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setSortBy('deployed')}
                className={sortBy === 'deployed' ? 'bg-accent' : ''}
              >
                Last deployed
                {sortBy === 'deployed' && <CheckCircle2 className="size-3.5 ms-auto text-indigo-600" />}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="gap-1">
              <X className="size-3.5" />
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Bulk Action Toolbar */}
      {selectedCount > 0 && (
        <div className="sticky top-0 z-20 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between p-3 rounded-lg border border-indigo-200 dark:border-indigo-900/50 bg-indigo-50/80 dark:bg-indigo-950/30 backdrop-blur-sm shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <div className="flex size-7 items-center justify-center rounded-md bg-indigo-600 text-white text-xs font-semibold">
                {selectedCount}
              </div>
              <span>project{selectedCount !== 1 ? 's' : ''} selected</span>
            </div>
            <button
              type="button"
              onClick={selectAll}
              className="text-xs text-indigo-700 dark:text-indigo-400 hover:underline"
            >
              Select all ({projects.length})
            </button>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={() => runBulkAction('deploy')}
              disabled={bulkLoading}
              className="gap-1.5 bg-background"
            >
              {bulkLoading && bulkAction === 'deploy' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Rocket className="size-3.5 text-indigo-600" />
              )}
              Deploy All
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => runBulkAction('stop')}
              disabled={bulkLoading}
              className="gap-1.5 bg-background"
            >
              {bulkLoading && bulkAction === 'stop' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <StopCircle className="size-3.5 text-yellow-600" />
              )}
              Stop All
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => runBulkAction('restart')}
              disabled={bulkLoading}
              className="gap-1.5 bg-background"
            >
              {bulkLoading && bulkAction === 'restart' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5 text-indigo-600" />
              )}
              Restart All
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => runBulkAction('delete')}
              disabled={bulkLoading}
              className="gap-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20 bg-background"
            >
              {bulkLoading && bulkAction === 'delete' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              Delete All
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={clearSelection}
              disabled={bulkLoading}
              className="gap-1"
            >
              <X className="size-3.5" />
              Clear
            </Button>
          </div>
        </div>
      )}

      {/* Project Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ProjectCardSkeleton />
          <ProjectCardSkeleton />
          <ProjectCardSkeleton />
          <ProjectCardSkeleton />
        </div>
      ) : projects.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16">
            {hasActiveFilters ? (
              <>
                <Search className="size-12 text-muted-foreground/40 mb-4" />
                <h3 className="text-lg font-semibold mb-1">No projects match</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Try adjusting your search or filters
                </p>
                <Button variant="outline" onClick={clearFilters} className="gap-1.5">
                  <X className="size-4" />
                  Clear filters
                </Button>
              </>
            ) : (
              <>
                <h3 className="text-lg font-semibold mb-1">Put your first website online</h3>
                <p className="text-sm text-muted-foreground mb-5 text-center max-w-md">
                  Start a WordPress site, move a site from your current host,
                  upload your files or deploy from Git. We guide you through it
                  and handle the database, links and HTTPS.
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  <Button onClick={() => setShowCreate(true)}>
                    <Plus className="size-4 me-2" />
                    New website
                  </Button>
                  <Button variant="outline" onClick={() => setShowImport(true)}>
                    <HardDriveDownload className="size-4 me-2" />
                    Move an existing site
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Showing {projects.length} project{projects.length !== 1 ? 's' : ''}
            </span>
            {selectedCount > 0 && (
              <span className="text-indigo-600 dark:text-indigo-400 font-medium">
                {selectedCount} selected
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {projects.map((project, index) => (
              <ProjectCard
                key={project.id}
                project={project}
                selected={selectedIds.has(project.id)}
                onSelectToggle={() => {
                  lastSelectedIndex.current = index
                  toggleSelect(project.id)
                }}
                onShiftSelect={() => {
                  shiftSelectRange(index)
                  lastSelectedIndex.current = index
                }}
                onClick={() => setSelectedProjectId(project.id)}
                importInfo={relevantImport(project.status, latestImports[project.id])}
                onOpenImport={() => setOpenImport(latestImports[project.id] ?? null)}
              />
            ))}
          </div>
        </>
      )}

      {/* One guided flow for every way of getting a site online; Import
          opens the same flow on "Move my existing website". */}
      <CreateWebsiteWizard
        open={showCreate}
        onClose={() => {
          setShowCreate(false)
          void fetchProjects()
          setImportsKey((k) => k + 1)
        }}
        onCreated={() => {
          void fetchProjects()
          setImportsKey((k) => k + 1)
        }}
        onOpenProject={setSelectedProjectId}
      />

      <ImportWizard
        open={showImport}
        onClose={() => {
          setShowImport(false)
          setImportsKey((k) => k + 1)
        }}
        onCreated={() => {
          void fetchProjects()
          setImportsKey((k) => k + 1)
        }}
        onCompleted={() => {
          void fetchProjects()
          setImportsKey((k) => k + 1)
        }}
      />

      <ImportProgressDialog
        migration={openImport}
        onClose={() => {
          setOpenImport(null)
          setImportsKey((k) => k + 1)
        }}
        onFinished={() => {
          void fetchProjects()
          setImportsKey((k) => k + 1)
        }}
      />

      {/* Bulk Delete Confirmation */}
      <AlertDialog open={bulkDeleteConfirmOpen} onOpenChange={setBulkDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-red-500" />
              Delete {selectedCount} project{selectedCount !== 1 ? 's' : ''}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>{selectedCount}</strong> project
              {selectedCount !== 1 ? 's' : ''} along with their containers, deployments,
              environment variables, databases, and backups. Domains you own stay in
              your account. This action <strong>cannot be undone</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmBulkDelete}
              disabled={bulkLoading}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {bulkLoading ? (
                <>
                  <Loader2 className="size-4 me-2 animate-spin" />
                  Deleting {selectedCount}...
                </>
              ) : (
                <>
                  <Trash2 className="size-4 me-2" />
                  Delete {selectedCount} project{selectedCount !== 1 ? 's' : ''}
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
