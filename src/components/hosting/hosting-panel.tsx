'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import {
  HardDriveDownload,
  Plus,
  Globe,
  Rocket,
  StopCircle,
  Trash2,
  ArrowLeft,
  ExternalLink,
  Server,
  Shield,
  Zap,
  RefreshCw,
  Clock,
  GitBranch,
  MoreVertical,
  Terminal,
  CheckCircle2,
  XCircle,
  Loader2,
  Settings,
  AlertTriangle,
  Save,
  ChevronRight,
  FileCode,
  Triangle,
  Hexagon,
  Layout,
  Eye,
  EyeOff,
  Key,
  Lock,
  Upload,
  Edit,
  Github,
  GitCommit,
  Unplug,
  Search,
  Filter,
  ArrowUpDown,
  Square,
  CheckSquare,
  X,
  RotateCcw,
  Container,
  Calendar,
  Network,
  FileText,
  Database as DatabaseIcon,
  Folder,
  Mail,
  Archive,
  Activity,
  HardDriveUpload,
  ArrowRightLeft,
  Ban,
  LayoutDashboard,
  Users,
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
import { ScrollArea } from '@/components/ui/scroll-area'
import CreateWebsiteWizard from '@/components/hosting/create-website-wizard'
import ImportWizard from '@/components/hosting/import-wizard'
import ImportDashboard from '@/components/hosting/import-dashboard'
import { EmailManagement } from '@/components/hosting/email-management'
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
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import {
  DatabaseTab,
  BackupsTab,
  FilesTab,
  TerminalTab,
  ResourcesTab,
  DomainsTab,
  EmailTab,
} from '@/components/hosting/website-management-tabs'
import {
  CronTab,
  FtpTab,
  RedirectsTab,
  SecurityTab,
} from '@/components/hosting/cpanel-management-tabs'

// ─── Project sub-tab navigation (sticky bar inside project detail) ───────
// The project detail view is very long (deployments, container, SSL, settings,
// databases, files, terminal, cron, ftp, backups, domains, redirects, security,
// resources, email). This sticky bar lets the user jump straight to any section
// instead of scrolling through ~1200 lines of stacked cards.
const PROJECT_SUBTABS: { id: string; label: string; icon: React.ElementType }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'deployments', label: 'Deployments', icon: Rocket },
  { id: 'container', label: 'Container', icon: Container },
  { id: 'ssl', label: 'SSL', icon: Shield },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'databases', label: 'Databases', icon: DatabaseIcon },
  { id: 'email', label: 'Email', icon: Mail },
  { id: 'files', label: 'Files', icon: Folder },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'cron', label: 'Cron Jobs', icon: Clock },
  { id: 'ftp', label: 'FTP', icon: HardDriveUpload },
  { id: 'backups', label: 'Backups', icon: Archive },
  { id: 'import', label: 'Import', icon: HardDriveDownload },
  { id: 'domains', label: 'Domains', icon: Globe },
  { id: 'redirects', label: 'Redirects', icon: ArrowRightLeft },
  { id: 'security', label: 'IP Blocker', icon: Ban },
  { id: 'resources', label: 'Resources', icon: Activity },
]

// Types
interface Project {
  id: string
  name: string
  slug: string
  description?: string
  framework: string
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
}: {
  project: Project
  onClick: () => void
  selected: boolean
  onSelectToggle: () => void
  onShiftSelect: () => void
}) {
  return (
    <Card
      className={`group cursor-pointer transition-all hover:shadow-lg relative overflow-hidden ${
        selected
          ? 'border-indigo-500 ring-2 ring-indigo-500/30 bg-indigo-50/30 dark:bg-indigo-950/10'
          : 'hover:border-indigo-200 dark:hover:border-indigo-800 hover:bg-gradient-to-br hover:from-card hover:to-indigo-50/30 dark:hover:to-indigo-950/10'
      }`}
      onClick={onClick}
    >
      {/* Subtle gradient overlay on hover */}
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/0 to-indigo-500/0 group-hover:from-indigo-500/5 group-hover:to-transparent transition-all pointer-events-none" />

      {/* Selection checkbox (top-right) */}
      <div
        className="absolute top-3 right-3 z-10"
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
        <div className="flex items-start justify-between pr-8">
          <div className="flex items-center gap-2">
            {frameworkIcon(project.framework)}
            <CardTitle className="text-base">{project.name}</CardTitle>
          </div>
          <Badge variant="outline" className={frameworkColor(project.framework)}>
            {frameworkLabel(project.framework)}
          </Badge>
        </div>
        <CardDescription className="text-xs font-mono">
          {project.subdomain}
        </CardDescription>
      </CardHeader>
      <CardContent className="relative">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className={statusColor(project.status)}>
            {project.status}
          </Badge>
          {project.team && (
            <Badge variant="outline" className="text-xs" title={project.ownedByMe === false ? `Shared with you through ${project.team.name}` : `Shared with ${project.team.name}`}>
              <Users className="size-3 mr-1" />
              {project.team.name}
            </Badge>
          )}
          {project.sslEnabled && (
            <Badge variant="outline" className="bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400 text-xs">
              <Shield className="size-3 mr-1" />
              SSL
            </Badge>
          )}
        </div>
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
                    className={`relative flex items-center gap-3 rounded-lg border p-3 text-left transition-all hover:border-indigo-300 dark:hover:border-indigo-700 ${
                      planId === plan.id
                        ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20 ring-1 ring-indigo-500'
                        : 'border-border'
                    }`}
                  >
                    {plan.popular && (
                      <Badge className="absolute -top-2 right-3 bg-indigo-600 text-white text-[10px] px-1.5 py-0">
                        Popular
                      </Badge>
                    )}
                    <div className="flex-1">
                      <div className="font-medium text-sm">{plan.name}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {plan.cpu} &middot; {plan.ram} &middot; {plan.storage}
                      </div>
                    </div>
                    <div className="text-right">
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
                <RefreshCw className="size-4 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Rocket className="size-4 mr-2" />
                Create Project
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

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
              <span className="flex items-center gap-1 text-sm text-indigo-600 ml-2">
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
            <span className="ml-2 text-xs text-zinc-500 font-mono">build log</span>
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
                  <CheckCircle2 className="size-3.5 mr-1 text-indigo-500" />
                  Copied
                </>
              ) : (
                <>
                  <FileText className="size-3.5 mr-1" />
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
              <RefreshCw className={`size-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} />
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
            <span className="ml-2 text-[10px] text-zinc-500 font-mono">
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
                    <span className="text-zinc-600 select-none mr-3">
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

function ProjectDetailView({
  projectId,
  onBack,
  onRefresh,
}: {
  projectId: string
  onBack: () => void
  onRefresh: () => void
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

  // ── Sub-tab navigation state (sticky bar) ─────────────────────────────
  // Tracks which section the user jumped to so the active pill is highlighted.
  const [activeSection, setActiveSection] = useState<string>('overview')
  const scrollToSection = useCallback((id: string) => {
    setActiveSection(id)
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [])

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
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to load project')
        onBack()
        return
      }
      setProject(data.project)
      // Initialize settings
      setSettingsAutoDeploy(data.project.autoDeploy)
      setSettingsSsl(data.project.sslEnabled)
      setSettingsRepoUrl(data.project.repoUrl || '')
      setSettingsCustomDomain(data.project.customDomain || '')
    } catch {
      toast.error('Network error')
      onBack()
    } finally {
      setLoading(false)
    }
  }, [projectId, onBack])

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
      } else {
        toast.error(data.error || 'Failed to load env vars')
      }
    } catch {
      toast.error('Failed to load env vars')
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

  const handleStop = async () => {
    try {
      const res = await fetch(`/api/hosting/${projectId}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to stop project')
        return
      }
      toast.success('Project stopped')
      fetchProject()
      onRefresh()
    } catch {
      toast.error('Network error')
    }
  }

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
      toast.success('Project deleted')
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

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-60 w-full" />
      </div>
    )
  }

  if (!project) return null

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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4 mr-1" />
          Back
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            {frameworkIcon(project.framework)}
            <h2 className="text-2xl font-bold">{project.name}</h2>
            <Badge variant="outline" className={statusColor(project.status)}>
              {project.status}
            </Badge>
            <Badge variant="outline" className={frameworkColor(project.framework)}>
              {frameworkLabel(project.framework)}
            </Badge>
          </div>
          <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
            <Globe className="size-3.5" />
            <a
              href={`https://${project.subdomain}`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-indigo-600 transition-colors font-mono"
            >
              {project.subdomain}
              <ExternalLink className="size-3 inline ml-1" />
            </a>
          </div>
          {project.customDomain && (
            <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
              <Globe className="size-3.5" />
              <span className="font-mono">{project.customDomain}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            onClick={handleDeploy}
            // Was `status !== 'running'`, which greyed this out for a stopped or
            // errored site — the two states you most need to redeploy from. The
            // API allows running | stopped | error | creating | building |
            // deploying, and refuses a genuine overlap with 409, so the button
            // only has to keep up with it.
            disabled={deploying || project.status === 'deleting'}
            className="bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            {deploying ? (
              <RefreshCw className="size-4 mr-2 animate-spin" />
            ) : (
              <Rocket className="size-4 mr-2" />
            )}
            {project.lastDeployment ? 'Redeploy' : 'Deploy'}
          </Button>
          <Button variant="outline" onClick={handleStop} disabled={project.status !== 'running'}>
            <StopCircle className="size-4 mr-2" />
            Stop
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon">
                <MoreVertical className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {project.access?.isOwner !== false ? (
                <DropdownMenuItem className="text-red-600 focus:text-red-600" onClick={() => setDeleteDialogOpen(true)}>
                  <Trash2 className="size-4 mr-2" />
                  Delete Project
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem disabled>Only the owner can delete this project</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Separator />

      {/* ── Sticky project sub-tab navigation ───────────────────────────────
          The project detail view stacks ~16 sections vertically. This sticky
          bar stays pinned to the top of the scroll area so the user can jump
          straight to Databases, Files, Terminal, Cron, FTP, Backups, Domains,
          Redirects, IP Blocker, Resources, Email, Container, SSL, Settings, or
          Deployments without scrolling through the whole page. */}
      <div className="sticky top-0 z-20 -mx-1 px-1 py-2 bg-background/95 backdrop-blur border-b">
        <div className="flex items-center gap-1 overflow-x-auto pb-1 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
          {PROJECT_SUBTABS.map((tab) => {
            const Icon = tab.icon
            const isActive = activeSection === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => scrollToSection(tab.id)}
                className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                <Icon className="size-3.5" />
                {tab.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Info Cards */}
      <div id="overview" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 scroll-mt-32">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5">
              <Server className="size-3.5" />
              Server
            </CardDescription>
          </CardHeader>
          <CardContent>
            {project.server ? (
              <div>
                <div className="font-medium text-sm">{project.server.name}</div>
                <div className="text-xs text-muted-foreground font-mono">{project.server.ip}</div>
                <div className="text-xs text-muted-foreground">{project.server.region}</div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No server assigned</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5">
              <Shield className="size-3.5" />
              Security
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-sm">
              <div className="flex items-center gap-2">
                <div className={`size-2 rounded-full ${project.sslEnabled ? 'bg-indigo-500' : 'bg-gray-400'}`} />
                SSL {project.sslEnabled ? 'Enabled' : 'Disabled'}
              </div>
              <div className="flex items-center gap-2 mt-1">
                <div className={`size-2 rounded-full ${project.autoDeploy ? 'bg-indigo-500' : 'bg-gray-400'}`} />
                Auto Deploy {project.autoDeploy ? 'On' : 'Off'}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5">
              <Globe className="size-3.5" />
              Domains
            </CardDescription>
          </CardHeader>
          <CardContent>
            {project.domains.length > 0 ? (
              <div className="space-y-1">
                {project.domains.map((d) => (
                  <div key={d.id} className="text-sm font-mono flex items-center gap-1.5">
                    <div className={`size-1.5 rounded-full ${d.status === 'active' ? 'bg-indigo-500' : 'bg-yellow-500'}`} />
                    {d.name}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No custom domains</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5">
              <Zap className="size-3.5" />
              Quick Info
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-sm space-y-1">
              <div className="text-muted-foreground">Created: {formatDate(project.createdAt)}</div>
              <div className="text-muted-foreground">Updated: {formatDate(project.updatedAt)}</div>
              {project.repoUrl && (
                <div className="text-muted-foreground truncate">Repo: {project.repoUrl}</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

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
                    <TableHead className="text-right">Actions</TableHead>
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
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs hover:text-indigo-600"
                          onClick={() => handleViewLogs(dep)}
                        >
                          <Terminal className="size-3 mr-1" />
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
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="size-4 mr-2" />
                  Save Changes
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Container Status (VPS-UI) */}
      <Card id="container" className="scroll-mt-32">
        <CardHeader>
          <div className="flex items-center justify-between">
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
              <RefreshCw className={`size-3.5 mr-1 ${containerLoading ? 'animate-spin' : ''}`} />
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
                  <Loader2 className="size-3.5 mr-1 animate-spin" />
                ) : (
                  <Rocket className="size-3.5 mr-1" />
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
                            <span className="size-1.5 rounded-full bg-indigo-500 mr-1.5 animate-pulse" />
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
                        <Loader2 className="size-3.5 mr-1 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3.5 mr-1" />
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
                      <Square className="size-3.5 mr-1" />
                      Stop
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={handleOpenContainerLogs}
                    >
                      <Terminal className="size-3.5 mr-1" />
                      View Logs
                    </Button>
                  </div>
                </div>
              )
            })()
          )}
        </CardContent>
      </Card>

      {/* SSL Certificate (VPS-UI) */}
      <Card id="ssl" className="scroll-mt-32">
        <CardHeader>
          <div className="flex items-center justify-between">
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
              <RefreshCw className={`size-3.5 mr-1 ${sslLoading ? 'animate-spin' : ''}`} />
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
                        <span className="size-1.5 rounded-full bg-current mr-1.5 animate-pulse" />
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
                          <Loader2 className="size-3.5 mr-1 animate-spin" />
                        ) : (
                          <Lock className="size-3.5 mr-1" />
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
                              <span className="ml-1 opacity-80">
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
                            <Loader2 className="size-3.5 mr-1 animate-spin" />
                          ) : (
                            <RefreshCw className="size-3.5 mr-1" />
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

      {/* Environment Variables */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <Key className="size-5 text-indigo-600" />
                Environment Variables
                <Badge variant="outline" className="ml-1 bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/20 dark:text-indigo-400 dark:border-indigo-900/50 text-[10px] h-5">
                  <Lock className="size-3 mr-1" />
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
                    <EyeOff className="size-3.5 mr-1" />
                    Hide
                  </>
                ) : (
                  <>
                    <Eye className="size-3.5 mr-1" />
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
                <Upload className="size-3.5 mr-1" />
                Import .env
              </Button>
              <Button
                size="sm"
                onClick={() => handleOpenEnvDialog('create')}
                className="bg-indigo-600 hover:bg-indigo-700 text-white h-8 text-xs"
              >
                <Plus className="size-3.5 mr-1" />
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
                    <Loader2 className="size-3.5 mr-1 animate-spin" />
                    Applying…
                  </>
                ) : (
                  <>
                    <RefreshCw className="size-3.5 mr-1" />
                    Apply now
                  </>
                )}
              </Button>
            </div>
          )}
          {envLoading ? (
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
                <Plus className="size-3.5 mr-1" />
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
                    <TableHead className="text-right">Actions</TableHead>
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
                            <Lock className="size-3 mr-1" />
                            Encrypted
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="bg-gray-50 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400 text-xs">
                            Plain
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs hover:text-indigo-600"
                            onClick={() => handleOpenEnvDialog('edit', ev)}
                          >
                            <Edit className="size-3 mr-1" />
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20"
                            onClick={() => setEnvDeleteId(ev.id)}
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
      </Card>

      {/* GitHub Integration */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
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
                <Github className="size-3.5 mr-1" />
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
                      <GitBranch className="size-3 mr-1" />
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
                  <ExternalLink className="size-3.5 mr-1" />
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
                  <GitCommit className="size-3.5 mr-1" />
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
                  {redeploying ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : <RefreshCw className="size-3.5 mr-1" />}
                  Trigger Redeploy
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20"
                  onClick={() => setDisconnectDialogOpen(true)}
                >
                  <Unplug className="size-3.5 mr-1" />
                  Disconnect
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

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
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <Github className="size-4 mr-2" />
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
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Disconnecting...
                </>
              ) : (
                <>
                  <Unplug className="size-4 mr-2" />
                  Disconnect
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── Website Management Tabs (Phase 2-c) ────────────────────────── */}
      {/* New management sections added by the Frontend Management Tabs subagent.
          Each is a self-contained Card component consuming its own REST endpoint.
          Each is wrapped in a <section> with an id so the sticky sub-tab bar
          can scroll the user straight to it. */}
      <section id="databases" className="scroll-mt-32"><DatabaseTab projectId={project.id} /></section>
      <section id="email" className="scroll-mt-32 space-y-4">
        <EmailTab projectId={project.id} />
        {/* Native management over Mailcow: aliases, forwarding, catch-all,
            spam policy, quarantine and activity logs. */}
        <EmailManagement projectId={project.id} />
      </section>
      <section id="backups" className="scroll-mt-32"><BackupsTab projectId={project.id} /></section>
      {/* Importing into an existing website replaces its files and database,
          so it lives beside Backups rather than in the creation flow — the
          customer should be one click from taking a backup first. */}
      <section id="import" className="scroll-mt-32">
        <Card>
          <CardContent className="pt-6">
            <ImportDashboard projectId={project.id} projectName={project.name} />
          </CardContent>
        </Card>
      </section>
      <section id="files" className="scroll-mt-32"><FilesTab projectId={project.id} /></section>
      <section id="terminal" className="scroll-mt-32"><TerminalTab projectId={project.id} /></section>
      <section id="resources" className="scroll-mt-32"><ResourcesTab projectId={project.id} /></section>
      <section id="domains" className="scroll-mt-32"><DomainsTab projectId={project.id} onProjectChanged={fetchProject} /></section>

      {/* ─── cPanel-style features (Phase 2-c upgrade) ─────────────────── */}
      {/* Cron + FTP near Files/Terminal; Redirects + Security near Domains. */}
      <section id="cron" className="scroll-mt-32"><CronTab projectId={project.id} /></section>
      <section id="ftp" className="scroll-mt-32"><FtpTab projectId={project.id} /></section>
      <section id="redirects" className="scroll-mt-32"><RedirectsTab projectId={project.id} /></section>
      <section id="security" className="scroll-mt-32"><SecurityTab projectId={project.id} /></section>

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
              <p className="font-medium text-sm">Delete this project</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Once you delete a project, there is no going back. All deployments and data will be permanently removed.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDeleteDialogOpen(true)}
              disabled={project.access?.isOwner === false}
              title={project.access?.isOwner === false ? 'Only the project owner can delete it' : undefined}
            >
              <Trash2 className="size-4 mr-2" />
              Delete Project
            </Button>
          </div>
        </CardContent>
      </Card>

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
              Delete Project
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
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="size-4 mr-2" />
                  Delete Project
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
                  <Loader2 className="size-4 mr-1.5 animate-spin" />
                  Importing…
                </>
              ) : (
                <>
                  <Upload className="size-4 mr-1.5" />
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
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="size-4 mr-2" />
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
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="size-4 mr-2" />
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

// ─── Main Component ─────────────────────────────────────────────

export default function HostingPanel() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [showImport, setShowImport] = useState(false)
  // 'projects' is the website list; 'imports' is the migration dashboard.
  const [view, setView] = useState<'projects' | 'imports'>('projects')
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)

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
          projectId={selectedProjectId}
          onBack={() => setSelectedProjectId(null)}
          onRefresh={fetchProjects}
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
        onChooseFreshInstall={() => {
          setView('projects')
          setShowCreate(true)
        }}
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
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">Hosting Projects</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your deployed applications and services
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            onClick={() => setView('imports')}
            title="Move an existing website here from another host"
          >
            <HardDriveDownload className="size-4 mr-2" />
            Import
          </Button>
          <Button
            onClick={() => setShowCreate(true)}
            className="bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            <Plus className="size-4 mr-2" />
            Create Website
          </Button>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <Input
            type="search"
            placeholder="Search by name, framework, or domain..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9 pr-4"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
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
                  {statusFilter === s && <CheckCircle2 className="size-3.5 ml-auto text-indigo-600" />}
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
                  {frameworkFilter === f && <CheckCircle2 className="size-3.5 ml-auto text-indigo-600" />}
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
                {sortBy === 'created' && <CheckCircle2 className="size-3.5 ml-auto text-indigo-600" />}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setSortBy('name')}
                className={sortBy === 'name' ? 'bg-accent' : ''}
              >
                Name (A → Z)
                {sortBy === 'name' && <CheckCircle2 className="size-3.5 ml-auto text-indigo-600" />}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setSortBy('deployed')}
                className={sortBy === 'deployed' ? 'bg-accent' : ''}
              >
                Last deployed
                {sortBy === 'deployed' && <CheckCircle2 className="size-3.5 ml-auto text-indigo-600" />}
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
                <Rocket className="size-12 text-muted-foreground/40 mb-4" />
                <h3 className="text-lg font-semibold mb-1">No projects yet</h3>
                <p className="text-sm text-muted-foreground mb-4 text-center max-w-sm">
                  Start a new site, or bring an existing one over from another
                  host — we handle the database, URLs, and SSL for you.
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  <Button
                    onClick={() => setShowCreate(true)}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white"
                  >
                    <Plus className="size-4 mr-2" />
                    Create Website
                  </Button>
                  <Button variant="outline" onClick={() => setShowImport(true)}>
                    <HardDriveDownload className="size-4 mr-2" />
                    Import existing site
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
              />
            ))}
          </div>
        </>
      )}

      <CreateWebsiteWizard
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={() => fetchProjects()}
      />

      <ImportWizard
        open={showImport}
        onClose={() => setShowImport(false)}
        onCompleted={() => fetchProjects()}
        onChooseFreshInstall={() => setShowCreate(true)}
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
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Deleting {selectedCount}...
                </>
              ) : (
                <>
                  <Trash2 className="size-4 mr-2" />
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
