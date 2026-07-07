'use client'

/**
 * Create Website Wizard
 * =====================
 *
 * Multi-step dialog for deploying a new website on Apsamo Panel. Walks the
 * user through 4 steps:
 *
 *   1. Website name           → live subdomain preview + plan-limit side panel
 *   2. Domain                 → subdomain / existing / new
 *   3. Deployment method      → 8 methods + per-method config form
 *   4. Review & deploy        → summary card → live deployment timeline
 *
 * Submits to POST /api/hosting/create and polls GET /api/hosting/[id]/stages
 * for live progress. ZIP uploads go through POST /api/hosting/upload.
 *
 * Wired to the shared 8-method catalog in `@/lib/deployment-methods`.
 */

import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Container,
  Database,
  Eye,
  EyeOff,
  FileCode,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  Hash,
  Hexagon,
  Info,
  Key,
  Layout,
  Loader2,
  Minus,
  MinusCircle,
  Package,
  Plus,
  Rocket,
  Server,
  Settings,
  ShieldCheck,
  Terminal,
  Trash2,
  Triangle,
  Upload,
  X,
  XCircle,
  ExternalLink,
  AlertTriangle,
  RefreshCw,
  Lock,
  Cpu,
  HardDrive,
} from 'lucide-react'

import {
  DEPLOYMENT_METHODS,
  type DeploymentMethod,
  type DeploymentMethodId,
  type MethodCategory,
  type MethodField,
  getDeploymentMethod,
  getMethodsByCategory,
} from '@/lib/deployment-methods'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { toast } from 'sonner'

/* ────────────────────────────────────────────────────────────────────────── */
/*  Types                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

interface CreateWebsiteWizardProps {
  open: boolean
  onClose: () => void
  onCreated: (project: { id: string; name: string }) => void
}

type Step = 1 | 2 | 3 | 4

type DomainType = 'subdomain' | 'existing' | 'new'

type Source = 'git' | 'zip' | 'manual'

type GitProvider = 'github' | 'gitlab' | 'bitbucket' | 'custom'

interface PlanInfo {
  id: string
  name: string
  ram: string
  cpu: string
  storage: string
  bandwidth: string
  projects: number
  customDomain: boolean
  ssl: boolean
}

interface SubscriptionInfo {
  plan: PlanInfo
  status: string
}

interface UserInfo {
  id: string
  name: string
  email: string
  subscriptions: SubscriptionInfo[]
}

interface DomainInfo {
  id: string
  name: string
  status: string
}

interface UploadInfo {
  uploadId: string
  filename: string
  sizeBytes: number
}

interface EnvVar {
  key: string
  value: string
}

interface DeploymentStageInfo {
  id: string
  name: string
  label: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  message?: string | null
  log?: string | null
  order: number
  startedAt?: string | null
  completedAt?: string | null
  durationMs?: number | null
}

interface CreatedProjectInfo {
  id: string
  name: string
  slug: string
  subdomain: string
  deploymentMethod?: string | null
  customDomain?: string | null
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants & helpers                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

const SUBDOMAIN_SUFFIX = process.env.NEXT_PUBLIC_BRAND_DOMAIN || 'apsamo.com'
const MAX_ZIP_SIZE = 500 * 1024 * 1024 // 500 MB
const POLL_INTERVAL_MS = 1500

const STEP_LABELS = ['Name', 'Domain', 'Method', 'Review'] as const

const CATEGORY_LABELS: Record<MethodCategory, string> = {
  cms: 'CMS',
  framework: 'Frameworks',
  language: 'Languages',
  container: 'Container',
  custom: 'Custom',
}

/** Map the catalog's `icon` string → a Lucide component. */
const ICON_REGISTRY: Record<string, React.ComponentType<{ className?: string }>> = {
  Layout,
  Triangle,
  Hexagon,
  FileCode,
  Terminal,
  Container,
  Settings,
}

function getMethodIcon(iconName: string): React.ComponentType<{ className?: string }> {
  return ICON_REGISTRY[iconName] || FileCode
}

/** Auth headers — same pattern as the hosting panel. */
function getAuthHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('apsamo_token') : null
  return {
    Authorization: `Bearer ${token || ''}`,
    'Content-Type': 'application/json',
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const val = bytes / Math.pow(k, i)
  return `${val.toFixed(val < 10 && i > 0 ? 1 : 0)} ${sizes[i]}`
}

function isValidGitUrl(url: string): boolean {
  if (!url) return false
  // Accept http(s) git URLs and git@... SSH URLs.
  return /^(https?:\/\/|git@)[\w.-]+[:/][\w.-]+\/[\w.-]+(?:\.git)?$/i.test(url.trim())
}

function isValidDomain(domain: string): boolean {
  // Reasonable domain regex.
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain.trim())
}

/** Pre-populated env vars per method (Laravel gets sensible production defaults). */
function defaultEnvVarsFor(methodId: DeploymentMethodId | null): EnvVar[] {
  if (methodId === 'laravel') {
    return [
      { key: 'APP_ENV', value: 'production' },
      { key: 'APP_DEBUG', value: 'false' },
      { key: 'LOG_CHANNEL', value: 'stack' },
    ]
  }
  return []
}

/** Initial stage set used as a fallback when the API has no DeploymentStage rows yet. */
const FALLBACK_STAGES: Array<{ name: string; label: string }> = [
  { name: 'create_container', label: 'Provisioning container' },
  { name: 'download_source', label: 'Fetching source code' },
  { name: 'install_deps', label: 'Installing dependencies' },
  { name: 'build_project', label: 'Building project' },
  { name: 'start_services', label: 'Starting services' },
  { name: 'configure_ssl', label: 'Issuing SSL certificate' },
]

/* ────────────────────────────────────────────────────────────────────────── */
/*  Sub-components                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

function Stepper({
  step,
  maxReachable,
  onStepClick,
}: {
  step: Step
  maxReachable: Step
  onStepClick: (s: Step) => void
}) {
  return (
    <ol className="mt-4 flex flex-wrap items-center gap-y-2 text-sm">
      {STEP_LABELS.map((label, i) => {
        const n = (i + 1) as Step
        const isCurrent = step === n
        const isDone = step > n
        const isReachable = n <= maxReachable
        return (
          <li key={label} className="flex items-center">
            <button
              type="button"
              disabled={!isReachable}
              onClick={() => isReachable && onStepClick(n)}
              className={`flex items-center gap-2 rounded-full px-3 py-1.5 transition-colors ${
                isCurrent
                  ? 'bg-primary text-primary-foreground'
                  : isDone
                    ? 'text-foreground hover:bg-accent'
                    : isReachable
                      ? 'text-muted-foreground hover:bg-accent'
                      : 'text-muted-foreground/50 cursor-not-allowed'
              }`}
            >
              <span
                className={`flex size-5 items-center justify-center rounded-full border text-xs font-semibold ${
                  isCurrent
                    ? 'border-primary-foreground'
                    : isDone
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border'
                }`}
              >
                {isDone ? <Check className="size-3" /> : n}
              </span>
              <span className="font-medium">{label}</span>
            </button>
            {i < STEP_LABELS.length - 1 && (
              <ChevronRight className="mx-1 size-4 text-muted-foreground/60" />
            )}
          </li>
        )
      })}
    </ol>
  )
}

function PlanLimitsPanel({
  plan,
  projectCount,
  loading,
}: {
  plan: PlanInfo | null
  projectCount: number
  loading: boolean
}) {
  if (loading) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-4 space-y-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </CardContent>
      </Card>
    )
  }
  if (!plan) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-4 text-sm text-muted-foreground">
          No active subscription. The free tier allows 1 project.
        </CardContent>
      </Card>
    )
  }
  const atLimit = projectCount >= plan.projects
  return (
    <Card className={atLimit ? 'border-destructive/40 bg-destructive/5' : 'border-dashed'}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" />
          <span className="text-sm font-semibold">
            Your plan: <span className="text-primary">{plan.name}</span>
          </span>
        </div>
        <div className="space-y-1.5 text-xs text-muted-foreground">
          <div className="flex items-center justify-between">
            <span>Websites</span>
            <span className={atLimit ? 'font-semibold text-destructive' : 'text-foreground'}>
              {projectCount}/{plan.projects}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>RAM</span>
            <span className="text-foreground">{plan.ram}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>CPU</span>
            <span className="text-foreground">{plan.cpu}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Storage</span>
            <span className="text-foreground">{plan.storage}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Bandwidth</span>
            <span className="text-foreground">{plan.bandwidth}</span>
          </div>
        </div>
        {atLimit && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs">
            <p className="font-medium text-destructive">Project limit reached</p>
            <p className="mt-0.5 text-muted-foreground">
              Upgrade your plan to deploy more websites.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-7 w-full border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={() => {
                window.location.href = '/dashboard?tab=billing'
              }}
            >
              Upgrade Plan
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function MethodCard({
  method,
  selected,
  onClick,
}: {
  method: DeploymentMethod
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative flex w-full flex-col gap-1.5 rounded-lg border p-3 text-left transition-all hover:border-primary/50 hover:shadow-sm ${
        selected ? 'border-primary ring-1 ring-primary bg-primary/5' : 'border-border'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={`flex size-8 items-center justify-center rounded-md ${
              selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
            }`}
          >
            {React.createElement(ICON_REGISTRY[method.icon] || FileCode, { className: 'size-4' })}
          </span>
          <span className="text-sm font-semibold leading-tight">{method.name}</span>
        </div>
        {selected && <Check className="size-4 shrink-0 text-primary" />}
      </div>
      <p className="text-xs text-muted-foreground line-clamp-2">{method.tagline}</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {method.needsDatabase && (
          <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px] font-normal">
            <Database className="size-2.5" />
            DB included
          </Badge>
        )}
        {method.supportsGit && (
          <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px] font-normal">
            <GitCommitHorizontal className="size-2.5" />
            Git
          </Badge>
        )}
        {method.supportsZip && (
          <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px] font-normal">
            <Package className="size-2.5" />
            ZIP
          </Badge>
        )}
      </div>
    </button>
  )
}

function MethodFieldInput({
  field,
  value,
  onChange,
}: {
  field: MethodField
  value: string
  onChange: (v: string) => void
}) {
  const [show, setShow] = useState(false)

  if (field.type === 'select' && field.options) {
    return (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={field.placeholder || 'Select…'} />
        </SelectTrigger>
        <SelectContent>
          {field.options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  const isSecret = field.secret
  const type = isSecret ? (show ? 'text' : 'password') : field.type

  return (
    <div className="relative">
      <Input
        type={type}
        value={value}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {isSecret && (
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label={show ? 'Hide value' : 'Show value'}
        >
          {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      )}
    </div>
  )
}

function EnvVarsEditor({
  vars,
  onChange,
}: {
  vars: EnvVar[]
  onChange: (next: EnvVar[]) => void
}) {
  const update = (i: number, patch: Partial<EnvVar>) => {
    onChange(vars.map((v, idx) => (idx === i ? { ...v, ...patch } : v)))
  }
  const remove = (i: number) => onChange(vars.filter((_, idx) => idx !== i))
  const add = () => onChange([...vars, { key: '', value: '' }])

  return (
    <div className="space-y-2">
      {vars.length === 0 && (
        <p className="text-xs text-muted-foreground">No environment variables set.</p>
      )}
      {vars.map((v, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            placeholder="KEY"
            value={v.key}
            onChange={(e) => update(i, { key: e.target.value })}
            className="flex-1 font-mono text-xs"
          />
          <span className="text-muted-foreground">=</span>
          <Input
            placeholder="value"
            value={v.value}
            onChange={(e) => update(i, { value: e.target.value })}
            className="flex-1 font-mono text-xs"
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => remove(i)}
            aria-label="Remove env var"
            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" onClick={add} className="h-7 text-xs">
        <Plus className="mr-1 size-3.5" />
        Add variable
      </Button>
    </div>
  )
}

function UploadDropzone({
  upload,
  progress,
  uploading,
  error,
  onFile,
  onClear,
}: {
  upload: UploadInfo | null
  progress: number
  uploading: boolean
  error: string | null
  onFile: (file: File) => void
  onClear: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) onFile(file)
  }

  if (upload) {
    return (
      <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Package className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{upload.filename}</p>
            <p className="text-xs text-muted-foreground">{formatBytes(upload.sizeBytes)} · uploaded</p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onClear}
            className="h-8 text-muted-foreground hover:text-destructive"
          >
            <X className="mr-1 size-4" />
            Remove
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
          dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
        }`}
      >
        <div className="flex size-10 items-center justify-center rounded-full bg-muted">
          {uploading ? (
            <Loader2 className="size-5 animate-spin text-primary" />
          ) : (
            <Upload className="size-5 text-muted-foreground" />
          )}
        </div>
        <div>
          <p className="text-sm font-medium">
            {uploading ? 'Uploading…' : 'Drop your .zip here or click to browse'}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Max 500 MB · ZIP archives only
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onFile(f)
            e.currentTarget.value = ''
          }}
        />
      </div>
      {uploading && (
        <div className="space-y-1">
          <Progress value={progress} className="h-1.5" />
          <p className="text-right text-xs text-muted-foreground">{Math.round(progress)}%</p>
        </div>
      )}
      {error && (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3.5" />
          {error}
        </p>
      )}
    </div>
  )
}

function StageIcon({ status }: { status: DeploymentStageInfo['status'] }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="size-5 text-primary" />
    case 'running':
      return <Loader2 className="size-5 animate-spin text-primary" />
    case 'failed':
      return <XCircle className="size-5 text-destructive" />
    case 'skipped':
      return <MinusCircle className="size-5 text-muted-foreground" />
    case 'pending':
    default:
      return <Circle className="size-5 text-muted-foreground/60" />
  }
}

function StageStatusBadge({ status }: { status: DeploymentStageInfo['status'] }) {
  const cls = {
    completed: 'bg-primary/10 text-primary',
    running: 'bg-primary/10 text-primary animate-pulse',
    failed: 'bg-destructive/10 text-destructive',
    skipped: 'bg-muted text-muted-foreground',
    pending: 'bg-muted text-muted-foreground',
  }[status]
  return (
    <Badge variant="secondary" className={`text-[10px] capitalize ${cls}`}>
      {status}
    </Badge>
  )
}

function formatDuration(ms?: number | null): string {
  if (!ms || ms <= 0) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Main component                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

export default function CreateWebsiteWizard({
  open,
  onClose,
  onCreated,
}: CreateWebsiteWizardProps) {
  /* ── Step state ───────────────────────────────────────────────────────── */
  const [step, setStep] = useState<Step>(1)
  const [maxReached, setMaxReached] = useState<Step>(1)

  /* ── Form state ───────────────────────────────────────────────────────── */
  const [name, setName] = useState('')
  const [domainType, setDomainType] = useState<DomainType>('subdomain')
  const [existingDomain, setExistingDomain] = useState<string>('')
  const [newDomain, setNewDomain] = useState('')
  const [methodId, setMethodId] = useState<DeploymentMethodId | null>(null)
  const [source, setSource] = useState<Source>('git')
  const [gitProvider, setGitProvider] = useState<GitProvider>('github')
  const [gitUrl, setGitUrl] = useState('')
  const [gitBranch, setGitBranch] = useState('main')
  const [gitToken, setGitToken] = useState('')
  const [upload, setUpload] = useState<UploadInfo | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [envVars, setEnvVars] = useState<EnvVar[]>([])
  const [showEnv, setShowEnv] = useState(false)
  const [envTouched, setEnvTouched] = useState(false)

  /* ── Reference data ───────────────────────────────────────────────────── */
  const [plan, setPlan] = useState<PlanInfo | null>(null)
  const [projectCount, setProjectCount] = useState(0)
  const [planLoading, setPlanLoading] = useState(true)
  const [domains, setDomains] = useState<DomainInfo[]>([])
  const [domainsLoading, setDomainsLoading] = useState(true)

  /* ── Deployment / progress state ──────────────────────────────────────── */
  const [submitting, setSubmitting] = useState(false)
  const [createdProject, setCreatedProject] = useState<CreatedProjectInfo | null>(null)
  const [deploymentId, setDeploymentId] = useState<string | null>(null)
  const [stages, setStages] = useState<DeploymentStageInfo[]>([])
  const [deployError, setDeployError] = useState<string | null>(null)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [deployDone, setDeployDone] = useState<'live' | 'failed' | null>(null)

  const logEndRef = useRef<HTMLDivElement>(null)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* ── Derived values ───────────────────────────────────────────────────── */
  const slug = useMemo(() => slugify(name), [name])
  const subdomainPreview = useMemo(() => `${slug}.${SUBDOMAIN_SUFFIX}`, [slug])
  const selectedMethod = useMemo(
    () => (methodId ? getDeploymentMethod(methodId) : null),
    [methodId]
  )

  // Effective source: some methods force a specific source.
  const effectiveSource: Source = useMemo(() => {
    if (!selectedMethod) return source
    // WordPress is one-click only.
    if (selectedMethod.id === 'wordpress') return 'manual'
    // Docker requires source files.
    if (selectedMethod.id === 'docker' && source === 'manual') return 'git'
    if (selectedMethod.id === 'laravel' && source === 'manual') return 'git'
    return source
  }, [selectedMethod, source])

  const atProjectLimit = !!plan && projectCount >= plan.projects

  /* ── Reset on open ────────────────────────────────────────────────────── */
  useEffect(() => {
    if (open) {
      setStep(1)
      setMaxReached(1)
      setName('')
      setDomainType('subdomain')
      setExistingDomain('')
      setNewDomain('')
      setMethodId(null)
      setSource('git')
      setGitProvider('github')
      setGitUrl('')
      setGitBranch('main')
      setGitToken('')
      setUpload(null)
      setUploadProgress(0)
      setUploading(false)
      setUploadError(null)
      setFieldValues({})
      setEnvVars([])
      setShowEnv(false)
      setEnvTouched(false)
      setSubmitting(false)
      setCreatedProject(null)
      setDeploymentId(null)
      setStages([])
      setDeployError(null)
      setDeployDone(null)
    } else {
      // Stop polling when dialog closes.
      if (pollRef.current) {
        clearTimeout(pollRef.current)
        pollRef.current = null
      }
    }
  }, [open])

  /* ── Fetch plan limits + existing project count ──────────────────────── */
  const loadPlanAndProjects = useCallback(async () => {
    setPlanLoading(true)
    try {
      const [meRes, projectsRes] = await Promise.all([
        fetch('/api/auth/me', { headers: getAuthHeaders() }),
        fetch('/api/hosting', { headers: getAuthHeaders() }),
      ])
      const meData = await meRes.json()
      const projectsData = await projectsRes.json()
      const activeSub = meData?.user?.subscriptions?.find(
        (s: SubscriptionInfo) => s.status === 'active'
      )
      if (activeSub?.plan) {
        setPlan(activeSub.plan)
      } else {
        setPlan(null)
      }
      const count = Array.isArray(projectsData?.projects)
        ? projectsData.projects.length
        : 0
      setProjectCount(count)
    } catch {
      // Soft-fail: leave plan null.
      setPlan(null)
    } finally {
      setPlanLoading(false)
    }
  }, [])

  /* ── Fetch existing domains ───────────────────────────────────────────── */
  const loadDomains = useCallback(async () => {
    setDomainsLoading(true)
    try {
      const res = await fetch('/api/domains', { headers: getAuthHeaders() })
      const data = await res.json()
      const list: DomainInfo[] = (data?.domains || []).filter(
        (d: DomainInfo) => d.status === 'active'
      )
      setDomains(list)
    } catch {
      setDomains([])
    } finally {
      setDomainsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      void loadPlanAndProjects()
      void loadDomains()
    }
  }, [open, loadPlanAndProjects, loadDomains])

  /* ── When method changes: prefill field defaults + env vars ───────────── */
  const selectMethod = useCallback((id: DeploymentMethodId) => {
    const m = getDeploymentMethod(id)
    if (!m) return
    setMethodId(id)
    const next: Record<string, string> = {}
    for (const f of m.fields) {
      if (f.defaultValue !== undefined && f.defaultValue !== null) {
        next[f.id] = String(f.defaultValue)
      }
    }
    setFieldValues(next)
    // Reset env vars to method defaults unless user has edited them.
    setEnvVars(defaultEnvVarsFor(id))
    setEnvTouched(false)
    // Pick a valid default source for this method.
    if (m.id === 'wordpress') {
      setSource('manual')
    } else if (!m.supportsGit && !m.supportsZip && m.supportsManual) {
      setSource('manual')
    } else if (!m.supportsManual) {
      // Docker / Laravel — git is default.
      setSource(m.supportsGit ? 'git' : 'zip')
    } else {
      setSource(m.supportsGit ? 'git' : m.supportsZip ? 'zip' : 'manual')
    }
  }, [])

  /* ── ZIP upload ───────────────────────────────────────────────────────── */
  const startUpload = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setUploadError('Please upload a .zip archive.')
      return
    }
    if (file.size > MAX_ZIP_SIZE) {
      setUploadError(`File too large. Max ${formatBytes(MAX_ZIP_SIZE)}.`)
      return
    }
    setUploading(true)
    setUploadProgress(0)
    setUploadError(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      // Use XHR for upload progress events.
      const xhr = new XMLHttpRequest()
      const result = await new Promise<{ uploadId: string; filename: string; sizeBytes: number }>(
        (resolve, reject) => {
          xhr.open('POST', '/api/hosting/upload')
          const token =
            typeof window !== 'undefined' ? localStorage.getItem('apsamo_token') : null
          if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              setUploadProgress((e.loaded / e.total) * 100)
            }
          }
          xhr.onload = () => {
            try {
              const data = JSON.parse(xhr.responseText)
              if (xhr.status >= 200 && xhr.status < 300 && data.uploadId) {
                resolve(data)
              } else {
                reject(new Error(data.error || 'Upload failed'))
              }
            } catch {
              reject(new Error('Upload failed — invalid response'))
            }
          }
          xhr.onerror = () => reject(new Error('Network error during upload'))
          xhr.send(formData)
        }
      )
      setUpload({
        uploadId: result.uploadId,
        filename: result.filename || file.name,
        sizeBytes: result.sizeBytes || file.size,
      })
      setUploadProgress(100)
      toast.success('Upload complete')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed'
      setUploadError(msg)
      toast.error(msg)
    } finally {
      setUploading(false)
    }
  }, [])

  /* ── Submit (deploy) ──────────────────────────────────────────────────── */
  const buildPayload = useCallback(() => {
    if (!selectedMethod) return null
    const method = selectedMethod
    const config: Record<string, unknown> = {}

    // Method-specific fields.
    for (const f of method.fields) {
      if (f.showForSources && !f.showForSources.includes(effectiveSource)) continue
      const v = fieldValues[f.id]
      if (v === undefined || v === '') continue
      if (f.type === 'number') {
        const n = Number(v)
        if (!Number.isNaN(n)) config[f.id] = n
      } else {
        config[f.id] = v
      }
    }
    // Always include framework + runtimeVersion + build/start commands.
    if (method.runtime && !config.runtime) config.runtime = method.runtime
    if (method.defaultRuntimeVersion && !config.runtimeVersion) {
      config.runtimeVersion = method.defaultRuntimeVersion
    }
    if (envVars.length > 0) {
      config.envVars = envVars.filter((v) => v.key.trim()).map((v) => ({ key: v.key, value: v.value }))
    }

    // Resolve domain.
    let domain: string | undefined
    if (domainType === 'existing') domain = existingDomain
    else if (domainType === 'new') domain = newDomain.trim()
    // subdomain leaves domain undefined.

    return {
      name: name.trim(),
      domainType,
      domain,
      method: method.id,
      source: effectiveSource,
      gitUrl: effectiveSource === 'git' ? gitUrl.trim() : undefined,
      gitBranch: effectiveSource === 'git' ? gitBranch.trim() : undefined,
      gitProvider: effectiveSource === 'git' ? gitProvider : undefined,
      gitToken: effectiveSource === 'git' && gitToken ? gitToken : undefined,
      uploadId: effectiveSource === 'zip' && upload ? upload.uploadId : undefined,
      config,
      // Also pass framework so the legacy create route accepts the request
      // (the new wizard-aware route will use `method` instead).
      framework: method.stack || method.id,
    }
  }, [
    selectedMethod,
    fieldValues,
    envVars,
    domainType,
    existingDomain,
    newDomain,
    effectiveSource,
    name,
    gitUrl,
    gitBranch,
    gitProvider,
    gitToken,
    upload,
  ])

  const handleSubmit = useCallback(async () => {
    if (atProjectLimit) {
      toast.error('You have reached your project limit. Upgrade to deploy more.')
      return
    }
    setSubmitting(true)
    setDeployError(null)
    setDeployDone(null)
    setStages([])
    try {
      const payload = buildPayload()
      if (!payload) {
        setSubmitting(false)
        return
      }
      const res = await fetch('/api/hosting/create', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) {
        setDeployError(data.error || 'Failed to create website')
        setSubmitting(false)
        return
      }
      const proj: CreatedProjectInfo = {
        id: data.project.id,
        name: data.project.name,
        slug: data.project.slug,
        subdomain: data.project.subdomain,
        deploymentMethod: data.project.deploymentMethod || payload.method,
        customDomain: data.project.customDomain || null,
      }
      setCreatedProject(proj)
      setDeploymentId(data.deployment?.id || null)
      // Seed initial stages from the response if available, else fallback.
      const initialStages: DeploymentStageInfo[] =
        Array.isArray(data.deployment?.stages) && data.deployment.stages.length > 0
          ? data.deployment.stages
          : FALLBACK_STAGES.map((s, i) => ({
              id: `seed-${s.name}`,
              name: s.name,
              label: s.label,
              status: i === 0 ? 'running' : 'pending',
              order: i,
            }))
      setStages(initialStages)
      // Start polling for stage progress.
      void pollStages(proj.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error'
      setDeployError(msg)
      setSubmitting(false)
    }
  }, [atProjectLimit, buildPayload])

  /* ── Poll stages ──────────────────────────────────────────────────────── */
  const pollStages = useCallback(
    async (projectId: string) => {
      try {
        const res = await fetch(`/api/hosting/${projectId}/stages`, {
          headers: getAuthHeaders(),
        })
        if (res.ok) {
          const data = await res.json()
          const newStages: DeploymentStageInfo[] =
            Array.isArray(data.stages) && data.stages.length > 0
              ? data.stages
              : stages
          setStages(newStages)
          // Check terminal states.
          const failed = newStages.some((s) => s.status === 'failed')
          const allDone =
            newStages.length > 0 && newStages.every((s) => s.status === 'completed' || s.status === 'skipped')
          if (failed) {
            const failedStage = newStages.find((s) => s.status === 'failed')
            setDeployError(
              failedStage?.message ||
                failedStage?.log ||
                'A deployment stage failed. Check the logs below.'
            )
            setDeployDone('failed')
            setSubmitting(false)
            return
          }
          if (allDone) {
            setDeployDone('live')
            setSubmitting(false)
            return
          }
        }
      } catch {
        // Ignore transient polling errors; we'll retry.
      }
      pollRef.current = setTimeout(() => void pollStages(projectId), POLL_INTERVAL_MS)
    },
    [stages]
  )

  // Auto-scroll the live log to the bottom.
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [stages])

  /* ── Retry deployment ─────────────────────────────────────────────────── */
  const handleRetry = useCallback(async () => {
    if (!createdProject) return
    setDeployError(null)
    setDeployDone(null)
    setSubmitting(true)
    setStages(
      FALLBACK_STAGES.map((s, i) => ({
        id: `seed-${s.name}`,
        name: s.name,
        label: s.label,
        status: i === 0 ? 'running' : 'pending',
        order: i,
      }))
    )
    try {
      const res = await fetch(`/api/hosting/${createdProject.id}/deploy`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ branch: gitBranch || 'main' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setDeployError(data.error || 'Failed to retry deployment')
        setSubmitting(false)
        return
      }
      setDeploymentId(data.deployment?.id || null)
      void pollStages(createdProject.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error'
      setDeployError(msg)
      setSubmitting(false)
    }
  }, [createdProject, gitBranch, pollStages])

  /* ── Navigation helpers ───────────────────────────────────────────────── */
  const goToStep = useCallback(
    (s: Step) => {
      if (s > maxReached) return
      setStep(s)
    },
    [maxReached]
  )

  const advance = useCallback(() => {
    setStep((s) => {
      const next = (Math.min(s, 3) + 1) as Step
      setMaxReached((m) => (next > m ? next : m))
      return next
    })
  }, [])

  const back = useCallback(() => {
    setStep((s) => (Math.max(1, s - 1) as Step))
  }, [])

  /* ── Validation per step ──────────────────────────────────────────────── */
  const step1Valid = slug.length >= 3
  const step2Valid =
    domainType === 'subdomain' ||
    (domainType === 'existing' && !!existingDomain) ||
    (domainType === 'new' && isValidDomain(newDomain))
  const step3Valid = useMemo(() => {
    if (!selectedMethod) return false
    // Required method fields must be filled (when shown for the current source).
    for (const f of selectedMethod.fields) {
      if (f.showForSources && !f.showForSources.includes(effectiveSource)) continue
      if (f.required) {
        const v = fieldValues[f.id]
        if (v === undefined || v === '') return false
      }
    }
    if (effectiveSource === 'git') {
      if (!isValidGitUrl(gitUrl)) return false
    }
    if (effectiveSource === 'zip') {
      if (!upload) return false
    }
    return true
  }, [selectedMethod, fieldValues, effectiveSource, gitUrl, upload])

  /* ── Close handler (with confirm mid-deploy) ──────────────────────────── */
  const handleDialogChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        if (submitting && !deployDone) {
          setShowCloseConfirm(true)
          return
        }
        onClose()
      }
    },
    [submitting, deployDone, onClose]
  )

  /* ── Escape key handling ──────────────────────────────────────────────── */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && submitting && !deployDone) {
        e.preventDefault()
        setShowCloseConfirm(true)
      }
      if (e.key === 'Enter' && step === 1 && step1Valid && !submitting) {
        e.preventDefault()
        advance()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, step, step1Valid, submitting, deployDone, advance])

  /* ── Render ───────────────────────────────────────────────────────────── */
  const isProgressView = submitting || deployDone !== null || !!createdProject
  const liveLog = useMemo(() => {
    const running = stages.find((s) => s.status === 'running')
    if (running?.log) return running.log
    const failed = stages.find((s) => s.status === 'failed')
    if (failed?.log) return failed.log
    return ''
  }, [stages])

  const finalDomain =
    createdProject?.customDomain ||
    (domainType === 'existing'
      ? existingDomain
      : domainType === 'new'
        ? newDomain
        : createdProject?.subdomain) ||
    createdProject?.subdomain ||
    subdomainPreview

  return (
    <Dialog open={open} onOpenChange={handleDialogChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] gap-0 overflow-hidden p-0 sm:rounded-xl">
        {/* Header */}
        <DialogHeader className="border-b px-4 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <DialogTitle className="text-lg font-semibold">
                {isProgressView ? 'Deploying your website' : 'Create a new website'}
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-xs">
                {isProgressView
                  ? 'You can close this dialog — deployment continues in the background.'
                  : 'Pick a deployment method, connect your source, and go live in minutes.'}
              </DialogDescription>
            </div>
          </div>
          {!isProgressView && (
            <Stepper step={step} maxReachable={maxReached} onStepClick={goToStep} />
          )}
        </DialogHeader>

        {/* Body — scrollable */}
        <div className="custom-scrollbar max-h-[calc(90vh-180px)] overflow-y-auto px-4 py-5 sm:px-6">
          {/* ─── STEP 1 — NAME ──────────────────────────────────────────── */}
          {step === 1 && !isProgressView && (
            <div className="grid gap-6 sm:grid-cols-[1fr_280px]">
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="website-name" className="text-sm font-medium">
                    Website Name
                  </Label>
                  <Input
                    id="website-name"
                    autoFocus
                    placeholder="my-awesome-site"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && step1Valid) {
                        e.preventDefault()
                        advance()
                      }
                    }}
                    className="h-11 text-base"
                  />
                  <p className="text-xs text-muted-foreground">
                    Choose a name for your website. You can rename it later.
                  </p>
                </div>
                {slug && (
                  <div className="rounded-lg border bg-muted/40 p-3">
                    <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <Globe className="size-3.5" />
                      Live preview
                    </p>
                    <p className="font-mono text-sm text-foreground">
                      https://{subdomainPreview}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground/80">
                      A short unique suffix is added at deploy time to guarantee the subdomain is available.
                    </p>
                  </div>
                )}
                {atProjectLimit && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                    <div className="flex-1">
                      <p className="font-medium text-destructive">Project limit reached</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        You&apos;re using {projectCount}/{plan?.projects ?? '—'} websites on the {plan?.name} plan.
                        Upgrade to deploy more.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2 h-7 border-destructive/40 text-destructive hover:bg-destructive/10"
                        onClick={() => {
                          window.location.href = '/dashboard?tab=billing'
                        }}
                      >
                        Upgrade Plan
                      </Button>
                    </div>
                  </div>
                )}
              </div>
              <div className="hidden sm:block">
                <PlanLimitsPanel
                  plan={plan}
                  projectCount={projectCount}
                  loading={planLoading}
                />
              </div>
            </div>
          )}

          {/* ─── STEP 2 — DOMAIN ────────────────────────────────────────── */}
          {step === 2 && !isProgressView && (
            <div className="space-y-3">
              <DomainOptionCard
                selected={domainType === 'subdomain'}
                onSelect={() => setDomainType('subdomain')}
                title="Temporary subdomain"
                description={`Get online instantly with a free ${SUBDOMAIN_SUFFIX} subdomain.`}
                icon={<Globe className="size-5" />}
              >
                {domainType === 'subdomain' && slug && (
                  <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm">
                    https://{subdomainPreview}
                  </div>
                )}
              </DomainOptionCard>

              <DomainOptionCard
                selected={domainType === 'existing'}
                onSelect={() => setDomainType('existing')}
                title="Existing domain"
                description="Use a domain you've already registered and verified in the panel."
                icon={<Server className="size-5" />}
              >
                {domainType === 'existing' &&
                  (domainsLoading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-9 w-full" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  ) : domains.length === 0 ? (
                    <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                      <p>You don&apos;t have any active domains yet.</p>
                      <Button
                        size="sm"
                        variant="link"
                        className="h-auto p-0 text-primary"
                        onClick={() => {
                          window.location.href = '/dashboard?tab=domains'
                        }}
                      >
                        Register one in the Domains tab →
                      </Button>
                    </div>
                  ) : (
                    <Select value={existingDomain} onValueChange={setExistingDomain}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select a domain…" />
                      </SelectTrigger>
                      <SelectContent>
                        {domains.map((d) => (
                          <SelectItem key={d.id} value={d.name}>
                            {d.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ))}
              </DomainOptionCard>

              <DomainOptionCard
                selected={domainType === 'new'}
                onSelect={() => setDomainType('new')}
                title="New domain"
                description="Point a domain you own (registered elsewhere) to your Apsamo server."
                icon={<Hash className="size-5" />}
              >
                {domainType === 'new' && (
                  <div className="space-y-1.5">
                    <Input
                      placeholder="example.com"
                      value={newDomain}
                      onChange={(e) => setNewDomain(e.target.value)}
                    />
                    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                      <Info className="mt-0.5 size-3.5 shrink-0" />
                      Make sure the domain&apos;s A record points to your server IP. We&apos;ll verify DNS
                      before issuing SSL.
                    </p>
                  </div>
                )}
              </DomainOptionCard>
            </div>
          )}

          {/* ─── STEP 3 — METHOD ────────────────────────────────────────── */}
          {step === 3 && !isProgressView && (
            <div className="space-y-4">
              {/* Method picker: categories sidebar + cards grid */}
              <div className="grid gap-4 lg:grid-cols-[180px_1fr]">
                <MethodCategoryNav
                  selectedCategory={selectedMethod?.category || null}
                  onPickCategory={(cat) => {
                    const first = getMethodsByCategory()[cat][0]
                    if (first) selectMethod(first.id)
                  }}
                />
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {DEPLOYMENT_METHODS.map((m) => (
                    <MethodCard
                      key={m.id}
                      method={m}
                      selected={methodId === m.id}
                      onClick={() => selectMethod(m.id)}
                    />
                  ))}
                </div>
              </div>

              {/* Config form (revealed when method chosen) */}
              {selectedMethod && (
                <div className="space-y-4 rounded-lg border bg-card/50 p-4">
                  <div className="flex items-start gap-3">
                    <span className="flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                      {React.createElement(getMethodIcon(selectedMethod.icon), { className: 'size-5' })}
                    </span>
                    <div className="flex-1">
                      <p className="text-sm font-semibold">{selectedMethod.name}</p>
                      <p className="text-xs text-muted-foreground">{selectedMethod.description}</p>
                    </div>
                  </div>

                  <Separator />

                  {/* Source picker */}
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">Source</Label>
                    {selectedMethod.id === 'wordpress' ? (
                      <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 p-2.5 text-xs text-muted-foreground">
                        <Info className="size-3.5" />
                        WordPress is installed automatically — no source code needed.
                      </div>
                    ) : (
                      <Tabs
                        value={effectiveSource}
                        onValueChange={(v) => setSource(v as Source)}
                      >
                        <TabsList className="grid w-full grid-cols-3">
                          <TabsTrigger
                            value="git"
                            disabled={!selectedMethod.supportsGit}
                            className="text-xs"
                          >
                            <GitBranch className="mr-1 size-3.5" />
                            Git
                          </TabsTrigger>
                          <TabsTrigger
                            value="zip"
                            disabled={!selectedMethod.supportsZip}
                            className="text-xs"
                          >
                            <Package className="mr-1 size-3.5" />
                            Upload ZIP
                          </TabsTrigger>
                          <TabsTrigger
                            value="manual"
                            disabled={!selectedMethod.supportsManual}
                            className="text-xs"
                          >
                            <FileCode className="mr-1 size-3.5" />
                            Start Fresh
                          </TabsTrigger>
                        </TabsList>

                        <TabsContent value="git" className="mt-3 space-y-3">
                          <GitSourceForm
                            provider={gitProvider}
                            onProviderChange={setGitProvider}
                            url={gitUrl}
                            onUrlChange={setGitUrl}
                            branch={gitBranch}
                            onBranchChange={setGitBranch}
                            token={gitToken}
                            onTokenChange={setGitToken}
                          />
                        </TabsContent>

                        <TabsContent value="zip" className="mt-3 space-y-3">
                          <UploadDropzone
                            upload={upload}
                            progress={uploadProgress}
                            uploading={uploading}
                            error={uploadError}
                            onFile={startUpload}
                            onClear={() => {
                              setUpload(null)
                              setUploadProgress(0)
                              setUploadError(null)
                            }}
                          />
                        </TabsContent>

                        <TabsContent value="manual" className="mt-3">
                          <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 p-2.5 text-xs text-muted-foreground">
                            <Info className="size-3.5" />
                            We&apos;ll scaffold a minimal starter so you can clone, edit, and redeploy.
                          </div>
                        </TabsContent>
                      </Tabs>
                    )}
                  </div>

                  {/* Build detection info banner */}
                  {(effectiveSource === 'git' || effectiveSource === 'zip') &&
                    selectedMethod.id !== 'wordpress' && (
                      <div className="flex items-start gap-2 rounded-md border border-primary/20 bg-primary/5 p-2.5 text-xs">
                        <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
                        <p className="text-muted-foreground">
                          We&apos;ll auto-detect the framework from your project files at deploy time.
                          You can override the settings below.
                        </p>
                      </div>
                    )}

                  <Separator />

                  {/* Method-specific fields */}
                  <div className="grid gap-3 sm:grid-cols-2">
                    {selectedMethod.fields
                      .filter((f) => !f.showForSources || f.showForSources.includes(effectiveSource))
                      .map((f) => (
                        <div key={f.id} className={f.type === 'select' ? 'sm:col-span-1' : 'sm:col-span-1'}>
                          <div className="space-y-1.5">
                            <Label htmlFor={`field-${f.id}`} className="flex items-center gap-1 text-xs font-medium">
                              {f.label}
                              {f.required && <span className="text-destructive">*</span>}
                              {f.helpText && (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Info className="size-3 cursor-help text-muted-foreground" />
                                    </TooltipTrigger>
                                    <TooltipContent side="right" className="max-w-xs text-xs">
                                      {f.helpText}
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                            </Label>
                            <MethodFieldInput
                              field={f}
                              value={fieldValues[f.id] ?? ''}
                              onChange={(v) =>
                                setFieldValues((prev) => ({ ...prev, [f.id]: v }))
                              }
                            />
                          </div>
                        </div>
                      ))}
                  </div>

                  <Separator />

                  {/* Env vars (collapsible) */}
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => setShowEnv((s) => !s)}
                      className="flex w-full items-center justify-between rounded-md px-1 py-1 text-left"
                    >
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <Key className="size-4 text-muted-foreground" />
                        Environment Variables
                        <Badge variant="outline" className="text-[10px]">
                          {envVars.filter((v) => v.key.trim()).length}
                        </Badge>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {showEnv ? 'Hide' : 'Show'}
                      </span>
                    </button>
                    {showEnv && (
                      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                        <EnvVarsEditor
                          vars={envVars}
                          onChange={(next) => {
                            setEnvVars(next)
                            setEnvTouched(true)
                          }}
                        />
                        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                          <Lock className="mt-0.5 size-3 shrink-0" />
                          Injected into the container at runtime. Secrets are encrypted at rest.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ─── STEP 4 — REVIEW ────────────────────────────────────────── */}
          {step === 4 && !isProgressView && (
            <ReviewSummary
              name={name}
              domain={
                domainType === 'subdomain'
                  ? subdomainPreview
                  : domainType === 'existing'
                    ? existingDomain
                    : newDomain
              }
              domainType={domainType}
              method={selectedMethod}
              source={effectiveSource}
              gitUrl={gitUrl}
              upload={upload}
              fieldValues={fieldValues}
              envVars={envVars.filter((v) => v.key.trim())}
              plan={plan}
              projectCount={projectCount}
            />
          )}

          {/* ─── PROGRESS VIEW ──────────────────────────────────────────── */}
          {isProgressView && createdProject && (
            <ProgressView
              submitting={submitting}
              deployDone={deployDone}
              stages={stages}
              liveLog={liveLog}
              deployError={deployError}
              logEndRef={logEndRef}
              projectName={createdProject.name}
              projectSubdomain={createdProject.subdomain}
              finalDomain={finalDomain}
              isWordPress={selectedMethod?.id === 'wordpress'}
              wpAdminUser={fieldValues.wpAdminUser}
              wpAdminPassword={fieldValues.wpAdminPassword}
              onRetry={handleRetry}
              onReset={() => {
                if (pollRef.current) {
                  clearTimeout(pollRef.current)
                  pollRef.current = null
                }
                setCreatedProject(null)
                setDeploymentId(null)
                setStages([])
                setDeployError(null)
                setDeployDone(null)
                setSubmitting(false)
                setStep(1)
                setMaxReached(1)
              }}
              onGoToProject={() => {
                if (pollRef.current) {
                  clearTimeout(pollRef.current)
                  pollRef.current = null
                }
                onCreated({ id: createdProject.id, name: createdProject.name })
                onClose()
              }}
            />
          )}

          {/* ─── SUBMIT ERROR (pre-creation) ────────────────────────────── */}
          {isProgressView && !createdProject && deployError && (
            <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
                <XCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
                <div>
                  <p className="text-sm font-medium text-destructive">Failed to start deployment</p>
                  <p className="mt-1 text-xs text-muted-foreground">{deployError}</p>
                </div>
              </div>
              <Button variant="outline" onClick={() => setStep(3)}>
                <ArrowLeft className="mr-2 size-4" />
                Back to method
              </Button>
            </div>
          )}
        </div>

        {/* Footer — only show when filling out the wizard (not during/after deploy) */}
        {!isProgressView && (
          <div className="flex items-center justify-between gap-2 border-t px-4 py-3 sm:px-6">
            <Button
              variant="outline"
              onClick={back}
              disabled={step === 1}
              className="gap-1.5"
            >
              <ArrowLeft className="size-4" />
              Back
            </Button>
            <div className="flex items-center gap-2">
              {step === 4 ? (
                <Button
                  onClick={handleSubmit}
                  disabled={!step3Valid || atProjectLimit}
                  className="gap-1.5"
                >
                  <Rocket className="size-4" />
                  Deploy Website
                </Button>
              ) : (
                <Button
                  onClick={advance}
                  disabled={
                    (step === 1 && !step1Valid) ||
                    (step === 2 && !step2Valid) ||
                    (step === 3 && !step3Valid)
                  }
                  className="gap-1.5"
                >
                  Continue
                  <ArrowRight className="size-4" />
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Close confirmation during deployment */}
        <AlertDialog open={showCloseConfirm} onOpenChange={setShowCloseConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="size-5 text-amber-500" />
                Deployment in progress
              </AlertDialogTitle>
              <AlertDialogDescription>
                Closing won&apos;t stop the deployment — it continues in the background. You can
                track its progress from the project list. Continue closing?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep open</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setShowCloseConfirm(false)
                  onClose()
                }}
              >
                Close anyway
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Sub-components (continued)                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

function DomainOptionCard({
  selected,
  onSelect,
  title,
  description,
  icon,
  children,
}: {
  selected: boolean
  onSelect: () => void
  title: string
  description: string
  icon: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      className={`cursor-pointer rounded-lg border p-4 transition-all ${
        selected ? 'border-primary ring-1 ring-primary bg-primary/5' : 'border-border hover:border-primary/40'
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`flex size-9 shrink-0 items-center justify-center rounded-md ${
            selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
          }`}
        >
          {icon}
        </span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">{title}</p>
            {selected && <Check className="size-4 text-primary" />}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          {children && <div className="mt-3">{children}</div>}
        </div>
      </div>
    </div>
  )
}

function MethodCategoryNav({
  selectedCategory,
  onPickCategory,
}: {
  selectedCategory: MethodCategory | null
  onPickCategory: (c: MethodCategory) => void
}) {
  const categories = Object.keys(CATEGORY_LABELS) as MethodCategory[]
  return (
    <nav className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:gap-1 lg:overflow-visible lg:pb-0">
      {categories.map((c) => {
        const count = getMethodsByCategory()[c].length
        if (count === 0) return null
        const active = selectedCategory === c
        return (
          <button
            key={c}
            type="button"
            onClick={() => onPickCategory(c)}
            className={`flex shrink-0 items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
              active
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            <span className="whitespace-nowrap font-medium">{CATEGORY_LABELS[c]}</span>
            <Badge variant="outline" className="text-[10px]">
              {count}
            </Badge>
          </button>
        )
      })}
    </nav>
  )
}

function GitSourceForm({
  provider,
  onProviderChange,
  url,
  onUrlChange,
  branch,
  onBranchChange,
  token,
  onTokenChange,
}: {
  provider: GitProvider
  onProviderChange: (p: GitProvider) => void
  url: string
  onUrlChange: (v: string) => void
  branch: string
  onBranchChange: (v: string) => void
  token: string
  onTokenChange: (v: string) => void
}) {
  const providers: { id: GitProvider; label: string }[] = [
    { id: 'github', label: 'GitHub' },
    { id: 'gitlab', label: 'GitLab' },
    { id: 'bitbucket', label: 'Bitbucket' },
    { id: 'custom', label: 'Custom' },
  ]
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Provider</Label>
        <div className="flex flex-wrap gap-1.5">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onProviderChange(p.id)}
              className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
                provider === p.id
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-accent'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="git-url" className="text-xs font-medium">
          Repository URL <span className="text-destructive">*</span>
        </Label>
        <Input
          id="git-url"
          placeholder="https://github.com/user/repo.git"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
        />
        {url && !isValidGitUrl(url) && (
          <p className="text-xs text-destructive">Enter a valid Git URL (https:// or git@).</p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="git-branch" className="text-xs font-medium">
            Branch
          </Label>
          <Input
            id="git-branch"
            placeholder="main"
            value={branch}
            onChange={(e) => onBranchChange(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="git-token" className="flex items-center gap-1 text-xs font-medium">
            Access Token
            <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <Input
            id="git-token"
            type="password"
            placeholder="ghp_…"
            value={token}
            onChange={(e) => onTokenChange(e.target.value)}
          />
        </div>
      </div>
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Key className="mt-0.5 size-3 shrink-0" />
        Required for private repos. Stored encrypted; never logged.
      </p>
    </div>
  )
}

function ReviewSummary({
  name,
  domain,
  domainType,
  method,
  source,
  gitUrl,
  upload,
  fieldValues,
  envVars,
  plan,
  projectCount,
}: {
  name: string
  domain: string
  domainType: DomainType
  method: DeploymentMethod | null
  source: Source
  gitUrl: string
  upload: UploadInfo | null
  fieldValues: Record<string, string>
  envVars: EnvVar[]
  plan: PlanInfo | null
  projectCount: number
}) {
  if (!method) return null
  const sourceLabel =
    source === 'git'
      ? gitUrl || 'Git repository'
      : source === 'zip'
        ? upload?.filename || 'ZIP upload'
        : 'Start fresh (auto-scaffold)'

  const summaryRows: Array<{ label: string; value: string }> = [
    { label: 'Website', value: name },
    {
      label: 'Domain',
      value:
        domainType === 'subdomain'
          ? `${domain} (temporary)`
          : domainType === 'existing'
            ? `${domain} (existing)`
            : `${domain} (new)`,
    },
    { label: 'Method', value: method.name },
    { label: 'Source', value: sourceLabel },
  ]

  // Config rows.
  const configRows: Array<{ label: string; value: string }> = []
  if (fieldValues.runtime) configRows.push({ label: 'Runtime', value: fieldValues.runtime })
  if (fieldValues.runtimeVersion) configRows.push({ label: 'Version', value: fieldValues.runtimeVersion })
  if (fieldValues.framework) configRows.push({ label: 'Framework', value: fieldValues.framework })
  if (fieldValues.packageManager) configRows.push({ label: 'Pkg manager', value: fieldValues.packageManager })
  if (fieldValues.buildCommand) configRows.push({ label: 'Build', value: fieldValues.buildCommand })
  if (fieldValues.startCommand) configRows.push({ label: 'Start', value: fieldValues.startCommand })
  if (fieldValues.appPort) configRows.push({ label: 'Port', value: fieldValues.appPort })
  if (fieldValues.documentRoot) configRows.push({ label: 'Doc root', value: fieldValues.documentRoot })
  if (fieldValues.useCompose) configRows.push({ label: 'Compose', value: fieldValues.useCompose })

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Deployment summary</CardTitle>
          <CardDescription className="text-xs">
            Review your settings before deploying. You can change everything later.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Top row */}
          <div className="flex items-start gap-3">
            <span className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
              {React.createElement(ICON_REGISTRY[method.icon] || FileCode, { className: 'size-5' })}
            </span>
            <div className="flex-1">
              <p className="text-sm font-semibold">{name}</p>
              <p className="text-xs text-muted-foreground">{method.name} · {method.tagline}</p>
            </div>
          </div>

          <Separator />

          {/* Summary rows */}
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {summaryRows.map((r) => (
              <div key={r.label} className="flex flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">{r.label}</dt>
                <dd className="truncate text-sm font-medium">{r.value}</dd>
              </div>
            ))}
          </dl>

          {configRows.length > 0 && (
            <>
              <Separator />
              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">Configuration</p>
                <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  {configRows.map((r) => (
                    <div key={r.label} className="flex flex-col gap-0.5">
                      <dt className="text-xs text-muted-foreground">{r.label}</dt>
                      <dd className="truncate font-mono text-xs">{r.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </>
          )}

          <Separator />

          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {envVars.length} environment variable{envVars.length !== 1 ? 's' : ''}
            </p>
            {plan && (
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Cpu className="size-3" />
                  {plan.cpu}
                </span>
                <span className="flex items-center gap-1">
                  <Server className="size-3" />
                  {plan.ram}
                </span>
                <span className="flex items-center gap-1">
                  <HardDrive className="size-3" />
                  {plan.storage}
                </span>
                <span className="text-foreground">
                  {projectCount}/{plan.projects} sites
                </span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function ProgressView({
  submitting,
  deployDone,
  stages,
  liveLog,
  deployError,
  logEndRef,
  projectName,
  projectSubdomain,
  finalDomain,
  isWordPress,
  wpAdminUser,
  wpAdminPassword,
  onRetry,
  onReset,
  onGoToProject,
}: {
  submitting: boolean
  deployDone: 'live' | 'failed' | null
  stages: DeploymentStageInfo[]
  liveLog: string
  deployError: string | null
  logEndRef: React.RefObject<HTMLDivElement | null>
  projectName: string
  projectSubdomain: string
  finalDomain: string
  isWordPress: boolean
  wpAdminUser?: string
  wpAdminPassword?: string
  onRetry: () => void
  onReset: () => void
  onGoToProject: () => void
}) {
  // Success screen.
  if (deployDone === 'live') {
    const liveUrl = `https://${projectSubdomain || finalDomain}`
    return (
      <div className="space-y-4 py-2">
        <div className="flex flex-col items-center text-center">
          <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <CheckCircle2 className="size-8" />
          </div>
          <h3 className="mt-3 text-lg font-semibold">Your website is live!</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            <a
              href={liveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            >
              {liveUrl}
              <ExternalLink className="size-3" />
            </a>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Project: <span className="font-medium text-foreground">{projectName}</span>
          </p>
        </div>

        {isWordPress && (
          <Card className="border-primary/30 bg-primary/5">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Settings className="size-4 text-primary" />
                WordPress Admin Login
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Admin URL</span>
                <a
                  href={`${liveUrl}/wp-admin`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-primary hover:underline"
                >
                  {liveUrl}/wp-admin
                </a>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Username</span>
                <span className="font-mono">{wpAdminUser || 'admin'}</span>
              </div>
              <WordPressPasswordReveal password={wpAdminPassword} />
            </CardContent>
          </Card>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={onGoToProject} className="flex-1 gap-1.5">
            <ArrowRight className="size-4" />
            Go to Website Management
          </Button>
          <Button variant="outline" onClick={onReset} className="gap-1.5">
            <Plus className="size-4" />
            Deploy Another
          </Button>
        </div>
      </div>
    )
  }

  // Failure screen.
  if (deployDone === 'failed') {
    const failedStage = stages.find((s) => s.status === 'failed')
    return (
      <div className="space-y-4 py-2">
        <div className="flex flex-col items-center text-center">
          <div className="flex size-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <XCircle className="size-8" />
          </div>
          <h3 className="mt-3 text-lg font-semibold">Deployment failed</h3>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {deployError || 'A deployment stage failed. Check the failed stage below for details.'}
          </p>
        </div>

        {failedStage && (
          <Card className="border-destructive/30">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <XCircle className="size-4 text-destructive" />
                Failed: {failedStage.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {failedStage.log && (
                <pre className="custom-scrollbar max-h-48 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                  {failedStage.log}
                </pre>
              )}
            </CardContent>
          </Card>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={onRetry} className="flex-1 gap-1.5">
            <RefreshCw className="size-4" />
            Retry Deployment
          </Button>
          <Button variant="outline" onClick={onReset} className="gap-1.5">
            <ArrowLeft className="size-4" />
            Back to Wizard
          </Button>
        </div>
      </div>
    )
  }

  // In-progress view: timeline + log console.
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin text-primary" />
        <span className="font-medium">Deploying {projectName}…</span>
      </div>

      {/* Stage timeline */}
      <ol className="space-y-3">
        {stages
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((s, i) => (
            <li key={s.id || `${s.name}-${i}`} className="relative flex items-start gap-3 pb-3">
              {i < stages.length - 1 && (
                <span
                  className={`absolute left-[10px] top-6 h-[calc(100%-12px)] w-0.5 ${
                    s.status === 'completed' ? 'bg-primary/30' : 'bg-border'
                  }`}
                />
              )}
              <span className="z-10 mt-0.5 shrink-0">
                <StageIcon status={s.status} />
              </span>
              <div className="flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className={`text-sm font-medium ${s.status === 'pending' ? 'text-muted-foreground' : ''}`}>
                    {s.label}
                  </p>
                  <div className="flex items-center gap-2">
                    <StageStatusBadge status={s.status} />
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatDuration(s.durationMs)}
                    </span>
                  </div>
                </div>
                {s.message && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{s.message}</p>
                )}
              </div>
            </li>
          ))}
      </ol>

      {/* Live log console */}
      {liveLog && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Live log</p>
          <ScrollArea className="custom-scrollbar h-40 rounded-md border bg-black/[0.03] dark:bg-black/40">
            <pre className="whitespace-pre-wrap p-3 font-mono text-xs text-foreground/90">
              {liveLog}
              <div ref={logEndRef} />
            </pre>
          </ScrollArea>
        </div>
      )}

      {submitting && !liveLog && (
        <p className="text-xs text-muted-foreground">Streaming logs…</p>
      )}
    </div>
  )
}

function WordPressPasswordReveal({ password }: { password?: string }) {
  const [show, setShow] = useState(false)
  if (!password) return null
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">Password</span>
      <div className="flex items-center gap-2">
        <span className="font-mono">{show ? password : '••••••••••'}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={() => setShow((s) => !s)}
        >
          {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          {show ? 'Hide' : 'Show'}
        </Button>
      </div>
    </div>
  )
}
