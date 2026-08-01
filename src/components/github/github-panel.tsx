'use client'

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
  Github,
  GitBranch,
  GitCommit,
  Plus,
  ArrowLeft,
  ExternalLink,
  Unplug,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Zap,
  Star,
  ChevronRight,
  ShieldCheck,
  KeyRound,
  Link2,
  Lock,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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
import { apiFetch } from '@/store/auth-store'

// ─── Types ─────────────────────────────────────────────────────────

interface Project {
  id: string
  name: string
  slug: string
  framework: string
  status: string
  subdomain: string
  repoUrl?: string
  autoDeploy: boolean
  sslEnabled: boolean
  createdAt: string
  updatedAt: string
}

interface GithubIntegration {
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
  /** True when this integration uses a real GitHub OAuth access token. */
  oauthConnected?: boolean
  createdAt: string
  updatedAt: string
}

/** User-level OAuth integration returned by /api/github/me. */
interface GithubAccountIntegration {
  id: string
  userId: string
  projectId: string | null
  githubId: string
  username: string
  repoFullName: string | null
  repoUrl: string | null
  branch: string
  autoDeploy: boolean
  webhookId: string | null
  hasToken: boolean
  createdAt: string
  updatedAt: string
}

interface CommitData {
  sha: string
  shortSha: string
  message: string
  author: string
  authorEmail: string
  authorLogin?: string
  authorAvatarUrl?: string
  date: string
  branch: string
  url?: string
}

interface BranchData {
  name: string
  protected: boolean
}

interface RepoData {
  name: string
  fullName: string
  stars?: number
  language?: string
  updatedAt?: string
  description?: string
  private?: boolean
  defaultBranch?: string
  htmlUrl?: string
  connected?: boolean
}

interface ActivityEvent {
  id: string
  type: 'commit_pushed' | 'auto_deploy_triggered' | 'integration_connected' | 'integration_disconnected'
  projectName: string
  message: string
  timestamp: string
  detail?: string
}

interface ProjectWithIntegration extends Project {
  githubIntegration: GithubIntegration | null
}

// ─── Helpers ───────────────────────────────────────────────────────

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

function languageColor(lang: string) {
  switch (lang) {
    case 'TypeScript':
      return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
    case 'JavaScript':
      return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
    case 'Python':
      return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
    case 'Rust':
      return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
    case 'Go':
      return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
    case 'Ruby':
      return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800/30 dark:text-gray-400'
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

// ─── Skeleton Components ───────────────────────────────────────────

function IntegrationCardSkeleton() {
  return (
    <Card className="transition-all">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <Skeleton className="size-5 rounded" />
            <Skeleton className="h-5 w-32" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2">
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="mt-3 flex items-center justify-between">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-20" />
        </div>
      </CardContent>
    </Card>
  )
}

function CommitRowSkeleton() {
  return (
    <div className="flex items-center gap-3 py-3">
      <Skeleton className="size-8 rounded-full" />
      <div className="flex-1 space-y-1">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  )
}

function RepoRowSkeleton() {
  return (
    <div className="flex items-center gap-3 py-3">
      <Skeleton className="size-8 rounded" />
      <div className="flex-1 space-y-1">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-3 w-3/4" />
      </div>
      <Skeleton className="h-5 w-16 rounded-full" />
    </div>
  )
}

// ─── Connect Repository Dialog ─────────────────────────────────────

function ConnectRepositoryDialog({
  open,
  onClose,
  projects,
  onConnected,
  oauthEnabled,
  oauthIntegration,
}: {
  open: boolean
  onClose: () => void
  projects: ProjectWithIntegration[]
  onConnected: () => void
  /** True when GITHUB_CLIENT_ID is set on the server. */
  oauthEnabled: boolean
  /** The user's user-level OAuth integration (projectId=null), if any. */
  oauthIntegration: GithubAccountIntegration | null
}) {
  const [projectId, setProjectId] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [connecting, setConnecting] = useState(false)
  const [oauthStarting, setOauthStarting] = useState(false)

  // Filter out projects that already have GitHub integration
  const availableProjects = projects.filter((p) => !p.githubIntegration)

  useEffect(() => {
    if (open) {
      setProjectId('')
      setRepoUrl('')
      setBranch('main')
    }
  }, [open])

  const handleConnect = async () => {
    if (!projectId) {
      toast.error('Please select a project')
      return
    }
    if (!repoUrl.trim()) {
      toast.error('Repository URL is required')
      return
    }

    setConnecting(true)
    try {
      const data = await apiFetch('/github/connect', {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          repoUrl: repoUrl.trim(),
          branch: branch || 'main',
        }),
      })
      if (data.oauthConnected) {
        toast.success('Repository connected via GitHub OAuth!')
      } else {
        toast.success('Repository connected successfully!')
      }
      onConnected()
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to connect repository')
    } finally {
      setConnecting(false)
    }
  }

  /**
   * Kick off the real GitHub OAuth flow:
   *   1. Ask the server for an authorize URL (with a signed state token).
   *   2. If a project is selected, pass its ID so the callback can scope
   *      the resulting integration to that project.
   *   3. Redirect the browser to GitHub's authorize page.
   *   4. GitHub redirects back to /api/github/oauth/callback, which
   *      creates/updates the integration and bounces to /?tab=github.
   */
  const handleStartOauth = async () => {
    setOauthStarting(true)
    try {
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
      const data = await apiFetch(`/github/oauth/start${query}`)
      if (data.demoMode) {
        toast.info(
          data.message ||
            'GitHub OAuth is in demo mode. Use "Connect Manually" instead.'
        )
        return
      }
      if (!data.url) {
        toast.error('Failed to start OAuth flow')
        return
      }
      // Full-page redirect to GitHub.
      window.location.href = data.url
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start OAuth')
    } finally {
      setOauthStarting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Github className="size-5 text-indigo-600" />
            Connect Repository
          </DialogTitle>
          <DialogDescription>
            Link a GitHub repository to your project for automatic deployments.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* ── OAuth option (only shown when GitHub OAuth is enabled) ── */}
          {oauthEnabled && (
            <>
              <div className="rounded-lg border border-indigo-200 dark:border-indigo-900/60 bg-indigo-50/50 dark:bg-indigo-950/20 p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="flex size-9 items-center justify-center rounded-lg bg-indigo-100 dark:bg-indigo-900/40 shrink-0">
                    <ShieldCheck className="size-5 text-indigo-600 dark:text-indigo-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium flex items-center gap-2">
                      Connect with GitHub
                      <Badge className="bg-indigo-600 text-white text-[10px] px-1.5 py-0">
                        Recommended
                      </Badge>
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Authorize via GitHub OAuth to list your real repositories,
                      view commit history with author avatars, and enable
                      auto-deploy on push.
                    </p>
                  </div>
                </div>
                {oauthIntegration && (
                  <div className="text-xs text-muted-foreground flex items-center gap-1.5 pl-12">
                    <CheckCircle2 className="size-3 text-indigo-600" />
                    Signed in as
                    <span className="font-mono font-medium text-indigo-700 dark:text-indigo-400">
                      @{oauthIntegration.username}
                    </span>
                  </div>
                )}
                <div className="pl-12">
                  <Button
                    onClick={handleStartOauth}
                    disabled={oauthStarting || connecting}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white"
                    size="sm"
                  >
                    {oauthStarting ? (
                      <>
                        <Loader2 className="size-4 mr-2 animate-spin" />
                        Redirecting...
                      </>
                    ) : (
                      <>
                        <Github className="size-4 mr-2" />
                        {oauthIntegration ? 'Re-authorize GitHub' : 'Connect with GitHub'}
                      </>
                    )}
                  </Button>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Separator className="flex-1" />
                <span className="text-xs text-muted-foreground uppercase tracking-wide">
                  or connect manually
                </span>
                <Separator className="flex-1" />
              </div>
            </>
          )}

          {/* Project Selector */}
          <div className="grid gap-2">
            <Label>Project</Label>
            {availableProjects.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                All projects already have a GitHub integration.
              </p>
            ) : (
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a project" />
                </SelectTrigger>
                <SelectContent>
                  {availableProjects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      <span className="flex items-center gap-2">
                        {project.name}
                        <Badge variant="outline" className={`text-[10px] ${frameworkColor(project.framework)}`}>
                          {frameworkLabel(project.framework)}
                        </Badge>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Repository URL */}
          <div className="grid gap-2">
            <Label htmlFor="repo-url">GitHub Repository URL</Label>
            <Input
              id="repo-url"
              placeholder="https://github.com/owner/repo"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Supports https://github.com/owner/repo or owner/repo format
            </p>
          </div>

          {/* Branch Selector */}
          <div className="grid gap-2">
            <Label>Branch</Label>
            <Select value={branch} onValueChange={setBranch}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select branch" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="main">main</SelectItem>
                <SelectItem value="master">master</SelectItem>
                <SelectItem value="develop">develop</SelectItem>
                <SelectItem value="staging">staging</SelectItem>
                <SelectItem value="production">production</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={connecting || oauthStarting}>
            Cancel
          </Button>
          <Button
            onClick={handleConnect}
            disabled={connecting || oauthStarting || !projectId || !repoUrl.trim()}
            className="bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            {connecting ? (
              <>
                <Loader2 className="size-4 mr-2 animate-spin" />
                Connecting...
              </>
            ) : (
              <>
                <Link2 className="size-4 mr-2" />
                Connect Manually
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Integration Detail View ───────────────────────────────────────

function IntegrationDetailView({
  project,
  integration,
  onBack,
  onRefresh,
}: {
  project: ProjectWithIntegration
  integration: GithubIntegration
  onBack: () => void
  onRefresh: () => void
}) {
  const [commits, setCommits] = useState<CommitData[]>([])
  const [commitsLoading, setCommitsLoading] = useState(true)
  const [repos, setRepos] = useState<RepoData[]>([])
  const [reposLoading, setReposLoading] = useState(true)
  const [branches, setBranches] = useState<BranchData[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('overview')

  // Settings
  const [autoDeploy, setAutoDeploy] = useState(integration.autoDeploy)
  const [branch, setBranch] = useState(integration.branch)
  const [savingSettings, setSavingSettings] = useState(false)

  // Disconnect
  const [disconnectDialogOpen, setDisconnectDialogOpen] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  const fetchCommits = useCallback(async () => {
    setCommitsLoading(true)
    try {
      const data = await apiFetch(`/github/${integration.id}/commits?branch=${encodeURIComponent(branch)}`)
      setCommits(data.commits || [])
    } catch {
      toast.error('Failed to load commits')
    } finally {
      setCommitsLoading(false)
    }
  }, [integration.id, branch])

  const fetchRepos = useCallback(async () => {
    setReposLoading(true)
    try {
      const data = await apiFetch(`/github/${integration.id}/repos`)
      setRepos(data.repos || [])
    } catch {
      toast.error('Failed to load repositories')
    } finally {
      setReposLoading(false)
    }
  }, [integration.id])

  const fetchBranches = useCallback(async () => {
    setBranchesLoading(true)
    try {
      const data = await apiFetch(`/github/${integration.id}/branches`)
      setBranches(data.branches || [])
    } catch {
      // Non-fatal — the static branch list will be used as fallback.
    } finally {
      setBranchesLoading(false)
    }
  }, [integration.id])

  useEffect(() => {
    fetchCommits()
    fetchRepos()
    fetchBranches()
  }, [fetchCommits, fetchRepos, fetchBranches])

  // Re-fetch commits when the branch changes.
  useEffect(() => {
    fetchCommits()
  }, [branch, fetchCommits])

  const handleDisconnect = async () => {
    setDisconnecting(true)
    try {
      await apiFetch('/github/disconnect', {
        method: 'POST',
        body: JSON.stringify({ projectId: project.id }),
      })
      toast.success('GitHub integration disconnected')
      onRefresh()
      onBack()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to disconnect')
    } finally {
      setDisconnecting(false)
      setDisconnectDialogOpen(false)
    }
  }

  const [refreshing, setRefreshing] = useState(false)
  const handleRefreshData = async () => {
    setRefreshing(true)
    await Promise.all([fetchCommits(), fetchRepos(), fetchBranches()])
    setRefreshing(false)
    toast.success('Repos, branches, and commits refreshed')
  }

  return (
    <div className="space-y-6">
      {/* Back Button + Title */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={onBack} className="shrink-0">
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-bold truncate">{project.name}</h2>
          <p className="text-sm text-muted-foreground">GitHub Integration Details</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefreshData} disabled={refreshing}>
          <RefreshCw className={`size-4 mr-1.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Repository Info Card */}
      <Card className="rounded-xl">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-lg bg-indigo-100 dark:bg-indigo-900/30">
                <Github className="size-5 text-indigo-600 dark:text-indigo-400" />
              </div>
              <div>
                <CardTitle className="text-base">{integration.repoFullName}</CardTitle>
                <CardDescription className="font-mono text-xs mt-0.5">
                  {integration.repoUrl}
                </CardDescription>
              </div>
            </div>
            <Badge variant="outline" className="bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400 shrink-0">
              <CheckCircle2 className="size-3 mr-1" />
              Connected
            </Badge>
            {integration.oauthConnected && (
              <Badge variant="outline" className="bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 shrink-0 gap-1">
                <ShieldCheck className="size-3" />
                Connected via OAuth
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Branch</p>
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <GitBranch className="size-3.5 text-indigo-600" />
                {integration.branch}
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Username</p>
              <p className="text-sm font-medium">{integration.username}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Auto-deploy</p>
              <div className="flex items-center gap-1.5 text-sm font-medium">
                {integration.autoDeploy ? (
                  <>
                    <Zap className="size-3.5 text-indigo-600" />
                    Enabled
                  </>
                ) : (
                  <>
                    <XCircle className="size-3.5 text-muted-foreground" />
                    Disabled
                  </>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Connected</p>
              <p className="text-sm font-medium">{timeAgo(integration.createdAt)}</p>
            </div>
          </div>

          <Separator />

          {/* Settings */}
          <div className="space-y-3">
            <p className="text-sm font-medium">Settings</p>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label className="text-sm flex items-center gap-2">
                  <Zap className="size-4 text-indigo-600" />
                  Auto-deploy
                </Label>
                <p className="text-xs text-muted-foreground">
                  Automatically deploy when commits are pushed
                </p>
              </div>
              <Switch
                checked={autoDeploy}
                onCheckedChange={setAutoDeploy}
                disabled={savingSettings}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label className="text-sm flex items-center gap-2">
                  <GitBranch className="size-4 text-indigo-600" />
                  Deploy Branch
                </Label>
                <p className="text-xs text-muted-foreground">
                  Branch to watch for auto-deployments
                </p>
              </div>
              <Select value={branch} onValueChange={setBranch}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder={branchesLoading ? 'Loading…' : 'Select branch'} />
                </SelectTrigger>
                <SelectContent>
                  {/* Real branches from /api/github/[id]/branches (if any) */}
                  {branches.length > 0
                    ? branches.map((b) => (
                        <SelectItem key={b.name} value={b.name}>
                          <span className="flex items-center gap-1.5">
                            {b.protected && <Lock className="size-3 text-amber-500" />}
                            {b.name}
                          </span>
                        </SelectItem>
                      ))
                    : [
                        ['main', 'main'],
                        ['master', 'master'],
                        ['develop', 'develop'],
                        ['staging', 'staging'],
                        ['production', 'production'],
                      ].map(([v, label]) => (
                        <SelectItem key={v} value={v}>
                          {label}
                        </SelectItem>
                      ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                asChild
                className="text-xs"
              >
                <a
                  href={integration.repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="size-3 mr-1" />
                  Open in GitHub
                </a>
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30 border-red-200 dark:border-red-900/50"
                onClick={() => setDisconnectDialogOpen(true)}
              >
                <Unplug className="size-3 mr-1" />
                Disconnect
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabbed Content: Commits & Repos */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="overview" className="flex items-center gap-1.5">
            <GitCommit className="size-3.5" />
            Commit History
          </TabsTrigger>
          <TabsTrigger value="repos" className="flex items-center gap-1.5">
            <Github className="size-3.5" />
            Repositories
          </TabsTrigger>
        </TabsList>

        {/* Commit History Tab */}
        <TabsContent value="overview" className="mt-4">
          <Card className="rounded-xl">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <GitCommit className="size-4 text-indigo-600" />
                  Recent Commits
                </CardTitle>
                <Badge variant="outline" className="text-xs">
                  {commits.length} commits
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {commitsLoading ? (
                <div className="px-6 pb-4 space-y-1">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <CommitRowSkeleton key={i} />
                  ))}
                </div>
              ) : commits.length === 0 ? (
                <div className="px-6 pb-6 flex flex-col items-center py-8">
                  <GitCommit className="size-8 text-muted-foreground/40 mb-2" />
                  <p className="text-sm text-muted-foreground">No commits found</p>
                </div>
              ) : (
                <ScrollArea className="max-h-96">
                  <div className="divide-y">
                    {commits.map((commit) => (
                      <div
                        key={commit.sha}
                        className="flex items-start gap-3 px-6 py-3 hover:bg-muted/50 transition-colors"
                      >
                        {/* Author avatar (GitHub avatar URL) with fallback to commit icon */}
                        {commit.authorAvatarUrl ? (
                           
                          <img
                            src={commit.authorAvatarUrl}
                            alt={commit.author}
                            className="size-8 rounded-full shrink-0 mt-0.5 border border-border"
                            loading="lazy"
                          />
                        ) : (
                          <div className="flex size-8 items-center justify-center rounded-full bg-indigo-100 dark:bg-indigo-900/30 shrink-0 mt-0.5">
                            <GitCommit className="size-3.5 text-indigo-600 dark:text-indigo-400" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{commit.message}</p>
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            <span className="text-xs font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                              {commit.shortSha}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {commit.authorLogin ? `@${commit.authorLogin}` : commit.author}
                            </span>
                            <span className="text-xs text-muted-foreground">&middot;</span>
                            <span className="text-xs text-muted-foreground">{timeAgo(commit.date)}</span>
                            {commit.url && (
                              <a
                                href={commit.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-indigo-600 hover:underline inline-flex items-center gap-0.5"
                              >
                                <ExternalLink className="size-3" />
                                View
                              </a>
                            )}
                          </div>
                        </div>
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          {commit.branch}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Repositories Tab */}
        <TabsContent value="repos" className="mt-4">
          <Card className="rounded-xl">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <Github className="size-4 text-indigo-600" />
                  Repositories
                </CardTitle>
                <Badge variant="outline" className="text-xs">
                  {repos.length} repos
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {reposLoading ? (
                <div className="px-6 pb-4 space-y-1">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <RepoRowSkeleton key={i} />
                  ))}
                </div>
              ) : repos.length === 0 ? (
                <div className="px-6 pb-6 flex flex-col items-center py-8">
                  <Github className="size-8 text-muted-foreground/40 mb-2" />
                  <p className="text-sm text-muted-foreground">No repositories found</p>
                </div>
              ) : (
                <ScrollArea className="max-h-96">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Repository</TableHead>
                        <TableHead className="hidden sm:table-cell">Language</TableHead>
                        <TableHead className="hidden md:table-cell">Stars</TableHead>
                        <TableHead className="text-right">Updated</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {repos.map((repo) => (
                        <TableRow key={repo.fullName} className="group">
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Github className="size-4 text-muted-foreground shrink-0" />
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate group-hover:text-indigo-600 transition-colors flex items-center gap-1.5">
                                  {repo.fullName}
                                  {repo.private && (
                                    <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                                      <Lock className="size-2.5 mr-0.5" />
                                      Private
                                    </Badge>
                                  )}
                                  {repo.connected && (
                                    <Badge variant="outline" className="text-[10px] bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400">
                                      <CheckCircle2 className="size-2.5 mr-0.5" />
                                      Linked
                                    </Badge>
                                  )}
                                </p>
                                {repo.description && (
                                  <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                                    {repo.description}
                                  </p>
                                )}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="hidden sm:table-cell">
                            {repo.language ? (
                              <Badge variant="outline" className={`text-[10px] ${languageColor(repo.language)}`}>
                                {repo.language}
                              </Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            {typeof repo.stars === 'number' ? (
                              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                <Star className="size-3" />
                                {repo.stars}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground">
                            {repo.updatedAt ? timeAgo(repo.updatedAt) : '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Disconnect Confirmation */}
      <AlertDialog open={disconnectDialogOpen} onOpenChange={setDisconnectDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Unplug className="size-5 text-red-500" />
              Disconnect GitHub Integration
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to disconnect <strong>{integration.repoFullName}</strong> from{' '}
              <strong>{project.name}</strong>? Auto-deployments will stop and webhooks will be removed.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnecting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDisconnect}
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
    </div>
  )
}

// ─── Activity Feed ─────────────────────────────────────────────────

function ActivityFeed({ projects }: { projects: ProjectWithIntegration[] }) {
  // Generate activity events from integration data
  const events: ActivityEvent[] = []

  for (const project of projects) {
    if (project.githubIntegration) {
      const integration = project.githubIntegration

      // Connection event
      events.push({
        id: `conn-${integration.id}`,
        type: 'integration_connected',
        projectName: project.name,
        message: `Connected ${integration.repoFullName}`,
        timestamp: integration.createdAt,
        detail: `Branch: ${integration.branch}`,
      })

      // Auto-deploy events (simulated)
      if (integration.autoDeploy) {
        events.push({
          id: `deploy-${integration.id}`,
          type: 'auto_deploy_triggered',
          projectName: project.name,
          message: `Auto-deploy enabled for ${integration.branch}`,
          timestamp: integration.updatedAt,
          detail: `${integration.repoFullName} → ${project.subdomain}`,
        })
      }

      // No synthetic push event here.
      //
      // This used to append a "New push to <branch>" entry dated at a random
      // point in the last three days, for every integration, on every render.
      // It looked like real repository activity and was not — the timestamp
      // changed each time the panel loaded. Real pushes arrive through the
      // webhook and appear via the deployment records above.
    }
  }

  // Sort by timestamp descending
  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

  function eventIcon(type: ActivityEvent['type']) {
    switch (type) {
      case 'commit_pushed':
        return <GitCommit className="size-3.5 text-indigo-600 dark:text-indigo-400" />
      case 'auto_deploy_triggered':
        return <Zap className="size-3.5 text-amber-600 dark:text-amber-400" />
      case 'integration_connected':
        return <CheckCircle2 className="size-3.5 text-indigo-600 dark:text-indigo-400" />
      case 'integration_disconnected':
        return <XCircle className="size-3.5 text-red-500" />
    }
  }

  function eventBgColor(type: ActivityEvent['type']) {
    switch (type) {
      case 'commit_pushed':
        return 'bg-indigo-100 dark:bg-indigo-900/30'
      case 'auto_deploy_triggered':
        return 'bg-amber-100 dark:bg-amber-900/30'
      case 'integration_connected':
        return 'bg-indigo-100 dark:bg-indigo-900/30'
      case 'integration_disconnected':
        return 'bg-red-100 dark:bg-red-900/30'
    }
  }

  if (events.length === 0) {
    return (
      <Card className="rounded-xl border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-8">
          <Clock className="size-8 text-muted-foreground/40 mb-2" />
          <p className="text-sm text-muted-foreground">No activity yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Connect a repository to see GitHub activity here
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Clock className="size-4 text-indigo-600" />
          Activity Feed
        </CardTitle>
        <CardDescription>Recent GitHub events across all integrations</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="max-h-64">
          <div className="divide-y">
            {events.slice(0, 10).map((event) => (
              <div
                key={event.id}
                className="flex items-start gap-3 px-6 py-3 hover:bg-muted/50 transition-colors"
              >
                <div
                  className={`flex size-7 items-center justify-center rounded-full shrink-0 mt-0.5 ${eventBgColor(event.type)}`}
                >
                  {eventIcon(event.type)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{event.message}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <Badge variant="outline" className="text-[10px]">
                      {event.projectName}
                    </Badge>
                    {event.detail && (
                      <span className="text-xs text-muted-foreground truncate">{event.detail}</span>
                    )}
                  </div>
                </div>
                <span className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
                  {timeAgo(event.timestamp)}
                </span>
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

// ─── GitHub Account Card (OAuth status) ────────────────────────────

function GithubAccountCard({
  oauthIntegration,
  oauthEnabled,
  connecting,
  onConnect,
}: {
  oauthIntegration: GithubAccountIntegration | null
  oauthEnabled: boolean
  connecting: boolean
  onConnect: () => void
}) {
  if (!oauthEnabled) {
    return null
  }

  const connected = !!oauthIntegration
  const avatarUrl = connected
    ? `https://avatars.githubusercontent.com/${oauthIntegration!.username}?v=4`
    : null

  return (
    <Card
      className={`rounded-xl border ${
        connected
          ? 'border-indigo-200 dark:border-indigo-900/60 bg-gradient-to-br from-indigo-50/50 to-card dark:from-indigo-950/20'
          : 'border-dashed'
      }`}
    >
      <CardContent className="p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div
              className={`flex size-10 items-center justify-center rounded-xl shrink-0 ${
                connected
                  ? 'bg-indigo-100 dark:bg-indigo-900/40'
                  : 'bg-muted'
              }`}
            >
              {connected ? (
                avatarUrl ? (
                   
                  <img
                    src={avatarUrl}
                    alt={oauthIntegration!.username}
                    className="size-10 rounded-xl object-cover"
                  />
                ) : (
                  <Github className="size-5 text-indigo-600 dark:text-indigo-400" />
                )
              ) : (
                <KeyRound className="size-5 text-muted-foreground" />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-semibold">
                  GitHub Account
                </p>
                {connected ? (
                  <>
                    <Badge variant="outline" className="bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 text-[10px] gap-1">
                      <ShieldCheck className="size-2.5" />
                      Connected via OAuth
                    </Badge>
                    <span className="text-sm font-mono text-muted-foreground truncate">
                      @{oauthIntegration!.username}
                    </span>
                  </>
                ) : (
                  <Badge variant="outline" className="bg-gray-50 text-gray-500 dark:bg-gray-800/30 dark:text-gray-400 text-[10px]">
                    Not connected
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {connected
                  ? 'Your GitHub account is authorized. Use "Connect Repo" to link a repository to a project.'
                  : 'Authorize your GitHub account to list real repositories, view commit history with avatars, and enable auto-deploy on push.'}
              </p>
            </div>
          </div>
          <Button
            onClick={onConnect}
            disabled={connecting}
            variant={connected ? 'outline' : 'default'}
            className={
              connected
                ? 'shrink-0'
                : 'bg-indigo-600 hover:bg-indigo-700 text-white shrink-0'
            }
            size="sm"
          >
            {connecting ? (
              <>
                <Loader2 className="size-4 mr-2 animate-spin" />
                Redirecting...
              </>
            ) : connected ? (
              <>
                <RefreshCw className="size-4 mr-2" />
                Re-authorize
              </>
            ) : (
              <>
                <Github className="size-4 mr-2" />
                Connect with GitHub
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Main Component ────────────────────────────────────────────────

export default function GithubPanel() {
  const [projects, setProjects] = useState<ProjectWithIntegration[]>([])
  const [loading, setLoading] = useState(true)
  const [showConnect, setShowConnect] = useState(false)
  const [selectedIntegration, setSelectedIntegration] = useState<{
    project: ProjectWithIntegration
    integration: GithubIntegration
  } | null>(null)

  // OAuth state
  const [oauthIntegration, setOauthIntegration] =
    useState<GithubAccountIntegration | null>(null)
  const [oauthEnabled, setOauthEnabled] = useState(false)
  const [oauthConnecting, setOauthConnecting] = useState(false)

  const fetchOauthStatus = useCallback(async () => {
    try {
      const data = await apiFetch('/github/me')
      setOauthIntegration(data.integration || null)
      setOauthEnabled(!!data.oauthEnabled)
    } catch {
      // Non-fatal — assume demo mode.
      setOauthEnabled(false)
    }
  }, [])

  const fetchProjects = useCallback(async () => {
    try {
      const data = await apiFetch('/hosting')
      const rawProjects: Project[] = data.projects || []

      // For each project, check if it has a GitHub integration
      const projectsWithIntegration: ProjectWithIntegration[] = await Promise.all(
        rawProjects.map(async (project) => {
          try {
            // Fetch project detail which includes githubIntegration
            const detailData = await apiFetch(`/hosting/${project.id}`)
            return {
              ...project,
              githubIntegration: detailData.project?.githubIntegration || null,
            }
          } catch {
            return { ...project, githubIntegration: null }
          }
        })
      )

      setProjects(projectsWithIntegration)
    } catch {
      toast.error('Failed to load projects')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchProjects()
    fetchOauthStatus()
  }, [fetchProjects, fetchOauthStatus])

  // ── Handle OAuth callback URL params ──────────────────────────
  // The /api/github/oauth/callback route redirects back to /?tab=github
  // with one of: github_connected=1, github_error=..., github_message=...
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('github_connected')
    const error = params.get('github_error')
    const message = params.get('github_message')
    const username = params.get('username')

    if (connected === '1') {
      toast.success(
        username
          ? `GitHub account @${username} connected successfully!`
          : 'GitHub account connected successfully!'
      )
      // Refresh OAuth status to pick up the new integration.
      fetchOauthStatus()
      fetchProjects()
    } else if (error) {
      toast.error(
        message || 'GitHub OAuth failed. Please try again.'
      )
    }

    // Clean up the URL so the toast doesn't re-appear on refresh.
    if (connected || error) {
      const newUrl = window.location.pathname + window.location.hash
      window.history.replaceState({}, '', newUrl)
    }
  }, [fetchOauthStatus, fetchProjects])

  /**
   * Kick off the GitHub OAuth flow from the top-level account card.
   * Same logic as the dialog's "Connect with GitHub" button.
   */
  const handleStartOauth = async () => {
    setOauthConnecting(true)
    try {
      const data = await apiFetch('/github/oauth/start')
      if (data.demoMode) {
        toast.info(
          data.message ||
            'GitHub OAuth is in demo mode. Use "Connect Manually" instead.'
        )
        return
      }
      if (!data.url) {
        toast.error('Failed to start OAuth flow')
        return
      }
      window.location.href = data.url
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start OAuth')
    } finally {
      setOauthConnecting(false)
    }
  }

  const connectedCount = projects.filter((p) => p.githubIntegration).length
  const disconnectedCount = projects.filter((p) => !p.githubIntegration).length

  // Detail View
  if (selectedIntegration) {
    return (
      <IntegrationDetailView
        project={selectedIntegration.project}
        integration={selectedIntegration.integration}
        onBack={() => setSelectedIntegration(null)}
        onRefresh={fetchProjects}
      />
    )
  }

  // List View
  return (
    <div className="space-y-6">
      {/* Overview Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-indigo-100 dark:bg-indigo-900/30 shrink-0">
            <Github className="size-5 text-indigo-600 dark:text-indigo-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-2xl font-bold">GitHub Integration</h2>
              {projects.length > 0 && (
                <Badge className="bg-indigo-600 text-white text-[10px] px-1.5 py-0">
                  {connectedCount} connected
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              Connect repositories, manage auto-deployments, and track commits
            </p>
          </div>
        </div>
        <Button
          onClick={() => setShowConnect(true)}
          className="bg-indigo-600 hover:bg-indigo-700 text-white shrink-0"
        >
          <Plus className="size-4 mr-2" />
          Connect Repo
        </Button>
      </div>

      {/* GitHub Account (OAuth) Card */}
      <GithubAccountCard
        oauthIntegration={oauthIntegration}
        oauthEnabled={oauthEnabled}
        connecting={oauthConnecting}
        onConnect={handleStartOauth}
      />

      {/* Stats Row */}
      {!loading && projects.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card className="rounded-xl">
            <CardContent className="p-4">
              <div className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center rounded-lg bg-indigo-100 dark:bg-indigo-900/30">
                  <Github className="size-4 text-indigo-600 dark:text-indigo-400" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{connectedCount}</p>
                  <p className="text-xs text-muted-foreground">Connected</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="rounded-xl">
            <CardContent className="p-4">
              <div className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800/30">
                  <Unplug className="size-4 text-gray-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{disconnectedCount}</p>
                  <p className="text-xs text-muted-foreground">Disconnected</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="rounded-xl">
            <CardContent className="p-4">
              <div className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900/30">
                  <Zap className="size-4 text-amber-600 dark:text-amber-400" />
                </div>
                <div>
                  <p className="text-2xl font-bold">
                    {projects.filter((p) => p.githubIntegration?.autoDeploy).length}
                  </p>
                  <p className="text-xs text-muted-foreground">Auto-deploy</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="rounded-xl">
            <CardContent className="p-4">
              <div className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center rounded-lg bg-indigo-100 dark:bg-indigo-900/30">
                  <GitBranch className="size-4 text-indigo-600 dark:text-indigo-400" />
                </div>
                <div>
                  <p className="text-2xl font-bold">
                    {new Set(projects.filter((p) => p.githubIntegration).map((p) => p.githubIntegration?.username)).size}
                  </p>
                  <p className="text-xs text-muted-foreground">GitHub Users</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Integration List */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <IntegrationCardSkeleton />
          <IntegrationCardSkeleton />
          <IntegrationCardSkeleton />
          <IntegrationCardSkeleton />
        </div>
      ) : projects.length === 0 ? (
        <Card className="rounded-xl border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Github className="size-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold mb-1">No projects yet</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Create a hosting project first, then connect it to GitHub
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {projects.map((project) => {
            const isConnected = !!project.githubIntegration
            return (
              <Card
                key={project.id}
                className={`group transition-all rounded-xl ${
                  isConnected
                    ? 'cursor-pointer hover:shadow-lg hover:border-indigo-200 dark:hover:border-indigo-800 hover:bg-gradient-to-br hover:from-card hover:to-indigo-50/30 dark:hover:to-indigo-950/10'
                    : ''
                } relative overflow-hidden`}
                onClick={() => {
                  if (isConnected && project.githubIntegration) {
                    setSelectedIntegration({ project, integration: project.githubIntegration })
                  }
                }}
              >
                {/* Subtle gradient overlay on hover for connected projects */}
                {isConnected && (
                  <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/0 to-indigo-500/0 group-hover:from-indigo-500/5 group-hover:to-transparent transition-all pointer-events-none" />
                )}

                <CardHeader className="pb-2 relative">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <Github className={`size-4 ${isConnected ? 'text-indigo-600 dark:text-indigo-400' : 'text-muted-foreground'}`} />
                      <CardTitle className="text-base">{project.name}</CardTitle>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={`text-[10px] ${frameworkColor(project.framework)}`}>
                        {frameworkLabel(project.framework)}
                      </Badge>
                      {isConnected ? (
                        <Badge variant="outline" className="bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400 text-[10px]">
                          <CheckCircle2 className="size-2.5 mr-0.5" />
                          Connected
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-gray-50 text-gray-500 dark:bg-gray-800/30 dark:text-gray-400 text-[10px]">
                          <XCircle className="size-2.5 mr-0.5" />
                          Disconnected
                        </Badge>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="relative">
                  {isConnected && project.githubIntegration ? (
                    <>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground font-mono">
                        <GitBranch className="size-3" />
                        {project.githubIntegration.repoFullName}
                      </div>
                      <div className="mt-2 flex items-center gap-3 flex-wrap">
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <GitBranch className="size-3" />
                          {project.githubIntegration.branch}
                        </div>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          {project.githubIntegration.autoDeploy ? (
                            <>
                              <Zap className="size-3 text-amber-500" />
                              <span className="text-amber-600 dark:text-amber-400">Auto-deploy</span>
                            </>
                          ) : (
                            <>
                              <XCircle className="size-3" />
                              <span>Manual</span>
                            </>
                          )}
                        </div>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="size-3" />
                          {timeAgo(project.githubIntegration.createdAt)}
                        </div>
                        {project.githubIntegration.oauthConnected && (
                          <div className="flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-400">
                            <ShieldCheck className="size-3" />
                            <span>OAuth</span>
                          </div>
                        )}
                      </div>
                      <div className="mt-3 flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Click to view details</span>
                        <ChevronRight className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-muted-foreground">
                        No GitHub repository connected
                      </p>
                      <div className="mt-3">
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-xs"
                          onClick={(e) => {
                            e.stopPropagation()
                            setShowConnect(true)
                          }}
                        >
                          <Plus className="size-3 mr-1" />
                          Connect Repository
                        </Button>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Activity Feed */}
      {!loading && projects.length > 0 && <ActivityFeed projects={projects} />}

      {/* Connect Repository Dialog */}
      <ConnectRepositoryDialog
        open={showConnect}
        onClose={() => setShowConnect(false)}
        projects={projects}
        onConnected={fetchProjects}
        oauthEnabled={oauthEnabled}
        oauthIntegration={oauthIntegration}
      />
    </div>
  )
}
