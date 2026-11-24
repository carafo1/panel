'use client'

/**
 * ProvisioningPanel
 * =================
 *
 * The automated-provisioning dashboard. Renders three views depending on
 * local UI state:
 *
 *   1. Jobs list — recent ProvisioningJob rows with status badges + a
 *      "New Provisioning" button.
 *   2. New Provisioning dialog — domain + stack + toggles, with real-time
 *      domain-availability check and a price summary.
 *   3. Job detail view — pipeline stepper + structured result cards
 *      (domain / DNS / hosting / email / credentials) + rollback.
 *
 * Real-time updates:
 *   - List polls every 3s when there are running jobs.
 *   - Detail polls every 2s while the job is in a non-terminal state.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import {
  Globe,
  Server,
  Mail,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Copy,
  Download,
  RotateCcw,
  Rocket,
  Zap,
  Eye,
  EyeOff,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  ExternalLink,
  KeyRound,
  Lock,
  FileCode,
  Terminal,
  Box,
  Container,
  LayoutTemplate,
  Sparkles,
  CircleDot,
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { apiFetch } from '@/store/auth-store'
import {
  availabilityOf, isPurchasable, availabilityErrorMessage, AVAILABILITY_COPY,
  type AvailabilityState,
} from '@/components/domains/domain-availability'
import type { ProvisioningResult } from '@/lib/orchestration'

// ─── Types ────────────────────────────────────────────────────────────────

type JobStatus = 'pending' | 'running' | 'success' | 'failed' | 'rolled_back'
type StepStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'rolled_back'

interface StackInfo {
  id: string
  name: string
  description: string
  icon: string
}

interface ProvisioningStep {
  id: string
  stepName: string
  stepOrder: number
  status: StepStatus
  attempts: number
  maxAttempts: number
  error?: string | null
  startedAt?: string | null
  completedAt?: string | null
  duration?: number | null
  lastAttemptAt?: string | null
}

interface ProvisioningJob {
  id: string
  domainName: string
  stack: string
  includeHosting: boolean
  includeEmail: boolean
  status: JobStatus
  currentStep: string
  error?: string | null
  startedAt?: string | null
  completedAt?: string | null
  rollbackStartedAt?: string | null
  rollbackCompletedAt?: string | null
  createdAt: string
  updatedAt: string
  steps?: ProvisioningStep[]
}

/**
 * GET /api/provisioning/check-domain. `price` is only sent for an available
 * name on a priced, active TLD; 503 = registrar could not confirm; 429 = rate
 * limited. `state` is what the UI renders; `available` alone is never enough.
 */
interface DomainCheck {
  domain: string
  valid: boolean
  available: boolean
  state?: AvailabilityState
  price?: number
  demoMode?: boolean
  message?: string
  suggestions?: Array<{ domain: string; available: boolean; status?: string; price?: number }>
}

interface JobStatusResponse {
  job: ProvisioningJob & { userId?: string }
  steps: ProvisioningStep[]
  result?: ProvisioningResult
}

// ─── Constants ────────────────────────────────────────────────────────────

const DOMAIN_REGEX =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

const PIPELINE_STEPS: Array<{
  name: string
  label: string
  icon: React.ElementType
}> = [
  { name: 'domain_register', label: 'Domain Registration', icon: Globe },
  { name: 'dns_configure', label: 'DNS Configuration', icon: CircleDot },
  { name: 'hosting_provision', label: 'Web Hosting', icon: Server },
  { name: 'email_provision', label: 'Email Hosting', icon: Mail },
  { name: 'verify', label: 'Verification', icon: ShieldCheck },
]

const STACK_ICONS: Record<string, React.ElementType> = {
  nodejs: Box,
  php: FileCode,
  python: Terminal,
  docker: Container,
  wordpress: LayoutTemplate,
  box: Box,
  'file-code': FileCode,
  terminal: Terminal,
  container: Container,
  'layout-template': LayoutTemplate,
}

const HOSTING_PRICE = 9.0
const EMAIL_PRICE = 3.0

// ─── Helpers ──────────────────────────────────────────────────────────────

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

function formatDate(dateStr?: string | null): string {
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

function formatDuration(ms?: number | null): string {
  if (!ms || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m ${rem}s`
}

function statusBadgeClass(status: JobStatus | StepStatus): string {
  switch (status) {
    case 'pending':
      return 'bg-muted text-muted-foreground border-border'
    case 'running':
      return 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/30'
    case 'success':
      return 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/30'
    case 'failed':
      return 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30'
    case 'rolled_back':
      return 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30'
    case 'skipped':
      return 'bg-muted/60 text-muted-foreground/70 border-dashed border-border'
    default:
      return 'bg-muted text-muted-foreground border-border'
  }
}

function StatusBadge({ status }: { status: JobStatus | StepStatus }) {
  const label = (status || 'pending').replace('_', ' ')
  const animated = status === 'running'
  return (
    <Badge
      variant="outline"
      className={`capitalize ${statusBadgeClass(status)} ${animated ? 'animate-pulse' : ''}`}
    >
      {animated && <Loader2 className="size-3 animate-spin" />}
      {label}
    </Badge>
  )
}

function getStackIcon(stackId: string): React.ElementType {
  return STACK_ICONS[stackId] || STACK_ICONS[stackId.toLowerCase()] || Box
}

function getStepIcon(stepName: string): React.ElementType {
  return (
    PIPELINE_STEPS.find((s) => s.name === stepName)?.icon || CircleDot
  )
}

function getStepLabel(stepName: string): string {
  return (
    PIPELINE_STEPS.find((s) => s.name === stepName)?.label || stepName
  )
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    return true
  } catch {
    return false
  }
}

// ─── CopyButton ────────────────────────────────────────────────────────────

function CopyButton({
  value,
  label = 'Copy',
  className = '',
}: {
  value: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={`h-7 px-2 text-xs ${className}`}
      onClick={async (e) => {
        e.stopPropagation()
        const ok = await copyToClipboard(value)
        if (ok) {
          setCopied(true)
          toast.success('Copied to clipboard')
          setTimeout(() => setCopied(false), 1500)
        } else {
          toast.error('Copy failed')
        }
      }}
    >
      {copied ? (
        <CheckCircle2 className="size-3.5 text-indigo-500" />
      ) : (
        <Copy className="size-3.5" />
      )}
      {label}
    </Button>
  )
}

// ─── New Provisioning Dialog ───────────────────────────────────────────────

function NewProvisioningDialog({
  open,
  onOpenChange,
  onStarted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onStarted: (jobId: string) => void
}) {
  const [domain, setDomain] = useState('')
  const [stack, setStack] = useState('nodejs')
  const [includeHosting, setIncludeHosting] = useState(true)
  const [includeEmail, setIncludeEmail] = useState(true)
  const [stacks, setStacks] = useState<StackInfo[]>([])
  const [stacksLoading, setStacksLoading] = useState(false)
  const [domainCheck, setDomainCheck] = useState<DomainCheck | null>(null)
  const [domainChecking, setDomainChecking] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load stacks once when the dialog opens
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setStacksLoading(true)
    apiFetch<unknown>('/provisioning/stacks')
      .then((data) => {
        if (cancelled) return
        const s = (data as { stacks?: StackInfo[] }).stacks || []
        setStacks(s)
      })
      .catch(() => {
        if (!cancelled) {
          setStacks([
            { id: 'nodejs', name: 'Node.js', description: 'Next.js, Express, Fastify', icon: 'box' },
            { id: 'php', name: 'PHP', description: 'PHP 8.2 on Apache', icon: 'file-code' },
            { id: 'python', name: 'Python', description: 'Python 3.11 + gunicorn', icon: 'terminal' },
            { id: 'docker', name: 'Docker', description: 'Bring your own Dockerfile', icon: 'container' },
            { id: 'wordpress', name: 'WordPress', description: 'Managed WordPress 6.4', icon: 'layout-template' },
          ])
        }
      })
      .finally(() => {
        if (!cancelled) setStacksLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // Debounced domain availability check
  useEffect(() => {
    if (!domain) {
      setDomainCheck(null)
      return
    }
    if (!DOMAIN_REGEX.test(domain)) {
      setDomainCheck({
        domain,
        valid: false,
        available: false,
        message: 'Enter a valid domain (e.g. example.com)',
      })
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setDomainChecking(true)
    debounceRef.current = setTimeout(() => {
      apiFetch<unknown>(`/provisioning/check-domain?domain=${encodeURIComponent(domain)}`)
        .then((data) => {
          const resp = data as {
            domain?: string
            available?: boolean
            status?: string
            price?: number
            alternatives?: Array<{ domain: string; available: boolean; status?: string; price?: number }>
          }
          const state = availabilityOf({
            status: resp.status,
            available: resp.available ?? null,
            price: resp.price ?? null,
          })
          setDomainCheck({
            domain: resp.domain || domain,
            valid: true,
            available: state === 'available',
            state,
            price: state === 'available' ? resp.price : undefined,
            message: state === 'available' ? undefined : AVAILABILITY_COPY[state].detail,
            // Only priced, available alternatives are worth offering.
            suggestions: resp.alternatives?.filter((a) =>
              isPurchasable({ status: a.status, available: a.available, price: a.price ?? null })
            ),
          })
        })
        .catch((err) => {
          setDomainCheck({
            domain,
            valid: true,
            available: false,
            state: 'unknown',
            message: availabilityErrorMessage(err),
          })
        })
        .finally(() => setDomainChecking(false))
    }, 600)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [domain])

  const domainPrice = domainCheck?.available && domainCheck.price ? domainCheck.price : 0
  const totalPrice =
    domainPrice + (includeHosting ? HOSTING_PRICE : 0) + (includeEmail ? EMAIL_PRICE : 0)

  // Only an available name with a real selling price can be provisioned:
  // premium, unknown and unpriced results are never submittable.
  const canSubmit =
    DOMAIN_REGEX.test(domain) &&
    domainCheck?.available &&
    !!domainCheck.price &&
    !submitting &&
    (includeHosting || includeEmail)

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const res = await apiFetch<{ jobId: string }>('/provisioning/start', {
        method: 'POST',
        body: JSON.stringify({
          domainName: domain.trim().toLowerCase(),
          stack,
          includeHosting,
          includeEmail,
        }),
      })
      toast.success('Provisioning started!', {
        description: `Setting up ${domain}…`,
      })
      onOpenChange(false)
      setDomain('')
      setDomainCheck(null)
      setStack('nodejs')
      setIncludeHosting(true)
      setIncludeEmail(true)
      onStarted(res.jobId)
    } catch (err) {
      toast.error('Failed to start provisioning', {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="size-7 rounded-lg bg-indigo-600/10 flex items-center justify-center">
              <Rocket className="size-4 text-indigo-600 dark:text-indigo-400" />
            </div>
            New Automated Provisioning
          </DialogTitle>
          <DialogDescription>
            Pick a domain and a stack — we&apos;ll register the domain, configure DNS, deploy hosting, and provision email in one go.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Domain */}
          <div className="space-y-2">
            <Label htmlFor="prov-domain">Domain Name</Label>
            <div className="relative">
              <Globe className="absolute start-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                id="prov-domain"
                placeholder="example.com"
                value={domain}
                onChange={(e) => setDomain(e.target.value.trim().toLowerCase())}
                className="ps-9 pe-10"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              {domainChecking && (
                <Loader2 className="absolute end-3 top-1/2 -translate-y-1/2 size-4 animate-spin text-muted-foreground" />
              )}
            </div>
            {domainCheck && !domainChecking && (
              <div
                className={`text-xs flex items-start gap-1.5 ${
                  domainCheck.available
                    ? 'text-indigo-600 dark:text-indigo-400'
                    : 'text-muted-foreground'
                }`}
              >
                {domainCheck.valid ? (
                  domainCheck.available ? (
                    <CheckCircle2 className="size-3.5 mt-0.5 shrink-0" />
                  ) : (
                    <XCircle className="size-3.5 mt-0.5 shrink-0" />
                  )
                ) : (
                  <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
                )}
                <span role="status">
                  {domainCheck.valid
                    ? domainCheck.available
                      ? `Available${domainCheck.price ? ` · ${domainCheck.price.toFixed(2)}/yr` : ''}${domainCheck.demoMode ? ' (demo)' : ''}`
                      : `${AVAILABILITY_COPY[domainCheck.state ?? 'unknown'].label}${domainCheck.message ? ` · ${domainCheck.message}` : ''}`
                    : domainCheck.message || 'Invalid domain'}
                </span>
              </div>
            )}
            {domainCheck?.suggestions && domainCheck.suggestions.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className="text-xs text-muted-foreground">Try:</span>
                {domainCheck.suggestions.map((s) => (
                  <button
                    key={s.domain}
                    type="button"
                    onClick={() => setDomain(s.domain)}
                    className="text-xs px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/20 transition-colors"
                  >
                    {s.domain}
                    {s.price ? ` · $${s.price.toFixed(2)}` : ''}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Stack picker */}
          <div className="space-y-2">
            <Label>Application Stack</Label>
            {stacksLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-16" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {stacks.map((s) => {
                  const Icon = getStackIcon(s.icon || s.id)
                  const active = stack === s.id
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setStack(s.id)}
                      className={`flex items-start gap-3 p-3 rounded-lg border text-start transition-all ${
                        active
                          ? 'border-indigo-500 bg-indigo-500/5 ring-1 ring-indigo-500/30'
                          : 'border-border hover:border-indigo-500/40 hover:bg-muted/50'
                      }`}
                    >
                      <div
                        className={`size-8 rounded-md flex items-center justify-center shrink-0 ${
                          active
                            ? 'bg-indigo-600 text-white'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        <Icon className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium">{s.name}</span>
                          {active && (
                            <CheckCircle2 className="size-3.5 text-indigo-500" />
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          {s.description}
                        </p>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Toggles */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex items-start gap-3 p-3 rounded-lg border border-border">
              <Server className="size-5 text-indigo-600 dark:text-indigo-400 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <Label htmlFor="prov-hosting" className="cursor-pointer">
                    Web Hosting
                  </Label>
                  <Switch
                    id="prov-hosting"
                    checked={includeHosting}
                    onCheckedChange={setIncludeHosting}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Hosting + SSL · ${HOSTING_PRICE.toFixed(2)}/mo
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-lg border border-border">
              <Mail className="size-5 text-indigo-600 dark:text-indigo-400 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <Label htmlFor="prov-email" className="cursor-pointer">
                    Email Hosting
                  </Label>
                  <Switch
                    id="prov-email"
                    checked={includeEmail}
                    onCheckedChange={setIncludeEmail}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  3 mailboxes + DKIM · ${EMAIL_PRICE.toFixed(2)}/mo
                </p>
              </div>
            </div>
          </div>

          {!includeHosting && !includeEmail && (
            <Alert className="border-orange-500/40 bg-orange-500/5 text-orange-700 dark:text-orange-300">
              <AlertTriangle className="size-4" />
              <AlertTitle>Nothing selected</AlertTitle>
              <AlertDescription>
                Enable at least one of Web Hosting or Email Hosting to provision.
              </AlertDescription>
            </Alert>
          )}

          {/* Price summary */}
          <div className="rounded-lg border bg-muted/30 p-4 space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Domain (1 year)</span>
              <span className="font-medium">
                {domainPrice > 0 ? `$${domainPrice.toFixed(2)}` : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Web Hosting / mo</span>
              <span className="font-medium">
                {includeHosting ? `$${HOSTING_PRICE.toFixed(2)}` : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Email Hosting / mo</span>
              <span className="font-medium">
                {includeEmail ? `$${EMAIL_PRICE.toFixed(2)}` : '—'}
              </span>
            </div>
            <Separator className="my-2" />
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Total today</span>
              <span className="text-lg font-bold text-indigo-600 dark:text-indigo-400">
                ${totalPrice.toFixed(2)}
              </span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <Zap className="size-4" />
                Start Provisioning
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Pipeline Stepper ──────────────────────────────────────────────────────

function PipelineStepRow({
  step,
  isLast,
  expanded,
  onToggle,
}: {
  step: ProvisioningStep
  isLast: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const StepIcon = getStepIcon(step.stepName)
  const label = getStepLabel(step.stepName)
  const status = step.status

  let iconWrapClass = 'bg-muted text-muted-foreground'

  const renderIcon = () => {
    if (status === 'running') {
      return <Loader2 className="size-4 animate-spin" />
    }
    if (status === 'success') {
      return <CheckCircle2 className="size-4" />
    }
    if (status === 'failed') {
      return <XCircle className="size-4" />
    }
    if (status === 'skipped') {
      return <StepIcon className="size-4 opacity-60" />
    }
    if (status === 'rolled_back') {
      return <RotateCcw className="size-4" />
    }
    return <StepIcon className="size-4" />
  }

  if (status === 'running') {
    iconWrapClass = 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
  } else if (status === 'success') {
    iconWrapClass = 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
  } else if (status === 'failed') {
    iconWrapClass = 'bg-red-500/10 text-red-600 dark:text-red-400'
  } else if (status === 'skipped') {
    iconWrapClass = 'bg-muted/60 text-muted-foreground/60'
  } else if (status === 'rolled_back') {
    iconWrapClass = 'bg-orange-500/10 text-orange-600 dark:text-orange-400'
  }

  const connectorClass =
    status === 'success'
      ? 'bg-indigo-500/50'
      : status === 'running'
        ? 'bg-indigo-500/50'
        : 'bg-border'

  return (
    <div className="relative">
      {!isLast && (
        <div
          className={`absolute start-[18px] top-9 w-0.5 h-[calc(100%-12px)] ${connectorClass}`}
        />
      )}
      <button
        type="button"
        onClick={onToggle}
        className="relative flex items-start gap-3 w-full text-start p-2 rounded-lg hover:bg-muted/40 transition-colors"
      >
        <div
          className={`size-9 rounded-full flex items-center justify-center shrink-0 ${iconWrapClass}`}
        >
          {renderIcon()}
        </div>
        <div className="flex-1 min-w-0 pt-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{label}</span>
            <StatusBadge status={status} />
            {step.attempts > 1 && (
              <Badge variant="outline" className="text-[10px] text-amber-600 dark:text-amber-400 border-amber-500/30 bg-amber-500/5">
                retry ×{step.attempts - 1}
              </Badge>
            )}
            {step.duration != null && (
              <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                <Clock className="size-3" />
                {formatDuration(step.duration)}
              </span>
            )}
            {(status === 'success' || status === 'failed' || status === 'rolled_back') && (
              <div className="ms-auto">
                {expanded ? (
                  <ChevronDown className="size-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-4 text-muted-foreground" />
                )}
              </div>
            )}
          </div>
          {status === 'running' && (
            <div className="mt-2">
              <Progress className="h-1" value={65} />
              <p className="text-xs text-muted-foreground mt-1">
                {step.lastAttemptAt
                  ? `Attempt ${step.attempts} of ${step.maxAttempts} · started ${timeAgo(step.lastAttemptAt)}`
                  : 'Working…'}
              </p>
            </div>
          )}
          {status === 'pending' && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Queued — waiting for previous step.
            </p>
          )}
          {status === 'skipped' && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Not requested for this job.
            </p>
          )}
          {status === 'failed' && step.error && (
            <Alert variant="destructive" className="mt-2">
              <AlertTriangle className="size-4" />
              <AlertDescription className="text-xs break-all">
                {step.error}
              </AlertDescription>
            </Alert>
          )}
          {expanded && (status === 'success' || status === 'failed' || status === 'rolled_back') && (
            <div className="mt-2 pt-2 border-t border-border text-xs space-y-1">
              {step.startedAt && (
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Started</span>
                  <span>{formatDate(step.startedAt)}</span>
                </div>
              )}
              {step.completedAt && (
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Completed</span>
                  <span>{formatDate(step.completedAt)}</span>
                </div>
              )}
              {step.duration != null && (
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Duration</span>
                  <span>{formatDuration(step.duration)}</span>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Attempts</span>
                <span>{step.attempts} / {step.maxAttempts}</span>
              </div>
            </div>
          )}
        </div>
      </button>
    </div>
  )
}

function PipelineProgress({ steps }: { steps: ProvisioningStep[] }) {
  const [expandedStep, setExpandedStep] = useState<string | null>(null)
  const ordered = [...steps].sort((a, b) => a.stepOrder - b.stepOrder)
  const total = ordered.length
  const done = ordered.filter(
    (s) => s.status === 'success' || s.status === 'skipped'
  ).length
  const overallPct = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4 text-indigo-600 dark:text-indigo-400" />
          Pipeline Progress
        </CardTitle>
        <CardDescription>
          {done === total ? 'All steps complete' : `${done} of ${total} steps done`}
        </CardDescription>
        <Progress className="h-2 mt-1" value={overallPct} />
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {ordered.map((step, i) => (
            <PipelineStepRow
              key={step.id}
              step={step}
              isLast={i === ordered.length - 1}
              expanded={expandedStep === step.id}
              onToggle={() =>
                setExpandedStep((prev) => (prev === step.id ? null : step.id))
              }
            />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Structured Result Cards ───────────────────────────────────────────────

function StatusResultCard({
  title,
  icon: Icon,
  status,
  children,
}: {
  title: string
  icon: React.ElementType
  status: 'success' | 'fail' | 'skipped'
  children?: React.ReactNode
}) {
  const headerTint =
    status === 'success'
      ? 'text-indigo-600 dark:text-indigo-400 bg-indigo-500/10'
      : status === 'fail'
        ? 'text-red-600 dark:text-red-400 bg-red-500/10'
        : 'text-muted-foreground bg-muted'
  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2.5">
          <div className={`size-8 rounded-md flex items-center justify-center ${headerTint}`}>
            <Icon className="size-4" />
          </div>
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm">{title}</CardTitle>
          </div>
          {status === 'success' && (
            <CheckCircle2 className="size-5 text-indigo-500" />
          )}
          {status === 'fail' && <XCircle className="size-5 text-red-500" />}
          {status === 'skipped' && (
            <span className="text-xs text-muted-foreground">skipped</span>
          )}
        </div>
      </CardHeader>
      {children && <CardContent className="pt-0">{children}</CardContent>}
    </Card>
  )
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span
        className={`text-xs font-medium text-end break-all ${mono ? 'font-mono' : ''}`}
      >
        {value || '—'}
      </span>
    </div>
  )
}

function DomainResultCard({ result }: { result: ProvisioningResult }) {
  const s = result.domainStatus
  return (
    <StatusResultCard
      title="Domain Registration"
      icon={Globe}
      status={s.status}
    >
      <div className="space-y-0.5">
        <DetailRow label="Domain" value={s.domain} mono />
        <DetailRow label="Provider" value={s.provider} />
        <DetailRow
          label="Registered"
          value={s.registered ? 'Yes · 1 year' : 'No'}
        />
        {s.externalId && (
          <DetailRow label="Order ID" value={s.externalId} mono />
        )}
        {s.details && (
          <p className="text-xs text-muted-foreground mt-2 pt-2 border-t border-border">
            {s.details}
          </p>
        )}
      </div>
    </StatusResultCard>
  )
}

function DnsResultCard({ result }: { result: ProvisioningResult }) {
  const s = result.dnsStatus
  return (
    <StatusResultCard
      title="DNS Configuration"
      icon={CircleDot}
      status={s.status}
    >
      <div className="space-y-2">
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="text-start px-2 py-1.5 font-medium">Type</th>
                <th className="text-start px-2 py-1.5 font-medium">Name</th>
                <th className="text-start px-2 py-1.5 font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {s.records.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-2 py-2 text-center text-muted-foreground">
                    No DNS records created.
                  </td>
                </tr>
              ) : (
                s.records.map((r, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-2 py-1.5">
                      <Badge variant="outline" className="text-[10px]">
                        {r.type}
                      </Badge>
                    </td>
                    <td className="px-2 py-1.5 font-mono break-all">{r.name}</td>
                    <td className="px-2 py-1.5 font-mono break-all text-muted-foreground">
                      {r.value}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-2">
          {s.propagationVerified ? (
            <Badge className="bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/30">
              <ShieldCheck className="size-3" />
              Propagation verified
            </Badge>
          ) : (
            <Badge variant="outline" className="text-amber-600 dark:text-amber-400 border-amber-500/30 bg-amber-500/5">
              <Clock className="size-3" />
              Pending propagation
            </Badge>
          )}
        </div>
        {s.details && (
          <p className="text-xs text-muted-foreground">{s.details}</p>
        )}
      </div>
    </StatusResultCard>
  )
}

function HostingResultCard({ result }: { result: ProvisioningResult }) {
  const s = result.hostingStatus
  if (s.status === 'skipped') {
    return (
      <StatusResultCard title="Web Hosting" icon={Server} status="skipped">
        <p className="text-xs text-muted-foreground">
          Web hosting was not requested for this job.
        </p>
      </StatusResultCard>
    )
  }
  return (
    <StatusResultCard title="Web Hosting" icon={Server} status={s.status}>
      <div className="space-y-0.5">
        {s.url && (
          <DetailRow
            label="Project URL"
            value={
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                {s.url}
                <ExternalLink className="size-3" />
              </a>
            }
            mono
          />
        )}
        {s.projectId && (
          <DetailRow label="Project ID" value={s.projectId} mono />
        )}
        <div className="flex flex-wrap gap-1.5 pt-2">
          <Badge
            variant="outline"
            className={
              s.sslEnabled
                ? 'text-indigo-600 dark:text-indigo-400 border-indigo-500/30 bg-indigo-500/5'
                : 'text-muted-foreground'
            }
          >
            <Lock className="size-3" />
            {s.sslEnabled ? 'SSL enabled' : 'No SSL'}
          </Badge>
          <Badge
            variant="outline"
            className={
              s.healthChecked
                ? 'text-indigo-600 dark:text-indigo-400 border-indigo-500/30 bg-indigo-500/5'
                : 'text-muted-foreground'
            }
          >
            {s.healthChecked ? 'Health: OK' : 'Health: unknown'}
          </Badge>
        </div>
        {s.details && (
          <p className="text-xs text-muted-foreground mt-2 pt-2 border-t border-border">
            {s.details}
          </p>
        )}
      </div>
    </StatusResultCard>
  )
}

function EmailResultCard({ result }: { result: ProvisioningResult }) {
  const s = result.emailStatus
  if (s.status === 'skipped') {
    return (
      <StatusResultCard title="Email Hosting" icon={Mail} status="skipped">
        <p className="text-xs text-muted-foreground">
          Email hosting was not requested for this job.
        </p>
      </StatusResultCard>
    )
  }
  return (
    <StatusResultCard title="Email Hosting" icon={Mail} status={s.status}>
      <div className="space-y-2">
        <div className="rounded-md border border-border divide-y divide-border">
          {s.mailboxes.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground text-center">
              No mailboxes created.
            </p>
          ) : (
            s.mailboxes.map((mb) => (
              <div
                key={mb.address}
                className="flex items-center justify-between gap-2 px-2 py-1.5"
              >
                <span className="text-xs font-mono">{mb.address}</span>
                <Badge variant="outline" className="text-[10px] capitalize">
                  {mb.type}
                </Badge>
              </div>
            ))
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {s.dkimConfigured && (
            <Badge className="text-indigo-600 dark:text-indigo-400 border-indigo-500/30 bg-indigo-500/10">
              <ShieldCheck className="size-3" />
              DKIM configured
            </Badge>
          )}
          {s.smtpEnabled && (
            <Badge variant="outline" className="text-xs">
              SMTP
            </Badge>
          )}
          {s.imapEnabled && (
            <Badge variant="outline" className="text-xs">
              IMAP
            </Badge>
          )}
          {s.webmailUrl && (
            <a
              href={s.webmailUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-400 hover:underline px-2 py-0.5"
            >
              Webmail
              <ExternalLink className="size-3" />
            </a>
          )}
        </div>
        {s.details && (
          <p className="text-xs text-muted-foreground">{s.details}</p>
        )}
      </div>
    </StatusResultCard>
  )
}

// ─── Credentials Card ──────────────────────────────────────────────────────

function SecretRow({
  label,
  value,
  mono = true,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  const [shown, setShown] = useState(false)
  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-border last:border-0">
      <span className="text-xs text-muted-foreground w-20 shrink-0">{label}</span>
      <code
        className={`text-xs flex-1 min-w-0 truncate ${mono ? 'font-mono' : ''} ${
          shown ? '' : 'blur-sm select-none'
        }`}
      >
        {value}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        onClick={() => setShown((v) => !v)}
        title={shown ? 'Hide' : 'Show'}
      >
        {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </Button>
      <CopyButton value={value} label="" className="px-1.5" />
    </div>
  )
}

function CredentialsCard({ result }: { result: ProvisioningResult }) {
  const c = result.credentials

  const downloadJson = () => {
    const blob = new Blob([JSON.stringify(result, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `provisioning-${result.domainStatus.domain}-${result.jobId}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    toast.success('Credentials downloaded')
  }

  return (
    <Card className="border-amber-500/40 bg-amber-500/[0.03]">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-2.5">
          <div className="size-8 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
            <KeyRound className="size-4" />
          </div>
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm">Credentials</CardTitle>
            <CardDescription className="text-xs">
              Save these securely — they won&apos;t be shown again.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={downloadJson}
          >
            <Download className="size-3.5" />
            <span className="hidden sm:inline">JSON</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <Alert className="border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300">
          <AlertTriangle className="size-4" />
          <AlertDescription className="text-xs">
            Mailbox passwords are shown in plaintext this one time. Download them now and store in a password manager.
          </AlertDescription>
        </Alert>

        {/* Domain management */}
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
            Domain Management
          </h4>
          <div className="rounded-md border border-border p-2 space-y-0">
            <DetailRow label="Registrar" value={c.domain.registrar} />
            <DetailRow
              label="Management URL"
              value={
                <a
                  href={c.domain.managementUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  Open
                  <ExternalLink className="size-3" />
                </a>
              }
              mono
            />
          </div>
        </div>

        {/* Nameservers */}
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
            DNS Nameservers
          </h4>
          <div className="rounded-md border border-border p-2">
            {c.dns.nameservers.length === 0 ? (
              <p className="text-xs text-muted-foreground">No nameservers set.</p>
            ) : (
              <div className="space-y-1">
                {c.dns.nameservers.map((ns) => (
                  <div
                    key={ns}
                    className="flex items-center justify-between gap-2"
                  >
                    <code className="text-xs font-mono">{ns}</code>
                    <CopyButton value={ns} label="" className="px-1.5" />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Hosting admin */}
        {c.hosting && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
              Hosting Admin
            </h4>
            <div className="rounded-md border border-border p-2 space-y-0">
              <DetailRow
                label="Admin URL"
                value={
                  <a
                    href={c.hosting.adminUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:underline break-all"
                  >
                    {c.hosting.adminUrl}
                    <ExternalLink className="size-3 shrink-0" />
                  </a>
                }
                mono
              />
              {c.hosting.apiKey && (
                <SecretRow label="API Key" value={c.hosting.apiKey} />
              )}
              {c.hosting.sshKey && (
                <SecretRow label="SSH Key" value={c.hosting.sshKey} />
              )}
            </div>
          </div>
        )}

        {/* Email mailboxes */}
        {c.email && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
              Email Mailboxes
            </h4>
            <div className="rounded-md border border-border p-2 space-y-1">
              {c.email.mailboxes.map((mb) => (
                <div key={mb.address}>
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <code className="text-xs font-mono">{mb.address}</code>
                    <Badge variant="outline" className="text-[10px] capitalize">
                      {mb.type}
                    </Badge>
                  </div>
                  <SecretRow label="Password" value={mb.password} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Mail server settings */}
        {c.email && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
              Mail Server
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="rounded-md border border-border p-2">
                <p className="text-[10px] uppercase text-muted-foreground mb-1">IMAP</p>
                <p className="text-xs font-mono">
                  {c.email.imap.host}:{c.email.imap.port}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {c.email.imap.ssl ? 'SSL/TLS' : 'STARTTLS'}
                </p>
              </div>
              <div className="rounded-md border border-border p-2">
                <p className="text-[10px] uppercase text-muted-foreground mb-1">SMTP</p>
                <p className="text-xs font-mono">
                  {c.email.smtp.host}:{c.email.smtp.port}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {c.email.smtp.tls ? 'TLS' : 'plain'}
                </p>
              </div>
              <div className="rounded-md border border-border p-2">
                <p className="text-[10px] uppercase text-muted-foreground mb-1">Webmail</p>
                <a
                  href={c.email.webmail}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline break-all"
                >
                  {c.email.webmail}
                </a>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Overall Banner ─────────────────────────────────────────────────────────

function OverallBanner({
  result,
  job,
  onRollback,
}: {
  result: ProvisioningResult
  job: ProvisioningJob
  onRollback: () => void
}) {
  const status = result.overallStatus
  const Icon =
    status === 'success'
      ? CheckCircle2
      : status === 'partial'
        ? AlertTriangle
        : XCircle
  const tint =
    status === 'success'
      ? 'border-indigo-500/40 bg-indigo-500/5 text-indigo-700 dark:text-indigo-300'
      : status === 'partial'
        ? 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300'
        : 'border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-300'

  const heading =
    status === 'success'
      ? 'Provisioning complete!'
      : status === 'partial'
        ? 'Provisioning completed with warnings'
        : 'Provisioning failed'

  const subline =
    status === 'success'
      ? `All requested resources are live for ${result.domainStatus.domain}.`
      : status === 'partial'
        ? 'Some steps failed — review the cards below. Working steps remain active.'
        : 'The pipeline could not complete. You can roll back to clean up partial resources.'

  const canRollback =
    job.status !== 'rolled_back' && job.status !== 'running' && job.status !== 'pending'

  return (
    <div className={`rounded-xl border p-4 sm:p-5 ${tint}`}>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <Icon className="size-7 shrink-0" />
        <div className="flex-1 min-w-0">
          <h3 className="text-base sm:text-lg font-semibold">{heading}</h3>
          <p className="text-xs sm:text-sm opacity-90">{subline}</p>
          <div className="flex flex-wrap items-center gap-3 mt-1.5 text-xs">
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" />
              {formatDuration(result.duration)}
            </span>
            <span className="inline-flex items-center gap-1">
              <Globe className="size-3" />
              {result.domainStatus.domain}
            </span>
            {result.errors.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <AlertTriangle className="size-3" />
                {result.errors.length} error{result.errors.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </div>
        {canRollback && (
          <Button
            variant="outline"
            size="sm"
            className="self-start sm:self-center border-current/30 hover:bg-current/10"
            onClick={onRollback}
          >
            <RotateCcw className="size-3.5" />
            Rollback
          </Button>
        )}
      </div>
    </div>
  )
}

// ─── Job Detail View ────────────────────────────────────────────────────────

function JobDetailView({
  jobId,
  onBack,
}: {
  jobId: string
  onBack: () => void
}) {
  const [data, setData] = useState<JobStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [rollingBack, setRollingBack] = useState(false)
  const [confirmRollback, setConfirmRollback] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await apiFetch<JobStatusResponse>(
        `/provisioning/${jobId}/status`
      )
      setData(res)
    } catch (err) {
      toast.error('Failed to load job status', {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setLoading(false)
    }
  }, [jobId])

  useEffect(() => {
    setLoading(true)
    fetchStatus()
  }, [fetchStatus])

  // Poll while the job is not in a terminal state
  useEffect(() => {
    if (!data) return
    const status = data.job?.status
    const isTerminal =
      status === 'success' || status === 'failed' || status === 'rolled_back'
    if (isTerminal) {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      return
    }
    if (!pollRef.current) {
      pollRef.current = setInterval(fetchStatus, 2000)
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [data, fetchStatus])

  const handleRollback = async () => {
    setRollingBack(true)
    setConfirmRollback(false)
    try {
      await apiFetch(`/provisioning/${jobId}/rollback`, { method: 'POST' })
      toast.success('Rollback triggered', {
        description: 'Cleaning up created resources…',
      })
      await fetchStatus()
    } catch (err) {
      toast.error('Rollback failed', {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setRollingBack(false)
    }
  }

  if (loading || !data) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-md" />
          <div className="space-y-1.5 flex-1">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }

  const { job, steps, result } = data
  const Icon = getStackIcon(job.stack)

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <Button variant="ghost" size="icon" onClick={onBack} className="shrink-0">
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="size-8 rounded-md bg-indigo-600/10 flex items-center justify-center shrink-0">
              <Icon className="size-4 text-indigo-600 dark:text-indigo-400" />
            </div>
            <h2 className="text-lg font-semibold truncate">{job.domainName}</h2>
            <StatusBadge status={job.status} />
            <Badge variant="outline" className="capitalize">
              {job.stack}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Job ID: <code className="font-mono">{job.id}</code> · Created {timeAgo(job.createdAt)}
            {job.startedAt && ` · Started ${timeAgo(job.startedAt)}`}
            {job.completedAt && ` · Completed ${timeAgo(job.completedAt)}`}
          </p>
        </div>
      </div>

      {/* Overall banner */}
      {result && (
        <OverallBanner
          result={result}
          job={job}
          onRollback={() => setConfirmRollback(true)}
        />
      )}

      {/* Pipeline */}
      <PipelineProgress steps={steps} />

      {/* Error display for failed non-critical steps */}
      {result && result.errors.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Step errors</AlertTitle>
          <AlertDescription>
            <ul className="list-disc ms-4 space-y-0.5 text-xs">
              {result.errors.map((e, i) => (
                <li key={i}>
                  <span className="font-medium capitalize">{e.step}:</span>{' '}
                  <span className="break-all">{e.error}</span>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* Structured result cards */}
      {result ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <DomainResultCard result={result} />
          <DnsResultCard result={result} />
          <HostingResultCard result={result} />
          <EmailResultCard result={result} />
          <div className="md:col-span-2">
            <CredentialsCard result={result} />
          </div>
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Awaiting results…</CardTitle>
            <CardDescription>
              Structured results will appear here once the pipeline completes.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {['Domain', 'DNS', 'Hosting', 'Email'].map((label) => (
              <Skeleton key={label} className="h-32 rounded-lg" />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Rollback section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <RotateCcw className="size-4 text-orange-500" />
            Danger Zone
          </CardTitle>
          <CardDescription>
            Roll back this job to delete any created mailboxes, hosting apps, and DNS records.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              className="border-orange-500/40 text-orange-600 dark:text-orange-400 hover:bg-orange-500/10"
              disabled={
                rollingBack ||
                job.status === 'rolled_back' ||
                job.status === 'running' ||
                job.status === 'pending'
              }
              onClick={() => setConfirmRollback(true)}
            >
              {rollingBack ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCcw className="size-4" />
              )}
              Roll Back Provisioning
            </Button>
            {job.status === 'rolled_back' && (
              <Badge className="bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30">
                <CheckCircle2 className="size-3" />
                Already rolled back
              </Badge>
            )}
            {job.rollbackStartedAt && (
              <span className="text-xs text-muted-foreground">
                Rollback started {formatDate(job.rollbackStartedAt)}
                {job.rollbackCompletedAt &&
                  ` · completed ${formatDate(job.rollbackCompletedAt)}`}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Rollback confirmation */}
      <AlertDialog open={confirmRollback} onOpenChange={setConfirmRollback}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back this provisioning job?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the mailboxes, Mailcow domain, hosting
              project, and DNS records that were created for{' '}
              <span className="font-medium text-foreground">{job.domainName}</span>.
              The registered domain itself cannot be unregistered, but will be
              marked cancelled in our system. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rollingBack}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRollback}
              disabled={rollingBack}
              className="bg-orange-600 hover:bg-orange-700 text-white"
            >
              {rollingBack ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Rolling back…
                </>
              ) : (
                <>
                  <RotateCcw className="size-4" />
                  Yes, roll back
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─── Jobs List ──────────────────────────────────────────────────────────────

function JobsList({
  jobs,
  loading,
  onSelect,
  onNew,
}: {
  jobs: ProvisioningJob[]
  loading: boolean
  onSelect: (job: ProvisioningJob) => void
  onNew: () => void
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    )
  }

  if (jobs.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-12 flex flex-col items-center text-center">
          <div className="size-12 rounded-full bg-indigo-600/10 flex items-center justify-center mb-3">
            <Rocket className="size-6 text-indigo-600 dark:text-indigo-400" />
          </div>
          <h3 className="text-base font-semibold">No provisioning jobs yet</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">
            Start your first automated deployment — we&apos;ll register a domain,
            configure DNS, deploy hosting, and provision email in one click.
          </p>
          <Button
            className="mt-4 bg-indigo-600 hover:bg-indigo-700 text-white"
            onClick={onNew}
          >
            <Zap className="size-4" />
            Start Provisioning
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Recent Jobs</CardTitle>
        <CardDescription>
          {jobs.length} job{jobs.length === 1 ? '' : 's'} · auto-refreshing while any are running
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {/* Desktop table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="text-start font-medium px-4 py-2.5">Domain</th>
                <th className="text-start font-medium px-4 py-2.5">Stack</th>
                <th className="text-start font-medium px-4 py-2.5">Status</th>
                <th className="text-start font-medium px-4 py-2.5">Created</th>
                <th className="text-end font-medium px-4 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const Icon = getStackIcon(job.stack)
                return (
                  <tr
                    key={job.id}
                    className="border-t border-border hover:bg-muted/30 transition-colors cursor-pointer"
                    onClick={() => onSelect(job)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Globe className="size-3.5 text-muted-foreground shrink-0" />
                        <span className="font-medium truncate max-w-[180px]">
                          {job.domainName}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Icon className="size-3.5 text-muted-foreground" />
                        <span className="capitalize text-muted-foreground">{job.stack}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={job.status} />
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {timeAgo(job.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          onSelect(job)
                        }}
                      >
                        View
                        <ChevronRight className="size-3.5" />
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <div className="md:hidden divide-y divide-border">
          {jobs.map((job) => {
            const Icon = getStackIcon(job.stack)
            return (
              <button
                key={job.id}
                onClick={() => onSelect(job)}
                className="w-full text-start p-3 hover:bg-muted/30 transition-colors flex items-center gap-3"
              >
                <div className="size-9 rounded-md bg-indigo-600/10 flex items-center justify-center shrink-0">
                  <Icon className="size-4 text-indigo-600 dark:text-indigo-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">{job.domainName}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <StatusBadge status={job.status} />
                    <span className="text-xs text-muted-foreground">{timeAgo(job.createdAt)}</span>
                  </div>
                </div>
                <ChevronRight className="size-4 text-muted-foreground shrink-0" />
              </button>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Main Panel ─────────────────────────────────────────────────────────────

export default function ProvisioningPanel() {
  const [jobs, setJobs] = useState<ProvisioningJob[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchJobs = useCallback(async () => {
    try {
      const data = await apiFetch<{ jobs: ProvisioningJob[] }>('/provisioning')
      setJobs(data.jobs || [])
    } catch (err) {
      if (loading) {
        toast.error('Failed to load provisioning jobs', {
          description: err instanceof Error ? err.message : undefined,
        })
      }
    } finally {
      setLoading(false)
    }
  }, [loading])

  useEffect(() => {
    fetchJobs()
  }, [fetchJobs])

  // Poll every 3s when there are running/pending jobs
  useEffect(() => {
    const hasActive = jobs.some(
      (j) => j.status === 'running' || j.status === 'pending'
    )
    if (hasActive && !selectedJobId) {
      if (!pollRef.current) {
        pollRef.current = setInterval(fetchJobs, 3000)
      }
    } else if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => {
      if (pollRef.current && !hasActive) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [jobs, selectedJobId, fetchJobs])

  if (selectedJobId) {
    return (
      <div className="space-y-4">
        <JobDetailView
          jobId={selectedJobId}
          onBack={() => {
            setSelectedJobId(null)
            setLoading(true)
            fetchJobs()
          }}
        />
        <NewProvisioningDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onStarted={(jobId) => setSelectedJobId(jobId)}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <div className="size-8 rounded-lg bg-indigo-600/10 flex items-center justify-center">
              <Rocket className="size-5 text-indigo-600 dark:text-indigo-400" />
            </div>
            Automated Provisioning
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Deploy domains, hosting, and email in one click.
          </p>
        </div>
        <Button
          className="bg-indigo-600 hover:bg-indigo-700 text-white"
          onClick={() => setDialogOpen(true)}
        >
          <Zap className="size-4" />
          New Provisioning
        </Button>
      </div>

      {/* Quick stats */}
      {!loading && jobs.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Total', value: jobs.length, icon: Rocket, tint: 'text-indigo-600 dark:text-indigo-400 bg-indigo-600/10', spin: false },
            {
              label: 'Running',
              value: jobs.filter((j) => j.status === 'running' || j.status === 'pending').length,
              icon: Loader2,
              tint: 'text-indigo-600 dark:text-indigo-400 bg-indigo-600/10',
              spin: true,
            },
            {
              label: 'Succeeded',
              value: jobs.filter((j) => j.status === 'success').length,
              icon: CheckCircle2,
              tint: 'text-indigo-600 dark:text-indigo-400 bg-indigo-600/10',
              spin: false,
            },
            {
              label: 'Failed',
              value: jobs.filter((j) => j.status === 'failed' || j.status === 'rolled_back').length,
              icon: AlertTriangle,
              tint: 'text-orange-600 dark:text-orange-400 bg-orange-600/10',
              spin: false,
            },
          ].map((s) => {
            const SIcon = s.icon
            return (
              <Card key={s.label}>
                <CardContent className="p-3 flex items-center gap-3">
                  <div className={`size-9 rounded-md flex items-center justify-center shrink-0 ${s.tint}`}>
                    <SIcon className={`size-4 ${s.spin ? 'animate-spin' : ''}`} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xl font-bold leading-none">{s.value}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{s.label}</p>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Jobs list */}
      <JobsList
        jobs={jobs}
        loading={loading}
        onSelect={(job) => setSelectedJobId(job.id)}
        onNew={() => setDialogOpen(true)}
      />

      <NewProvisioningDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onStarted={(jobId) => setSelectedJobId(jobId)}
      />
    </div>
  )
}
