'use client'

/**
 * The website page (one site): status header, then a small set of areas as
 * real tabs. Only the active area is rendered, and the location hash names it
 * (#files, #domains, #cron …) so old links keep working — see site-areas.ts.
 *
 * Moved out of hosting-panel.tsx, which keeps the website list.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowLeft,
  Calendar,
  CheckCircle2,
  Clock,
  Container,
  Edit,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  FlaskConical,
  GitBranch,
  GitCommit,
  Github,
  Globe,
  Key,
  LayoutDashboard,
  Loader2,
  Lock,
  MoreVertical,
  Network,
  Plus,
  RefreshCw,
  Rocket,
  RotateCcw,
  Save,
  Settings,
  Shield,
  Square,
  StopCircle,
  Terminal,
  Trash2,
  Unplug,
  Upload,
  XCircle,
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import ImportDashboard from '@/components/hosting/import-dashboard'
import { EmailManagement } from '@/components/hosting/email-management'
import { LazySection } from '@/components/hosting/lazy-section'
import {
  DatabaseTab,
  BackupsTab,
  FilesTab,
  TerminalTab,
  ResourcesTab,
  DomainsTab,
  EmailTab,
} from '@/components/hosting/website-management-tabs'
import { WordPressTab } from '@/components/hosting/wordpress-tab'
import { AppToolsTab } from '@/components/hosting/app-tools-tab'
import { StagingTab } from '@/components/hosting/staging-tab'
import { SftpTab } from '@/components/hosting/sftp-tab'
import { CdnTab } from '@/components/hosting/cdn-tab'
import { CronTab, RedirectsTab, SecurityTab } from '@/components/hosting/cpanel-management-tabs'
import {
  ADVANCED_SECTIONS,
  areasFor,
  hashFor,
  resolveHash,
  siteKind,
  type AdvancedId,
  type AreaId,
  type AreaLocation,
} from './site-areas'
import { describeSiteStatus, TONE_CLASSES } from './site-status'
import { SiteOverview } from './site-overview'
import { InlineError } from './shared'

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
  subdomain: string
  customDomain?: string
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
  /** 'imported' while an imported site waits for its import to finish. */
  deploymentSource?: string | null
  lastDeployedAt?: string | null
  websiteDomains?: { id: string; domain: string; isPrimary: boolean; sslEnabled: boolean; sslStatus: string; verified: boolean }[]
  websiteBackupsCount?: number
  resourceStorageGB?: number | null
  server?: {
    id: string
    name: string
    ip?: string
    region: string
    status: string
  } | null
}

export type SiteProject = ProjectDetail
export type SiteDeployment = Deployment
export type SiteSslInfo = SslInfoResponse

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

// ─── Build Logs Dialog ────────────────────────────────────────────

function BuildLogsDialog({
  open,
  onClose,
  logContent,
  deployment,
  project,
  loading,
}: {
  open: boolean
  onClose: () => void
  logContent: string
  deployment: Deployment | null
  project: ProjectDetail | null
  loading: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [open, logContent])

  const displayLog = loading
    ? 'Loading build logs...'
    : logContent || (deployment ? emptyLogMessage(deployment.status) : 'No build logs available')

  const isAnimating = deployment?.status === 'building' || deployment?.status === 'deploying'

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="size-5 text-indigo-600" />
            Build Logs
            {isAnimating && (
              <span className="flex items-center gap-1 text-sm text-indigo-600 ms-2">
                <span className="relative flex size-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-indigo-500" />
                </span>
                Live
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {deployment ? (
              <>
                <span className="font-mono">{deployment.commit?.slice(0, 8) || 'Initial deploy'}</span>
                {' on '}
                <span className="font-mono">{deployment.branch}</span>
              </>
            ) : (
              'Build output'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg bg-zinc-950 border border-zinc-800 overflow-hidden">
          {/* Terminal header bar */}
          <div className="flex items-center gap-2 px-4 py-2 bg-zinc-900 border-b border-zinc-800">
            <div className="size-3 rounded-full bg-red-500/80" />
            <div className="size-3 rounded-full bg-yellow-500/80" />
            <div className="size-3 rounded-full bg-green-500/80" />
            <span className="ms-2 text-xs text-zinc-500 font-mono">build log</span>
          </div>

          {/* Terminal content */}
          <div
            ref={scrollRef}
            className="p-4 font-mono text-xs leading-relaxed max-h-[50vh] overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700"
          >
            <pre className="whitespace-pre-wrap break-words">
              {displayLog.split('\n').map((line, i) => (
                <div key={i}>{colorizeLogLine(line)}</div>
              ))}
            </pre>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Container Logs Dialog (VPS-UI) ────────────────────────────────────

function ContainerLogsDialog({
  open,
  onClose,
  logs,
  loading,
  tail,
  onTailChange,
  onRefresh,
  containerName,
}: {
  open: boolean
  onClose: () => void
  logs: string
  loading: boolean
  tail: number
  onTailChange: (tail: number) => void
  onRefresh: () => void
  containerName: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  // Auto-scroll to bottom when logs update
  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [open, logs, loading])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(logs)
      setCopied(true)
      toast.success('Logs copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Copy failed')
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="size-5 text-indigo-600" />
            Container Logs
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2 flex-wrap">
            <span className="font-mono">{containerName}</span>
            <span className="text-muted-foreground">·</span>
            <span>last {tail} lines</span>
          </DialogDescription>
        </DialogHeader>

        {/* Controls */}
        <div className="flex items-center justify-between gap-2 flex-wrap pb-2">
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Tail</Label>
            <Select
              value={String(tail)}
              onValueChange={(v) => onTailChange(parseInt(v, 10))}
            >
              <SelectTrigger className="h-8 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[100, 500, 1000, 5000].map((t) => (
                  <SelectItem key={t} value={String(t)}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={handleCopy}
              disabled={!logs || loading}
            >
              {copied ? (
                <>
                  <CheckCircle2 className="size-3.5 me-1 text-indigo-500" />
                  Copied
                </>
              ) : (
                <>
                  <FileText className="size-3.5 me-1" />
                  Copy
                </>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={onRefresh}
              disabled={loading}
            >
              <RefreshCw className={`size-3.5 me-1 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Terminal-style log viewer */}
        <div className="flex-1 min-h-0 rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 border-b border-zinc-800">
            <span className="size-2 rounded-full bg-red-500/80" />
            <span className="size-2 rounded-full bg-amber-500/80" />
            <span className="size-2 rounded-full bg-indigo-500/80" />
            <span className="ms-2 text-[10px] text-zinc-500 font-mono">
              docker logs --tail {tail} {containerName}
            </span>
          </div>
          <div
            ref={scrollRef}
            className="p-3 text-xs font-mono text-indigo-400 overflow-auto max-h-[60vh] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700"
          >
            {loading ? (
              <div className="flex items-center gap-2 text-zinc-400">
                <Loader2 className="size-3.5 animate-spin" />
                Fetching logs...
              </div>
            ) : logs ? (
              <pre className="whitespace-pre-wrap break-all">
                {logs.split('\n').map((line, i) => (
                  <div key={i} className="leading-relaxed">
                    <span className="text-zinc-600 select-none me-3">
                      {String(i + 1).padStart(3, '0')}
                    </span>
                    <span
                      className={
                        line.toLowerCase().includes('error') ||
                        line.toLowerCase().includes('fatal')
                          ? 'text-red-400'
                          : line.toLowerCase().includes('warn')
                            ? 'text-yellow-400'
                            : line.toLowerCase().includes('debug')
                              ? 'text-zinc-500'
                              : 'text-indigo-400'
                      }
                    >
                      {line || ' '}
                    </span>
                  </div>
                ))}
              </pre>
            ) : (
              <div className="text-zinc-500">No logs available</div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Project Detail View ─────────────────────────────────────────

export function ProjectDetailView({
  projectId,
  onBack,
  onRefresh,
  onOpenProject,
}: {
  projectId: string
  onBack: () => void
  onRefresh: () => void
  /** Switch the detail view to another project (live ↔ staging). */
  onOpenProject?: (id: string) => void
}) {
  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [deploying, setDeploying] = useState(false)
  const [logsDialogOpen, setLogsDialogOpen] = useState(false)
  const [selectedDeployment, setSelectedDeployment] = useState<Deployment | null>(null)
  const [logContent, setLogContent] = useState('')
  const [logLoading, setLogLoading] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Settings state
  const [settingsAutoDeploy, setSettingsAutoDeploy] = useState(false)
  const [settingsSsl, setSettingsSsl] = useState(false)
  const [settingsRepoUrl, setSettingsRepoUrl] = useState('')
  const [settingsCustomDomain, setSettingsCustomDomain] = useState('')
  const [savingSettings, setSavingSettings] = useState(false)

  // Env vars state
  const [envVars, setEnvVars] = useState<EnvVar[]>([])
  const [envLoading, setEnvLoading] = useState(true)
  const [envReveal, setEnvReveal] = useState(false)
  const [envDialogOpen, setEnvDialogOpen] = useState(false)
  const [envDialogMode, setEnvDialogMode] = useState<'create' | 'edit'>('create')
  const [envEditId, setEnvEditId] = useState<string | null>(null)
  const [envKey, setEnvKey] = useState('')
  const [envValue, setEnvValue] = useState('')
  const [envEncrypted, setEnvEncrypted] = useState(false)
  const [envImportOpen, setEnvImportOpen] = useState(false)
  const [envImportText, setEnvImportText] = useState('')
  const [envImportName, setEnvImportName] = useState('')
  const [envImportOverwrite, setEnvImportOverwrite] = useState(true)
  const [envImporting, setEnvImporting] = useState(false)
  const [envDrift, setEnvDrift] = useState<{
    pending: boolean
    keys: string[]
    needsRebuild: string[]
  } | null>(null)
  const [envApplying, setEnvApplying] = useState(false)
  const [envSaving, setEnvSaving] = useState(false)
  const [envDeleteId, setEnvDeleteId] = useState<string | null>(null)
  const [envDeleting, setEnvDeleting] = useState(false)

  // GitHub integration state
  const [githubIntegration, setGithubIntegration] = useState<GithubIntegrationData | null>(null)
  const [githubLoading, setGithubLoading] = useState(true)
  const [connectDialogOpen, setConnectDialogOpen] = useState(false)
  const [connectRepoUrl, setConnectRepoUrl] = useState('')
  const [connectBranch, setConnectBranch] = useState('main')
  const [connectAutoDeploy, setConnectAutoDeploy] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [commitsDialogOpen, setCommitsDialogOpen] = useState(false)
  const [commits, setCommits] = useState<CommitData[]>([])
  const [commitsLoading, setCommitsLoading] = useState(false)
  const [disconnectDialogOpen, setDisconnectDialogOpen] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [redeploying, setRedeploying] = useState(false)

  // ── Area navigation (tabs ↔ location hash) ───────────────────────────
  const [loc, setLoc] = useState<AreaLocation>({ area: 'overview', advanced: 'deployments', section: null })
  const [loadError, setLoadError] = useState<string | null>(null)
  const kindRef = useRef<ReturnType<typeof siteKind>>(null)
  const kindResolved = useRef(false)
  const locRef = useRef<AreaLocation>(loc)
  useEffect(() => {
    locRef.current = loc
  }, [loc])
  const [envError, setEnvError] = useState<string | null>(null)

  /** Open an area (and optionally an Advanced tool or a section inside it). */
  const goTo = useCallback((area: AreaId, advanced?: AdvancedId, section?: string) => {
    // History is written outside the state updater: Next.js patches
    // replaceState and updates its router, which must not happen mid-render.
    const next: AreaLocation = { area, advanced: advanced ?? locRef.current.advanced, section: section ?? null }
    locRef.current = next
    setLoc(next)
    const hash = section ?? hashFor(next.area, next.advanced)
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#${hash}`)
  }, [])

  // Links such as <a href="#cron"> (or editing the address bar) switch area.
  useEffect(() => {
    const onHash = () => setLoc(resolveHash(window.location.hash, kindRef.current))
    window.addEventListener('hashchange', onHash)
    return () => {
      window.removeEventListener('hashchange', onHash)
      // Leaving the website: drop its area from the address bar.
      if (window.location.hash) {
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
      }
    }
  }, [])

  // A section inside a stacked area (#redirects, #import …): bring it into view.
  useEffect(() => {
    if (!loc.section) return
    const id = loc.section
    const t = window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 60)
    return () => window.clearTimeout(t)
  }, [loc.section, loc.area])

  // ── Container status state (VPS-UI) ──────────────────────────────────
  const [containerInfo, setContainerInfo] = useState<ContainerInfoResponse | null>(null)
  const [containerLoading, setContainerLoading] = useState(true)
  const [containerActionLoading, setContainerActionLoading] = useState(false)
  const [containerLogsOpen, setContainerLogsOpen] = useState(false)
  const [containerLogs, setContainerLogs] = useState('')
  const [containerLogsLoading, setContainerLogsLoading] = useState(false)
  const [logTail, setLogTail] = useState(500)

  // ── SSL certificate state (VPS-UI) ───────────────────────────────────
  const [sslInfo, setSslInfo] = useState<SslInfoResponse | null>(null)
  const [sslLoading, setSslLoading] = useState(true)
  const [sslActionLoading, setSslActionLoading] = useState(false)

  const fetchProject = useCallback(async () => {
    try {
      const res = await fetch(`/api/hosting/${projectId}`, {
        headers: getAuthHeaders(),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.project) {
        setLoadError(data?.error || `The server answered ${res.status}.`)
        return
      }
      setLoadError(null)
      // First load: open the area the address bar names (#files, #cron …).
      if (!kindResolved.current) {
        kindResolved.current = true
        kindRef.current = siteKind(data.project)
        setLoc(resolveHash(window.location.hash, kindRef.current))
      }
      setProject(data.project)
      // Initialize settings
      setSettingsAutoDeploy(data.project.autoDeploy)
      setSettingsSsl(data.project.sslEnabled)
      setSettingsRepoUrl(data.project.repoUrl || '')
      setSettingsCustomDomain(data.project.customDomain || '')
    } catch {
      setLoadError('Network error. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  const fetchEnvVars = useCallback(async () => {
    setEnvLoading(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/env${envReveal ? '?reveal=true' : ''}`, {
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        setEnvVars(data.envVars || [])
        setEnvDrift(data.drift ?? null)
        setEnvError(null)
      } else {
        setEnvError(data.error || 'The environment variables could not be loaded.')
      }
    } catch {
      setEnvError('Network error while loading the environment variables.')
    } finally {
      setEnvLoading(false)
    }
  }, [projectId, envReveal])

  useEffect(() => {
    setLoading(true)
    fetchProject()
  }, [fetchProject])

  useEffect(() => {
    fetchEnvVars()
  }, [fetchEnvVars])

  // Fetch GitHub integration when project loads
  useEffect(() => {
    const loadGithub = async () => {
      setGithubLoading(true)
      try {
        const res = await fetch(`/api/hosting/${projectId}`, {
          headers: getAuthHeaders(),
        })
        const data = await res.json()
        if (res.ok && data.project?.githubIntegration) {
          setGithubIntegration(data.project.githubIntegration)
        }
      } catch {
        // Silently handle
      } finally {
        setGithubLoading(false)
      }
    }
    loadGithub()
  }, [projectId])

  // ── Fetch container status (VPS-UI) ──────────────────────────────────
  // Auto-refresh every 10s while the container is running.
  const fetchContainerInfo = useCallback(async () => {
    try {
      const res = await fetch(`/api/hosting/${projectId}/container`, {
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        setContainerInfo(data)
      }
    } catch {
      // silently ignore — UI shows a friendly error
    } finally {
      setContainerLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    fetchContainerInfo()
  }, [fetchContainerInfo])

  useEffect(() => {
    // Only auto-refresh when the container is actually running.
    if (containerInfo?.container?.state !== 'running') return
    const interval = setInterval(() => {
      fetchContainerInfo()
    }, 10000)
    return () => clearInterval(interval)
  }, [containerInfo?.container?.state, fetchContainerInfo])

  // ── Fetch SSL certificate info (VPS-UI) ──────────────────────────────
  const fetchSslInfo = useCallback(async () => {
    try {
      const res = await fetch(`/api/hosting/${projectId}/ssl`, {
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        setSslInfo(data)
      }
    } catch {
      // silently ignore
    } finally {
      setSslLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    fetchSslInfo()
  }, [fetchSslInfo])

  const handleDeploy = async () => {
    setDeploying(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/deploy`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Deploy failed')
        return
      }
      toast.success('Deployment triggered!', {
        description: 'Watch progress in the Deployments tab.',
      })
      fetchProject()
      onRefresh()
    } catch {
      toast.error('Network error')
    } finally {
      setDeploying(false)
    }
  }

  // (The old header "Stop" button sent DELETE /api/hosting/[id], which deletes
  // the website. Stopping now uses the container stop endpoint.)

  const handleViewLogs = async (dep: Deployment) => {
    setSelectedDeployment(dep)
    setLogsDialogOpen(true)
    setLogLoading(true)
    try {
      const res = await fetch(`/api/deployments/${dep.id}/logs`, {
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        setLogContent(data.logs || '')
      } else {
        setLogContent('')
      }
    } catch {
      setLogContent('')
    } finally {
      setLogLoading(false)
    }
  }

  const handleSaveSettings = async () => {
    setSavingSettings(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          autoDeploy: settingsAutoDeploy,
          sslEnabled: settingsSsl,
          repoUrl: settingsRepoUrl,
          customDomain: settingsCustomDomain,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to save settings')
        return
      }
      toast.success('Settings saved successfully!')
      fetchProject()
    } catch {
      toast.error('Failed to save settings')
    } finally {
      setSavingSettings(false)
    }
  }

  const handleOpenEnvDialog = (mode: 'create' | 'edit', envVar?: EnvVar) => {
    setEnvDialogMode(mode)
    if (mode === 'edit' && envVar) {
      setEnvEditId(envVar.id)
      setEnvKey(envVar.key)
      setEnvValue('')
      setEnvEncrypted(envVar.encrypted)
    } else {
      setEnvEditId(null)
      setEnvKey('')
      setEnvValue('')
      setEnvEncrypted(false)
    }
    setEnvDialogOpen(true)
  }

  /** Read a chosen .env into the textarea so the customer sees what will land. */
  const handleEnvFile = async (file: File | null | undefined) => {
    if (!file) return
    if (file.size > 512 * 1024) {
      toast.error('That file is too large to be a .env (limit 512 KB).')
      return
    }
    try {
      const text = await file.text()
      setEnvImportText(text)
      setEnvImportName(file.name)
    } catch {
      toast.error('Could not read that file.')
    }
  }

  const handleImportEnv = async () => {
    if (!envImportText.trim()) {
      toast.error('Choose a .env file or paste its contents first.')
      return
    }
    setEnvImporting(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/env`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          action: 'import',
          content: envImportText,
          overwrite: envImportOverwrite,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Import failed')
        return
      }
      const bits: string[] = []
      if (data.added?.length) bits.push(`${data.added.length} added`)
      if (data.updated?.length) bits.push(`${data.updated.length} updated`)
      if (data.skipped?.length) bits.push(`${data.skipped.length} skipped`)
      toast.success(bits.join(', ') || 'Nothing to import', {
        description: 'Redeploy the site for the container to pick them up.',
      })
      // Lines that could not be used are worth naming — silently dropping a
      // variable the customer believes they set is the bad outcome here.
      if (data.invalid?.length) {
        toast.warning(
          `${data.invalid.length} line${data.invalid.length === 1 ? '' : 's'} skipped`,
          {
            description: data.invalid
              .slice(0, 3)
              .map((v: { line: number; text: string; reason: string }) =>
                `line ${v.line}: ${v.reason}`
              )
              .join(' · '),
          }
        )
      }
      setEnvImportOpen(false)
      setEnvImportText('')
      setEnvImportName('')
      fetchEnvVars()
    } catch {
      toast.error('Network error during import')
    } finally {
      setEnvImporting(false)
    }
  }

  /** Recreate the container with the current variables — no image rebuild. */
  const handleApplyEnv = async () => {
    setEnvApplying(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/env/apply`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Could not apply the environment')
        return
      }
      if (data.needsRebuild?.length) {
        toast.success('Environment applied', {
          description: `${data.needsRebuild.length} NEXT_PUBLIC_* value${data.needsRebuild.length === 1 ? '' : 's'} are compiled into the browser bundle and still need a Redeploy.`,
        })
      } else {
        toast.success('Environment applied — the container was recreated.')
      }
      fetchEnvVars()
      fetchProject()
    } catch {
      toast.error('Network error while applying the environment')
    } finally {
      setEnvApplying(false)
    }
  }

  const handleSaveEnvVar = async () => {
    if (!envKey.trim()) {
      toast.error('Key is required')
      return
    }
    if (envDialogMode === 'create' && !envValue) {
      toast.error('Value is required')
      return
    }

    setEnvSaving(true)
    try {
      if (envDialogMode === 'create') {
        const res = await fetch(`/api/hosting/${projectId}/env`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ key: envKey.trim(), value: envValue, encrypted: envEncrypted }),
        })
        const data = await res.json()
        if (!res.ok) {
          toast.error(data.error || 'Failed to create env var')
          return
        }
        toast.success('Environment variable added')
      } else {
        const body: Record<string, unknown> = {}
        if (envKey.trim()) body.key = envKey.trim()
        if (envValue) body.value = envValue
        body.encrypted = envEncrypted

        const res = await fetch(`/api/hosting/${projectId}/env/${envEditId}`, {
          method: 'PATCH',
          headers: getAuthHeaders(),
          body: JSON.stringify(body),
        })
        const data = await res.json()
        if (!res.ok) {
          toast.error(data.error || 'Failed to update env var')
          return
        }
        toast.success('Environment variable updated')
      }
      setEnvDialogOpen(false)
      fetchEnvVars()
    } catch {
      toast.error('Network error')
    } finally {
      setEnvSaving(false)
    }
  }

  const handleDeleteEnvVar = async () => {
    if (!envDeleteId) return
    setEnvDeleting(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/env/${envDeleteId}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to delete env var')
        return
      }
      toast.success('Environment variable deleted')
      setEnvDeleteId(null)
      fetchEnvVars()
    } catch {
      toast.error('Network error')
    } finally {
      setEnvDeleting(false)
    }
  }

  const handleDeleteProject = async () => {
    setDeleting(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to delete project')
        return
      }
      toast.success('Website deleted')
      // The row is gone either way, but the container may have outlived it —
      // say so rather than reporting a clean delete.
      if (Array.isArray(data.warnings) && data.warnings.length > 0) {
        toast.warning('Some server-side cleanup could not be confirmed', {
          description: data.warnings.join(' · '),
        })
      }
      onRefresh()
      onBack()
    } catch {
      toast.error('Network error')
    } finally {
      setDeleting(false)
      setDeleteDialogOpen(false)
    }
  }

  if (loading && !project) {
    return (
      <div className="space-y-5" aria-busy="true" aria-label="Loading website">
        <Skeleton className="h-8 w-28" />
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-48" />
        </div>
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  if (!project) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ms-2 text-muted-foreground">
          <ArrowLeft className="size-4" aria-hidden />
          All websites
        </Button>
        <InlineError
          title="This website could not be opened"
          message={loadError}
          onRetry={() => {
            setLoading(true)
            fetchProject()
          }}
        />
      </div>
    )
  }

  // ── Container action handlers (VPS-UI) ────────────────────────────────
  const handleContainerRestart = async () => {
    setContainerActionLoading(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/container/restart`, {
        method: 'POST',
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to restart container')
        return
      }
      toast.success(data.message || 'Container restarted')
      fetchContainerInfo()
    } catch {
      toast.error('Network error')
    } finally {
      setContainerActionLoading(false)
    }
  }

  const handleContainerStop = async () => {
    setContainerActionLoading(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/container/stop`, {
        method: 'POST',
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to stop container')
        return
      }
      toast.success(data.message || 'Container stopped')
      fetchContainerInfo()
      onRefresh()
    } catch {
      toast.error('Network error')
    } finally {
      setContainerActionLoading(false)
    }
  }

  const handleFetchContainerLogs = async (tail: number) => {
    setContainerLogsLoading(true)
    try {
      const res = await fetch(
        `/api/hosting/${projectId}/container/logs?tail=${tail}`,
        { headers: getAuthHeaders() }
      )
      const data = await res.json()
      if (res.ok) {
        setContainerLogs(data.logs || 'No logs available')
      } else {
        setContainerLogs(`Error: ${data.error || 'Failed to fetch logs'}`)
      }
    } catch {
      setContainerLogs('Network error fetching logs')
    } finally {
      setContainerLogsLoading(false)
    }
  }

  const handleOpenContainerLogs = () => {
    setContainerLogsOpen(true)
    handleFetchContainerLogs(logTail)
  }

  const handleSslRenew = async () => {
    setSslActionLoading(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/ssl`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ action: 'renew' }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'SSL renewal failed')
        return
      }
      toast.success(data.message || 'SSL certificate renewal triggered')
      fetchSslInfo()
    } catch {
      toast.error('Network error')
    } finally {
      setSslActionLoading(false)
    }
  }

  const handleSslToggle = async (enabled: boolean) => {
    setSslActionLoading(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/ssl`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ action: 'toggle', enabled }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to toggle SSL')
        return
      }
      toast.success(data.message || `SSL ${enabled ? 'enabled' : 'disabled'}`)
      fetchSslInfo()
      fetchProject()
    } catch {
      toast.error('Network error')
    } finally {
      setSslActionLoading(false)
    }
  }

  const kind = siteKind(project)
  const areas = areasFor(kind)
  const meaning = describeSiteStatus({
    status: project.status,
    deploymentSource: project.deploymentSource,
    lastDeployment: project.deployments[0] ?? null,
  })
  const tone = TONE_CLASSES[meaning.tone]
  const primaryDomain =
    project.websiteDomains?.find((d) => d.isPrimary)?.domain || project.customDomain || project.subdomain
  const liveUrl = `https://${primaryDomain}`
  const latestDeployment = project.deployments[0] ?? null
  const canDeploy = project.access?.canDeploy !== false
  const isStagingCopy = project.environment === 'staging'
  const advancedSections = ADVANCED_SECTIONS

  const runStatusAction = () => {
    if (meaning.action === 'view-deploy-log' && latestDeployment) handleViewLogs(latestDeployment)
    else if (meaning.action === 'open-import') goTo('backups', undefined, 'import')
    else if (meaning.action === 'redeploy') handleDeploy()
  }

  return (
    <div className="space-y-5">
      {/* Back to the website list */}
      <Button variant="ghost" size="sm" onClick={onBack} className="-ms-2 text-muted-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        All websites
      </Button>

      {isStagingCopy && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100" role="note">
          <FlaskConical className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">This is a <strong>staging</strong> copy. Changes here don’t affect your live site until you push them from the live site’s Backups → Staging section.</span>
          {project.parentProjectId && onOpenProject && (
            <Button size="sm" variant="outline" onClick={() => onOpenProject(project.parentProjectId!)}>
              Open live site
            </Button>
          )}
        </div>
      )}

      {/* ── Site header: name, live URL, plain-language status, primary actions ── */}
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 className="truncate text-2xl font-semibold tracking-tight">{project.name}</h2>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone.badge}`}>
              <span className={`size-1.5 rounded-full ${tone.dot}`} aria-hidden />
              {meaning.label}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <a
              href={liveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-mono text-[13px] text-foreground/80 underline-offset-4 hover:text-primary hover:underline"
            >
              {primaryDomain}
              <ExternalLink className="size-3" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            {primaryDomain !== project.subdomain && (
              <span className="font-mono text-xs">also {project.subdomain}</span>
            )}
            <span className="text-xs">{kind === 'wordpress' ? 'WordPress' : frameworkLabel(project.framework)}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" asChild>
            <a href={liveUrl} target="_blank" rel="noopener noreferrer">
              <Globe aria-hidden />
              Visit site
            </a>
          </Button>
          {kind === 'wordpress' && (
            <Button variant="outline" asChild>
              <a href={`${liveUrl}/wp-admin/`} target="_blank" rel="noopener noreferrer">
                <LayoutDashboard aria-hidden />
                WordPress admin
              </a>
            </Button>
          )}
          <Button
            onClick={handleDeploy}
            // The API accepts running | stopped | error | creating | building |
            // deploying and refuses a genuine overlap with 409.
            disabled={deploying || project.status === 'deleting' || !canDeploy}
            title={!canDeploy ? 'Your team role cannot deploy this website' : undefined}
          >
            {deploying ? <RefreshCw className="animate-spin" aria-hidden /> : <Rocket aria-hidden />}
            {project.lastDeployment ? 'Redeploy' : 'Deploy'}
          </Button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More website actions">
                <MoreVertical aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={handleContainerRestart} disabled={containerActionLoading || !containerInfo?.container}>
                <RotateCcw aria-hidden /> Restart site
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={handleContainerStop}
                disabled={containerActionLoading || containerInfo?.container?.state !== 'running'}
              >
                <StopCircle aria-hidden /> Stop site
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => goTo('advanced', 'container')}>
                <Terminal aria-hidden /> View live logs
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {project.access?.isOwner !== false ? (
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleteDialogOpen(true)}>
                  <Trash2 aria-hidden /> Delete website…
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem disabled>Only the owner can delete this website</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {meaning.detail && (
        <div role="status" className={`flex flex-col gap-3 rounded-lg border px-4 py-3 text-sm sm:flex-row sm:items-center ${tone.banner}`}>
          {meaning.tone === 'danger' || meaning.tone === 'warning' ? (
            <AlertTriangle className="size-4 shrink-0" aria-hidden />
          ) : meaning.tone === 'progress' ? (
            <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <StopCircle className="size-4 shrink-0" aria-hidden />
          )}
          <p className="flex-1">{meaning.detail}</p>
          {meaning.action && meaning.actionLabel && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 bg-background"
              onClick={runStatusAction}
              disabled={meaning.action === 'redeploy' && (deploying || !canDeploy)}
            >
              {meaning.actionLabel}
            </Button>
          )}
        </div>
      )}

      {/* ── Areas (real tabs; only the active one is rendered) ── */}
      <Tabs value={loc.area} onValueChange={(v) => goTo(v as AreaId)} className="gap-5">
        <div className="sticky top-0 z-20 -mx-4 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
          <TabsList
            aria-label="Website management"
            className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-none bg-transparent p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {areas.map((a) => (
              <TabsTrigger
                key={a.id}
                value={a.id}
                className="relative h-11 flex-none rounded-none border-0 px-3 text-sm font-medium text-muted-foreground shadow-none after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent hover:text-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:after:bg-primary dark:data-[state=active]:bg-transparent dark:data-[state=active]:border-0 focus-visible:rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                {a.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="overview" className="space-y-6">
          <SiteOverview
            project={project}
            kind={kind}
            primaryDomain={primaryDomain}
            liveUrl={liveUrl}
            sslInfo={sslInfo}
            sslLoading={sslLoading}
            latestDeployment={latestDeployment}
            onViewDeployLog={handleViewLogs}
            onNavigate={goTo}
          />
        </TabsContent>

        {kind === 'wordpress' && (
          <TabsContent value="wordpress">
            <section id="wordpress"><WordPressTab projectId={project.id} /></section>
          </TabsContent>
        )}
        {kind === 'apptools' && (
          <TabsContent value="apptools">
            <section id="apptools"><AppToolsTab projectId={project.id} /></section>
          </TabsContent>
        )}

        <TabsContent value="files" className="space-y-6">
          <section id="files"><FilesTab projectId={project.id} /></section>
          <LazySection id="sftp"><SftpTab projectId={project.id} /></LazySection>
        </TabsContent>

        <TabsContent value="domains" className="space-y-6">
          <section id="domains"><DomainsTab projectId={project.id} onProjectChanged={fetchProject} /></section>
      {/* SSL Certificate (VPS-UI) */}
      <Card id="ssl" className="scroll-mt-32">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <Shield className="size-5 text-indigo-600" />
                SSL Certificate
              </CardTitle>
              <CardDescription className="mt-1">
                HTTPS certificate status &amp; renewal
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => fetchSslInfo()}
              disabled={sslLoading}
            >
              <RefreshCw className={`size-3.5 me-1 ${sslLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {sslLoading && !sslInfo ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !sslInfo ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              <Shield className="size-8 mx-auto mb-2 opacity-30" />
              Failed to load SSL info
            </div>
          ) : (
            (() => {
              const cert = sslInfo.cert
              const status = cert?.status ?? (sslInfo.sslEnabled ? 'issued' : 'none')
              const statusMap: Record<string, { className: string; pulse?: boolean }> = {
                issued: {
                  className: 'bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400',
                },
                pending: {
                  className: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400',
                  pulse: true,
                },
                failed: {
                  className: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-400',
                },
                renewing: {
                  className: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400',
                  pulse: true,
                },
                none: {
                  className: 'bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800/30 dark:text-gray-400',
                },
              }
              const sCfg = statusMap[status] || statusMap.none
              const days = cert?.daysUntilExpiry
              const expiryColor =
                days == null
                  ? 'text-muted-foreground'
                  : days < 0
                    ? 'text-red-600'
                    : days < 7
                      ? 'text-red-600 font-medium'
                      : days < 30
                        ? 'text-amber-600 font-medium'
                        : 'text-indigo-600'

              return (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 flex-wrap">
                    <Badge variant="outline" className={sCfg.className}>
                      {sCfg.pulse && (
                        <span className="size-1.5 rounded-full bg-current me-1.5 animate-pulse" />
                      )}
                      SSL: {status}
                    </Badge>
                    <span className="text-xs text-muted-foreground font-mono">
                      {sslInfo.hostname}
                    </span>
                  </div>

                  {!sslInfo.sslEnabled ? (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-900/10 p-4 text-sm">
                      <p className="font-medium text-amber-700 dark:text-amber-400">
                        SSL is currently disabled for this project.
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Enabling SSL will request a free Let&apos;s Encrypt
                        certificate automatically via Caddy.
                      </p>
                      <Button
                        size="sm"
                        onClick={() => handleSslToggle(true)}
                        disabled={sslActionLoading}
                        className="mt-3 bg-indigo-600 hover:bg-indigo-700 text-white h-8 text-xs"
                      >
                        {sslActionLoading ? (
                          <Loader2 className="size-3.5 me-1 animate-spin" />
                        ) : (
                          <Lock className="size-3.5 me-1" />
                        )}
                        Enable SSL
                      </Button>
                    </div>
                  ) : cert ? (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                            <Network className="size-3" />
                            Hostname
                          </span>
                          <span className="font-mono text-sm">{cert.hostname}</span>
                        </div>
                        <div className="space-y-1">
                          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                            <Shield className="size-3" />
                            Issuer
                          </span>
                          <span className="text-sm">{cert.issuer || '—'}</span>
                        </div>
                        <div className="space-y-1">
                          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                            <Calendar className="size-3" />
                            Issued
                          </span>
                          <span className="text-xs">
                            {cert.issuedAt ? formatDate(cert.issuedAt) : '—'}
                          </span>
                        </div>
                        <div className="space-y-1">
                          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                            <Calendar className="size-3" />
                            Expires
                          </span>
                          <span className={`text-xs ${expiryColor}`}>
                            {cert.expiresAt ? formatDate(cert.expiresAt) : '—'}
                            {days != null && (
                              <span className="ms-1 opacity-80">
                                ({days < 0 ? `expired ${-days}d ago` : `${days}d left`})
                              </span>
                            )}
                          </span>
                        </div>
                      </div>

                      {cert.sans.length > 0 && (
                        <div className="space-y-1">
                          <span className="text-xs text-muted-foreground">SANs</span>
                          <div className="flex flex-wrap gap-1">
                            {cert.sans.map((s, i) => (
                              <span
                                key={i}
                                className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded"
                              >
                                {s}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-2 flex-wrap pt-2 border-t">
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={sslInfo.sslEnabled}
                            onCheckedChange={(v) => handleSslToggle(v)}
                            disabled={sslActionLoading}
                          />
                          <span className="text-xs text-muted-foreground">
                            SSL {sslInfo.sslEnabled ? 'Enabled' : 'Disabled'}
                          </span>
                          {cert.autoRenew && (
                            <Badge variant="outline" className="text-[10px] h-5 bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/20 dark:text-indigo-400">
                              Auto-renew
                            </Badge>
                          )}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 text-xs"
                          onClick={handleSslRenew}
                          disabled={sslActionLoading}
                        >
                          {sslActionLoading ? (
                            <Loader2 className="size-3.5 me-1 animate-spin" />
                          ) : (
                            <RefreshCw className="size-3.5 me-1" />
                          )}
                          Renew Certificate
                        </Button>
                      </div>
                    </>
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      SSL is enabled but no certificate info is available yet.
                    </div>
                  )}
                </div>
              )
            })()
          )}
        </CardContent>
      </Card>
          <LazySection id="redirects"><RedirectsTab projectId={project.id} /></LazySection>
          <LazySection id="cdn"><CdnTab projectId={project.id} /></LazySection>
        </TabsContent>

        <TabsContent value="email" className="space-y-6">
          <section id="email" className="space-y-6">
            <EmailTab projectId={project.id} />
            {/* Native management over Mailcow: aliases, forwarding, catch-all,
                spam policy, quarantine and activity logs. */}
            <EmailManagement projectId={project.id} />
          </section>
        </TabsContent>

        <TabsContent value="databases">
          <section id="databases"><DatabaseTab projectId={project.id} /></section>
        </TabsContent>

        <TabsContent value="backups" className="space-y-6">
          <section id="backups"><BackupsTab projectId={project.id} /></section>
          {!isStagingCopy && (
            <LazySection id="staging"><StagingTab projectId={project.id} onOpenProject={onOpenProject} /></LazySection>
          )}
          {/* Importing into an existing website replaces its files and database,
              so it lives beside Backups: one click from taking a backup first. */}
          <LazySection id="import">
            <Card>
              <CardContent className="pt-6">
                <ImportDashboard projectId={project.id} projectName={project.name} />
              </CardContent>
            </Card>
          </LazySection>
        </TabsContent>

        <TabsContent value="advanced">
          <Tabs
            value={loc.advanced}
            onValueChange={(v) => goTo('advanced', v as AdvancedId)}
            orientation="vertical"
            className="gap-5 md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:items-start"
          >
            <TabsList
              aria-label="Advanced tools"
              className="h-auto w-full justify-start gap-1 overflow-x-auto bg-transparent p-0 [scrollbar-width:none] md:sticky md:top-16 md:flex-col md:items-stretch md:overflow-visible [&::-webkit-scrollbar]:hidden"
            >
              {advancedSections.map((s) => (
                <TabsTrigger
                  key={s.id}
                  value={s.id}
                  className="h-auto flex-none justify-start rounded-md border border-transparent px-3 py-1.5 text-start text-sm font-medium text-muted-foreground shadow-none hover:bg-muted hover:text-foreground data-[state=active]:border-border data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-xs md:flex-col md:items-start md:gap-0 md:py-2"
                >
                  <span>{s.label}</span>
                  <span className="hidden text-xs font-normal text-muted-foreground md:block">{s.description}</span>
                </TabsTrigger>
              ))}
            </TabsList>

            <div className="min-w-0">
              <TabsContent value="deployments" className="space-y-6">
      {/* Deployment History */}
      <Card id="deployments" className="scroll-mt-32">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Rocket className="size-5 text-indigo-600" />
            Deployment History
          </CardTitle>
          <CardDescription>Recent deployments for this project</CardDescription>
        </CardHeader>
        <CardContent>
          {project.deployments.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Rocket className="size-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No deployments yet</p>
              <p className="text-xs mt-1">Click &ldquo;Deploy&rdquo; to trigger your first deployment</p>
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Commit</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead className="text-end">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {project.deployments.map((dep) => (
                    <TableRow key={dep.id} className="hover:bg-indigo-50/50 dark:hover:bg-indigo-950/20 transition-colors">
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {deployStatusIcon(dep.status)}
                          <Badge variant="outline" className={statusColor(dep.status)}>
                            {dep.status}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {dep.commit ? dep.commit.substring(0, 8) : 'Initial deploy'}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 text-xs">
                          <GitBranch className="size-3 text-muted-foreground" />
                          {dep.branch}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        {dep.duration ? `${dep.duration}s` : '—'}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {timeAgo(dep.createdAt)}
                      </TableCell>
                      <TableCell className="text-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs hover:text-indigo-600"
                          onClick={() => handleViewLogs(dep)}
                        >
                          <Terminal className="size-3 me-1" />
                          View Logs
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      {/* GitHub Integration */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <Github className="size-5 text-indigo-600" />
                GitHub Integration
              </CardTitle>
              <CardDescription className="mt-1">
                Connect your repository for auto-deployments
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {githubLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !githubIntegration ? (
            <div className="text-center py-10 text-muted-foreground">
              <Github className="size-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-medium">No repository connected</p>
              <p className="text-xs mt-1">Connect a GitHub repository to enable auto-deployments</p>
              <Button
                size="sm"
                onClick={() => setConnectDialogOpen(true)}
                className="mt-4 bg-indigo-600 hover:bg-indigo-700 text-white h-8 text-xs"
              >
                <Github className="size-3.5 me-1" />
                Connect GitHub
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                <div className="size-10 rounded-lg bg-gray-900 dark:bg-gray-100 flex items-center justify-center">
                  <Github className="size-5 text-white dark:text-gray-900" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{githubIntegration.repoFullName}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <Badge variant="outline" className="text-[10px] h-5">
                      <GitBranch className="size-3 me-1" />
                      {githubIntegration.branch}
                    </Badge>
                    {githubIntegration.autoDeploy && (
                      <Badge className="bg-indigo-50 text-indigo-700 border-indigo-200 text-[10px] h-5">
                        Auto-deploy
                      </Badge>
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => window.open(githubIntegration.repoUrl, '_blank')}
                >
                  <ExternalLink className="size-3.5 me-1" />
                  Open
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={async () => {
                    setCommitsDialogOpen(true)
                    setCommitsLoading(true)
                    try {
                      const res = await fetch(`/api/github/${githubIntegration.id}/commits`, {
                        headers: getAuthHeaders(),
                      })
                      const data = await res.json()
                      if (res.ok) {
                        setCommits(data.commits || [])
                      } else {
                        toast.error('Failed to load commits')
                      }
                    } catch {
                      toast.error('Failed to load commits')
                    } finally {
                      setCommitsLoading(false)
                    }
                  }}
                >
                  <GitCommit className="size-3.5 me-1" />
                  Commit History
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  disabled={redeploying}
                  onClick={async () => {
                    setRedeploying(true)
                    try {
                      const res = await fetch(`/api/hosting/${projectId}/deploy`, {
                        method: 'POST',
                        headers: getAuthHeaders(),
                        body: JSON.stringify({}),
                      })
                      const data = await res.json()
                      if (res.ok) {
                        toast.success('Redeployment triggered!')
                        fetchProject()
                      } else {
                        toast.error(data.error || 'Redeploy failed')
                      }
                    } catch {
                      toast.error('Redeploy failed')
                    } finally {
                      setRedeploying(false)
                    }
                  }}
                >
                  {redeploying ? <Loader2 className="size-3.5 me-1 animate-spin" /> : <RefreshCw className="size-3.5 me-1" />}
                  Trigger Redeploy
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20"
                  onClick={() => setDisconnectDialogOpen(true)}
                >
                  <Unplug className="size-3.5 me-1" />
                  Disconnect
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
              </TabsContent>
              <TabsContent value="environment">
      {/* Environment Variables */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <Key className="size-5 text-indigo-600" />
                Environment Variables
                <Badge variant="outline" className="ms-1 bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/20 dark:text-indigo-400 dark:border-indigo-900/50 text-[10px] h-5">
                  <Lock className="size-3 me-1" />
                  AES-256
                </Badge>
              </CardTitle>
              <CardDescription className="mt-1">
                Manage environment variables for your project. Values are encrypted at rest.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEnvReveal(!envReveal)}
                className="h-8 text-xs"
              >
                {envReveal ? (
                  <>
                    <EyeOff className="size-3.5 me-1" />
                    Hide
                  </>
                ) : (
                  <>
                    <Eye className="size-3.5 me-1" />
                    Reveal
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEnvImportOpen(true)}
                className="h-8 text-xs"
              >
                <Upload className="size-3.5 me-1" />
                Import .env
              </Button>
              <Button
                size="sm"
                onClick={() => handleOpenEnvDialog('create')}
                className="bg-indigo-600 hover:bg-indigo-700 text-white h-8 text-xs"
              >
                <Plus className="size-3.5 me-1" />
                Add Variable
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {envDrift?.pending && (
            <div className="mb-4 flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/20 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <div>
                  <p className="font-medium text-amber-900 dark:text-amber-200">
                    {envDrift.keys.length} variable{envDrift.keys.length === 1 ? '' : 's'} not yet in the running container
                  </p>
                  <p className="mt-0.5 text-xs text-amber-800/80 dark:text-amber-200/70">
                    Variables reach the app only when its container is recreated.
                    {envDrift.needsRebuild.length > 0 && (
                      <>
                        {' '}
                        {envDrift.needsRebuild.length} of them start with{' '}
                        <span className="font-mono">NEXT_PUBLIC_</span> and are
                        compiled into the browser bundle — those need a full
                        Redeploy.
                      </>
                    )}
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-amber-800/70 dark:text-amber-200/60">
                    {envDrift.keys.slice(0, 6).join(', ')}
                    {envDrift.keys.length > 6 ? ` +${envDrift.keys.length - 6} more` : ''}
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                onClick={handleApplyEnv}
                disabled={envApplying}
                className="h-8 shrink-0 bg-amber-600 text-white hover:bg-amber-700 text-xs"
              >
                {envApplying ? (
                  <>
                    <Loader2 className="size-3.5 me-1 animate-spin" />
                    Applying…
                  </>
                ) : (
                  <>
                    <RefreshCw className="size-3.5 me-1" />
                    Apply now
                  </>
                )}
              </Button>
            </div>
          )}
          {envError && !envLoading ? (
            <InlineError title="Could not load environment variables" message={envError} onRetry={fetchEnvVars} />
          ) : envLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : envVars.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              <Key className="size-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-medium">No environment variables</p>
              <p className="text-xs mt-1">Add environment variables to configure your application</p>
              <Button
                size="sm"
                onClick={() => handleOpenEnvDialog('create')}
                className="mt-4 bg-indigo-600 hover:bg-indigo-700 text-white h-8 text-xs"
              >
                <Plus className="size-3.5 me-1" />
                Add Your First Variable
              </Button>
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Key</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-end">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {envVars.map((ev) => (
                    <TableRow key={ev.id} className="hover:bg-indigo-50/50 dark:hover:bg-indigo-950/20 transition-colors">
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Key className="size-3.5 text-muted-foreground" />
                          <span className="font-mono text-sm font-medium">{ev.key}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-sm text-muted-foreground">
                          {ev.value}
                        </span>
                      </TableCell>
                      <TableCell>
                        {ev.encrypted ? (
                          <Badge variant="outline" className="bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 text-xs">
                            <Lock className="size-3 me-1" />
                            Encrypted
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="bg-gray-50 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400 text-xs">
                            Plain
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-end">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs hover:text-indigo-600"
                            onClick={() => handleOpenEnvDialog('edit', ev)}
                          >
                            <Edit className="size-3 me-1" />
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20"
                            onClick={() => setEnvDeleteId(ev.id)}
                          >
                            <Trash2 className="size-3 me-1" />
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
      </Card>
              </TabsContent>
              <TabsContent value="container">
      {/* Container Status (VPS-UI) */}
      <Card id="container" className="scroll-mt-32">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <Container className="size-5 text-indigo-600" />
                Container Status
              </CardTitle>
              <CardDescription className="mt-1">
                Live Docker container running this project
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => fetchContainerInfo()}
              disabled={containerLoading}
            >
              <RefreshCw className={`size-3.5 me-1 ${containerLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {containerLoading && !containerInfo ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !containerInfo?.container ? (
            <div className="text-center py-10 text-muted-foreground">
              <Container className="size-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-medium">No container running</p>
              <p className="text-xs mt-1">
                Deploy this project to start a container on the assigned server.
              </p>
              <Button
                size="sm"
                onClick={handleDeploy}
                disabled={deploying || project.status === 'deleting'}
                className="mt-4 bg-indigo-600 hover:bg-indigo-700 text-white h-8 text-xs"
              >
                {deploying ? (
                  <Loader2 className="size-3.5 me-1 animate-spin" />
                ) : (
                  <Rocket className="size-3.5 me-1" />
                )}
                Deploy now
              </Button>
            </div>
          ) : (
            (() => {
              const c = containerInfo.container
              const isRunning = c.state === 'running'
              const stateColor =
                c.state === 'running'
                  ? 'bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400'
                  : c.state === 'paused'
                    ? 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400'
                    : 'bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800/30 dark:text-gray-400'
              return (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground w-20">Name</span>
                        <span className="font-mono text-sm truncate">{c.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground w-20">Container ID</span>
                        <span className="font-mono text-xs text-muted-foreground truncate">
                          {c.containerId ? c.containerId.substring(0, 12) : '—'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground w-20">Image</span>
                        <span className="font-mono text-xs truncate">{c.image || '—'}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground w-20">Created</span>
                        <span className="text-xs">
                          {c.createdAt ? formatDate(c.createdAt) : '—'}
                        </span>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground w-20">State</span>
                        <Badge variant="outline" className={stateColor}>
                          {isRunning && (
                            <span className="size-1.5 rounded-full bg-indigo-500 me-1.5 animate-pulse" />
                          )}
                          {c.state}
                        </Badge>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-xs text-muted-foreground w-20 shrink-0">Status</span>
                        <span className="text-xs">{c.status || '—'}</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-xs text-muted-foreground w-20 shrink-0">Ports</span>
                        <div className="flex flex-wrap gap-1 min-w-0">
                          {c.ports.length === 0 ? (
                            <span className="text-xs text-muted-foreground">No published ports</span>
                          ) : (
                            c.ports.map((p, i) => (
                              <span
                                key={i}
                                className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded break-all"
                              >
                                {p}
                              </span>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-2 border-t">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={handleContainerRestart}
                      disabled={containerActionLoading}
                    >
                      {containerActionLoading ? (
                        <Loader2 className="size-3.5 me-1 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3.5 me-1" />
                      )}
                      Restart
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={handleContainerStop}
                      disabled={containerActionLoading || !isRunning}
                    >
                      <Square className="size-3.5 me-1" />
                      Stop
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={handleOpenContainerLogs}
                    >
                      <Terminal className="size-3.5 me-1" />
                      View Logs
                    </Button>
                  </div>
                </div>
              )
            })()
          )}
        </CardContent>
      </Card>
              </TabsContent>
              <TabsContent value="terminal">
                <section id="terminal"><TerminalTab projectId={project.id} /></section>
              </TabsContent>
              <TabsContent value="cron">
                <section id="cron"><CronTab projectId={project.id} /></section>
              </TabsContent>
              <TabsContent value="resources">
                <section id="resources"><ResourcesTab projectId={project.id} /></section>
              </TabsContent>
              <TabsContent value="security">
                <section id="security"><SecurityTab projectId={project.id} /></section>
              </TabsContent>
              <TabsContent value="settings" className="space-y-6">
      {/* Settings */}
      <Card id="settings" className="scroll-mt-32">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Settings className="size-5 text-indigo-600" />
            Settings
          </CardTitle>
          <CardDescription>Configure your project settings</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Auto-deploy toggle */}
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label className="text-base">Auto-deploy</Label>
                <p className="text-xs text-muted-foreground">
                  Automatically deploy when changes are pushed to the linked repository
                </p>
              </div>
              <Switch
                checked={settingsAutoDeploy}
                onCheckedChange={setSettingsAutoDeploy}
              />
            </div>

            {/* SSL toggle */}
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label className="text-base">SSL</Label>
                <p className="text-xs text-muted-foreground">
                  Enable HTTPS with automatic SSL certificate provisioning
                </p>
              </div>
              <Switch
                checked={settingsSsl}
                onCheckedChange={setSettingsSsl}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* GitHub repo URL */}
            <div className="space-y-2">
              <Label htmlFor="repo-url">GitHub Repository URL</Label>
              <Input
                id="repo-url"
                placeholder="https://github.com/user/repo"
                value={settingsRepoUrl}
                onChange={(e) => setSettingsRepoUrl(e.target.value)}
                className="font-mono text-sm"
              />
            </div>

            {/* Custom domain */}
            <div className="space-y-2">
              <Label htmlFor="custom-domain">Custom Domain</Label>
              <Input
                id="custom-domain"
                placeholder="www.myapp.com"
                value={settingsCustomDomain}
                onChange={(e) => setSettingsCustomDomain(e.target.value)}
                className="font-mono text-sm"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              onClick={handleSaveSettings}
              disabled={savingSettings}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              {savingSettings ? (
                <>
                  <Loader2 className="size-4 me-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="size-4 me-2" />
                  Save Changes
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
      {/* Danger Zone */}
      <Card className="border-red-200 dark:border-red-900/50">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2 text-red-600 dark:text-red-400">
            <AlertTriangle className="size-5" />
            Danger Zone
          </CardTitle>
          <CardDescription>
            Irreversible and destructive actions
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 rounded-lg border border-red-200 dark:border-red-900/50 p-4 bg-red-50/50 dark:bg-red-950/10">
            <div>
              <p className="font-medium text-sm">Delete this website</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Once you delete a website, there is no going back. All deployments and data will be permanently removed.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDeleteDialogOpen(true)}
              disabled={project.access?.isOwner === false}
              title={project.access?.isOwner === false ? 'Only the website owner can delete it' : undefined}
            >
              <Trash2 className="size-4 me-2" />
              Delete website
            </Button>
          </div>
        </CardContent>
      </Card>
              </TabsContent>
            </div>
          </Tabs>
        </TabsContent>
      </Tabs>

      {/* Connect GitHub Dialog */}
      <Dialog open={connectDialogOpen} onOpenChange={(v) => !v && setConnectDialogOpen(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Github className="size-5 text-indigo-600" />
              Connect GitHub Repository
            </DialogTitle>
            <DialogDescription>
              Link a GitHub repository to enable automatic deployments.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="gh-repo-url">Repository URL</Label>
              <Input
                id="gh-repo-url"
                placeholder="https://github.com/user/repo"
                value={connectRepoUrl}
                onChange={(e) => setConnectRepoUrl(e.target.value)}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">Enter the full URL of your GitHub repository</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="gh-branch">Branch</Label>
              <Input
                id="gh-branch"
                placeholder="main"
                value={connectBranch}
                onChange={(e) => setConnectBranch(e.target.value)}
                className="font-mono text-sm"
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label className="text-base flex items-center gap-2">
                  <RefreshCw className="size-4 text-indigo-600" />
                  Auto-deploy
                </Label>
                <p className="text-xs text-muted-foreground">
                  Automatically deploy when changes are pushed to the branch
                </p>
              </div>
              <Switch
                checked={connectAutoDeploy}
                onCheckedChange={setConnectAutoDeploy}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConnectDialogOpen(false)} disabled={connecting}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                if (!connectRepoUrl.trim()) {
                  toast.error('Repository URL is required')
                  return
                }
                setConnecting(true)
                try {
                  const res = await fetch('/api/github/connect', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({
                      projectId,
                      repoUrl: connectRepoUrl,
                      branch: connectBranch || 'main',
                    }),
                  })
                  const data = await res.json()
                  if (!res.ok) {
                    toast.error(data.error || 'Failed to connect')
                    return
                  }
                  setGithubIntegration(data.integration)
                  setConnectDialogOpen(false)
                  setConnectRepoUrl('')
                  setConnectBranch('main')
                  setConnectAutoDeploy(true)
                  toast.success('GitHub repository connected!')
                } catch {
                  toast.error('Failed to connect')
                } finally {
                  setConnecting(false)
                }
              }}
              disabled={connecting || !connectRepoUrl.trim()}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              {connecting ? (
                <>
                  <Loader2 className="size-4 me-2 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <Github className="size-4 me-2" />
                  Connect
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Commit History Dialog */}
      <Dialog open={commitsDialogOpen} onOpenChange={(v) => !v && setCommitsDialogOpen(false)}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitCommit className="size-5 text-indigo-600" />
              Commit History
            </DialogTitle>
            <DialogDescription>
              {githubIntegration ? `${githubIntegration.repoFullName} · ${githubIntegration.branch}` : 'Recent commits'}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
            {commitsLoading ? (
              <div className="space-y-3 p-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : commits.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <GitCommit className="size-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No commits found</p>
              </div>
            ) : (
              <div className="space-y-0">
                {commits.map((commit) => (
                  <div
                    key={commit.sha}
                    className="flex items-start gap-3 py-3 border-b last:border-b-0 hover:bg-muted/30 transition-colors px-2 rounded"
                  >
                    <div className="size-8 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-xs font-medium text-muted-foreground">
                        {commit.author.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{commit.message}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-muted-foreground">{commit.author}</span>
                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="text-xs text-muted-foreground">{timeAgo(commit.date)}</span>
                      </div>
                    </div>
                    <code className="text-[10px] font-mono text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20 px-1.5 py-0.5 rounded shrink-0">
                      {commit.shortSha}
                    </code>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Disconnect GitHub Confirmation */}
      <AlertDialog open={disconnectDialogOpen} onOpenChange={setDisconnectDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Unplug className="size-5 text-red-500" />
              Disconnect GitHub
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to disconnect <strong>{githubIntegration?.repoFullName}</strong>? Auto-deployments will stop and the webhook will be removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnecting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                setDisconnecting(true)
                try {
                  const res = await fetch('/api/github/disconnect', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ projectId }),
                  })
                  const data = await res.json()
                  if (!res.ok) {
                    toast.error(data.error || 'Failed to disconnect')
                    return
                  }
                  setGithubIntegration(null)
                  setDisconnectDialogOpen(false)
                  toast.success('GitHub repository disconnected')
                } catch {
                  toast.error('Failed to disconnect')
                } finally {
                  setDisconnecting(false)
                }
              }}
              disabled={disconnecting}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {disconnecting ? (
                <>
                  <Loader2 className="size-4 me-2 animate-spin" />
                  Disconnecting...
                </>
              ) : (
                <>
                  <Unplug className="size-4 me-2" />
                  Disconnect
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Build Logs Dialog */}
      <BuildLogsDialog
        open={logsDialogOpen}
        onClose={() => {
          setLogsDialogOpen(false)
          setSelectedDeployment(null)
          setLogContent('')
        }}
        logContent={logContent}
        deployment={selectedDeployment}
        project={project}
        loading={logLoading}
      />

      {/* Container Logs Dialog (VPS-UI) */}
      <ContainerLogsDialog
        open={containerLogsOpen}
        onClose={() => setContainerLogsOpen(false)}
        logs={containerLogs}
        loading={containerLogsLoading}
        tail={logTail}
        onTailChange={(t) => {
          setLogTail(t)
          handleFetchContainerLogs(t)
        }}
        onRefresh={() => handleFetchContainerLogs(logTail)}
        containerName={containerInfo?.container?.name || project.name}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-red-500" />
              Delete website
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{project.name}</strong>? This action cannot be undone. The container, deployment history, databases, backups, and environment variables will be permanently removed. Domains you own stay in your account and are simply detached from this site.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteProject}
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
                  Delete website
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk .env import */}
      <Dialog open={envImportOpen} onOpenChange={(v) => !v && setEnvImportOpen(false)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="size-5 text-indigo-600" />
              Import from .env
            </DialogTitle>
            <DialogDescription>
              Upload a .env file or paste its contents. Values are encrypted at rest,
              exactly as with variables added one at a time.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="env-file">Choose a file</Label>
              <Input
                id="env-file"
                type="file"
                accept=".env,.txt,text/plain"
                onChange={(e) => handleEnvFile(e.target.files?.[0])}
                className="text-sm"
              />
              {envImportName && (
                <p className="text-xs text-muted-foreground">
                  Loaded <span className="font-mono">{envImportName}</span> — review below
                  before importing.
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="env-paste">…or paste</Label>
              <textarea
                id="env-paste"
                value={envImportText}
                onChange={(e) => setEnvImportText(e.target.value)}
                spellCheck={false}
                rows={9}
                placeholder={'DATABASE_URL=postgres://user:pass@host/db\nJWT_SECRET=…\nCRON_SECRET=…'}
                className="w-full rounded-md border bg-background p-2.5 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p className="text-xs text-muted-foreground">
                Comments, blank lines and <span className="font-mono">export</span> prefixes
                are handled. Quoted values keep their spaces and <span className="font-mono">#</span>.
              </p>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={envImportOverwrite}
                onChange={(e) => setEnvImportOverwrite(e.target.checked)}
                className="size-4 rounded border-input"
              />
              Overwrite variables that already exist
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEnvImportOpen(false)} disabled={envImporting}>
              Cancel
            </Button>
            <Button
              onClick={handleImportEnv}
              disabled={envImporting || !envImportText.trim()}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              {envImporting ? (
                <>
                  <Loader2 className="size-4 me-1.5 animate-spin" />
                  Importing…
                </>
              ) : (
                <>
                  <Upload className="size-4 me-1.5" />
                  Import
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Environment Variable Dialog */}
      <Dialog open={envDialogOpen} onOpenChange={(v) => !v && setEnvDialogOpen(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Key className="size-5 text-indigo-600" />
              {envDialogMode === 'create' ? 'Add Environment Variable' : 'Edit Environment Variable'}
            </DialogTitle>
            <DialogDescription>
              {envDialogMode === 'create'
                ? 'Add a new environment variable to your project.'
                : 'Update the environment variable. Leave value blank to keep the existing value.'}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="env-key">Key</Label>
              <Input
                id="env-key"
                placeholder="DATABASE_URL"
                value={envKey}
                onChange={(e) => setEnvKey(e.target.value)}
                className="font-mono text-sm"
                disabled={envDialogMode === 'edit'}
              />
              {envDialogMode === 'edit' && (
                <p className="text-xs text-muted-foreground">Key cannot be changed when editing</p>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="env-value">Value</Label>
              <Input
                id="env-value"
                type="password"
                placeholder={envDialogMode === 'edit' ? 'Leave blank to keep current value' : 'Enter value'}
                value={envValue}
                onChange={(e) => setEnvValue(e.target.value)}
                className="font-mono text-sm"
              />
            </div>

            <div className="flex items-start gap-3 rounded-lg border border-indigo-200 bg-indigo-50 dark:border-indigo-900/50 dark:bg-indigo-950/20 p-3">
              <Lock className="size-4 text-indigo-600 mt-0.5 shrink-0" />
              <div className="space-y-0.5">
                <p className="text-sm font-medium text-indigo-700 dark:text-indigo-400">
                  Encrypted at rest with AES-256-GCM
                </p>
                <p className="text-xs text-muted-foreground">
                  All values are transparently encrypted before being stored in the database and decrypted only when revealed.
                </p>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEnvDialogOpen(false)} disabled={envSaving}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveEnvVar}
              disabled={envSaving || !envKey.trim()}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              {envSaving ? (
                <>
                  <Loader2 className="size-4 me-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="size-4 me-2" />
                  {envDialogMode === 'create' ? 'Add Variable' : 'Save Changes'}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Env Var Delete Confirmation Dialog */}
      <AlertDialog open={!!envDeleteId} onOpenChange={(v) => !v && setEnvDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-red-500" />
              Delete Environment Variable
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this environment variable? This action cannot be undone and your application may stop working if it depends on this variable.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={envDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteEnvVar}
              disabled={envDeleting}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {envDeleting ? (
                <>
                  <Loader2 className="size-4 me-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="size-4 me-2" />
                  Delete Variable
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
