'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import {
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
} from '@/components/ui/dropdown-menu'

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
  createdAt: string
  updatedAt: string
}

interface ProjectDetail extends Project {
  coolifyId?: string
  repoUrl?: string
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
function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('deployhub_token')
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

function statusColor(status: string) {
  switch (status) {
    case 'running':
    case 'live':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
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
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
    case 'react':
      return 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400'
    case 'node':
      return 'bg-lime-100 text-lime-700 dark:bg-lime-900/30 dark:text-lime-400'
    case 'static':
      return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800/30 dark:text-gray-400'
  }
}

function frameworkIcon(fw: string) {
  switch (fw) {
    case 'nextjs':
      return <Triangle className="size-4 text-emerald-600 dark:text-emerald-400" />
    case 'react':
      return <Hexagon className="size-4 text-sky-500 dark:text-sky-400" />
    case 'node':
      return <FileCode className="size-4 text-lime-600 dark:text-lime-400" />
    case 'static':
      return <Layout className="size-4 text-orange-500 dark:text-orange-400" />
    default:
      return <FileCode className="size-4 text-gray-500" />
  }
}

function deployStatusIcon(status: string) {
  switch (status) {
    case 'live':
      return <CheckCircle2 className="size-4 text-emerald-500" />
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

function generateSimulatedBuildLog(project: ProjectDetail, deployment: Deployment): string {
  const isFailed = deployment.status === 'failed'
  const fw = project.framework === 'nextjs' ? 'next' : project.framework
  const now = new Date(deployment.createdAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  const ts = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`

  if (isFailed) {
    return `${ts} > Cloning repository...
${ts} > Installing dependencies...
${ts} > npm install --production
${ts} > Building application...
${ts} > ${fw} build
${ts} ✗ Type error: Property 'fetchData' does not exist on type 'never'.
${ts} ✗ Build failed with 1 error
${ts} > Error: Build process exited with code 1
${ts} > Deployment failed!`
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
${ts} ✓ Generating static pages (8/8)
${ts} ✓ Finalizing page optimization
${ts} > Deploying to server...
${ts} ✓ Deployment successful!
${ts} > Live at https://${project.subdomain}`
}

function colorizeLogLine(line: string): React.ReactNode {
  if (line.includes('✓') || line.includes('successful') || line.includes('Live at')) {
    return <span className="text-emerald-400">{line}</span>
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
}: {
  project: Project
  onClick: () => void
}) {
  return (
    <Card
      className="group cursor-pointer transition-all hover:shadow-lg hover:border-emerald-200 dark:hover:border-emerald-800 hover:bg-gradient-to-br hover:from-card hover:to-emerald-50/30 dark:hover:to-emerald-950/10 relative overflow-hidden"
      onClick={onClick}
    >
      {/* Subtle gradient overlay on hover */}
      <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/0 to-emerald-500/0 group-hover:from-emerald-500/5 group-hover:to-transparent transition-all pointer-events-none" />

      <CardHeader className="pb-2 relative">
        <div className="flex items-start justify-between">
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
          {project.sslEnabled && (
            <Badge variant="outline" className="bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400 text-xs">
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
                    className={`relative flex items-center gap-3 rounded-lg border p-3 text-left transition-all hover:border-emerald-300 dark:hover:border-emerald-700 ${
                      planId === plan.id
                        ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 ring-1 ring-emerald-500'
                        : 'border-border'
                    }`}
                  >
                    {plan.popular && (
                      <Badge className="absolute -top-2 right-3 bg-emerald-600 text-white text-[10px] px-1.5 py-0">
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
                      <div className="font-semibold text-emerald-600 dark:text-emerald-400">
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
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
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
    : logContent || (deployment && project ? generateSimulatedBuildLog(project, deployment) : 'No build logs available')

  const isAnimating = deployment?.status === 'building' || deployment?.status === 'deploying'

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="size-5 text-emerald-600" />
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

  useEffect(() => {
    setLoading(true)
    fetchProject()
  }, [fetchProject])

  const handleDeploy = async () => {
    setDeploying(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/deploy`, {
        method: 'POST',
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Deploy failed')
        return
      }
      toast.success('Deployment triggered!')
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
              className="hover:text-emerald-600 transition-colors font-mono"
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
            disabled={deploying || project.status !== 'running'}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {deploying ? (
              <RefreshCw className="size-4 mr-2 animate-spin" />
            ) : (
              <Rocket className="size-4 mr-2" />
            )}
            Deploy
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
              <DropdownMenuItem className="text-red-600 focus:text-red-600" onClick={() => setDeleteDialogOpen(true)}>
                <Trash2 className="size-4 mr-2" />
                Delete Project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Separator />

      {/* Info Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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
                <div className={`size-2 rounded-full ${project.sslEnabled ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                SSL {project.sslEnabled ? 'Enabled' : 'Disabled'}
              </div>
              <div className="flex items-center gap-2 mt-1">
                <div className={`size-2 rounded-full ${project.autoDeploy ? 'bg-emerald-500' : 'bg-gray-400'}`} />
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
                    <div className={`size-1.5 rounded-full ${d.status === 'active' ? 'bg-emerald-500' : 'bg-yellow-500'}`} />
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
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Rocket className="size-5 text-emerald-600" />
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
                    <TableRow key={dep.id} className="hover:bg-emerald-50/50 dark:hover:bg-emerald-950/20 transition-colors">
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
                          className="h-7 text-xs hover:text-emerald-600"
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
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Settings className="size-5 text-emerald-600" />
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
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
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

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-red-500" />
              Delete Project
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{project.name}</strong>? This action cannot be undone. All deployments, domains, and associated data will be permanently removed.
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
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────

export default function HostingPanel() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/hosting', {
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
  }, [])

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

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

  // List View
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Hosting Projects</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your deployed applications and services
          </p>
        </div>
        <Button
          onClick={() => setShowCreate(true)}
          className="bg-emerald-600 hover:bg-emerald-700 text-white"
        >
          <Plus className="size-4 mr-2" />
          New Project
        </Button>
      </div>

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
            <Rocket className="size-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold mb-1">No projects yet</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Create your first hosting project to get started
            </p>
            <Button
              onClick={() => setShowCreate(true)}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              <Plus className="size-4 mr-2" />
              Create Project
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onClick={() => setSelectedProjectId(project.id)}
            />
          ))}
        </div>
      )}

      <CreateProjectDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={fetchProjects}
      />
    </div>
  )
}
