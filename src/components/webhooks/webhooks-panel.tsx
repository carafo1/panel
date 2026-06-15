'use client'

import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '@/store/auth-store'
import { toast } from 'sonner'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Checkbox } from '@/components/ui/checkbox'
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
  Webhook,
  Plus,
  Trash2,
  ExternalLink,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Clock,
  Send,
  Loader2,
  Copy,
  Eye,
  EyeOff,
  Globe,
  Zap,
  Key,
} from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────

interface WebhookItem {
  id: string
  name: string
  url: string
  secret: string
  events: string[]
  active: boolean
  projectId: string | null
  project: {
    id: string
    name: string
    slug: string
  } | null
  deliveryCount: number
  lastTriggeredAt: string | null
  createdAt: string
  updatedAt: string
}

interface WebhookDelivery {
  id: string
  event: string
  statusCode: number | null
  success: boolean
  duration: number | null
  createdAt: string
}

interface WebhookDetail extends WebhookItem {
  recentDeliveries: WebhookDelivery[]
}

interface ProjectOption {
  id: string
  name: string
  slug: string
}

// ── Constants ────────────────────────────────────────────────────────────

const WEBHOOK_EVENTS = [
  { id: 'deployment.success', label: 'Deployment Success', description: 'When a deployment succeeds' },
  { id: 'deployment.failed', label: 'Deployment Failed', description: 'When a deployment fails' },
  { id: 'deployment.started', label: 'Deployment Started', description: 'When a deployment starts' },
  { id: 'domain.registered', label: 'Domain Registered', description: 'When a new domain is registered' },
  { id: 'domain.expiring', label: 'Domain Expiring', description: 'When a domain is about to expire' },
  { id: 'project.created', label: 'Project Created', description: 'When a new project is created' },
  { id: 'project.deleted', label: 'Project Deleted', description: 'When a project is deleted' },
  { id: 'ssl.renewed', label: 'SSL Renewed', description: 'When an SSL certificate is renewed' },
  { id: 'payment.success', label: 'Payment Success', description: 'When a payment succeeds' },
  { id: 'payment.failed', label: 'Payment Failed', description: 'When a payment fails' },
]

// ── Helper ───────────────────────────────────────────────────────────────

function truncateUrl(url: string, maxLen = 45): string {
  if (url.length <= maxLen) return url
  return url.substring(0, maxLen - 3) + '...'
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never'
  const diff = Date.now() - new Date(dateStr).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'Just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function getEventBadgeColor(eventId: string): string {
  const prefix = eventId.split('.')[0]
  switch (prefix) {
    case 'deployment':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
    case 'domain':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
    case 'project':
      return 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300'
    case 'ssl':
      return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300'
    case 'payment':
      return 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300'
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
  }
}

function getEventLabel(eventId: string): string {
  const found = WEBHOOK_EVENTS.find((e) => e.id === eventId)
  return found ? found.label : eventId
}

// ── Component ────────────────────────────────────────────────────────────

export default function WebhooksPanel() {
  // ── State ──────────────────────────────────────────────────────────────
  const [webhooks, setWebhooks] = useState<WebhookItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedWebhook, setSelectedWebhook] = useState<WebhookDetail | null>(null)
  const [view, setView] = useState<'list' | 'detail'>('list')

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm, setCreateForm] = useState({
    name: '',
    url: '',
    projectId: '',
    events: [] as string[],
  })
  const [creating, setCreating] = useState(false)
  const [projects, setProjects] = useState<ProjectOption[]>([])

  // Delete dialog
  const [deleteTarget, setDeleteTarget] = useState<WebhookItem | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Detail view
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([])
  const [deliveriesLoading, setDeliveriesLoading] = useState(false)
  const [secretVisible, setSecretVisible] = useState(false)
  const [testingWebhookId, setTestingWebhookId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  // ── Fetch webhooks ─────────────────────────────────────────────────────
  const fetchWebhooks = useCallback(async () => {
    try {
      setLoading(true)
      const data = await apiFetch('/webhooks')
      setWebhooks(data.webhooks || [])
    } catch (err) {
      toast.error('Failed to load webhooks', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Fetch projects for the create dialog ───────────────────────────────
  const fetchProjects = useCallback(async () => {
    try {
      const data = await apiFetch('/hosting')
      setProjects(
        (data.projects || []).map((p: { id: string; name: string; slug: string }) => ({
          id: p.id,
          name: p.name,
          slug: p.slug,
        }))
      )
    } catch {
      // Silently fail — project selector will just be empty
    }
  }, [])

  useEffect(() => {
    fetchWebhooks()
  }, [fetchWebhooks])

  useEffect(() => {
    if (createOpen) {
      fetchProjects()
    }
  }, [createOpen, fetchProjects])

  // ── Create webhook ─────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!createForm.name.trim()) {
      toast.error('Name is required')
      return
    }
    if (!createForm.url.trim()) {
      toast.error('URL is required')
      return
    }
    try {
      new URL(createForm.url)
    } catch {
      toast.error('Invalid URL format')
      return
    }
    if (createForm.events.length === 0) {
      toast.error('Select at least one event')
      return
    }

    try {
      setCreating(true)
      await apiFetch('/webhooks', {
        method: 'POST',
        body: JSON.stringify({
          name: createForm.name.trim(),
          url: createForm.url.trim(),
          projectId: createForm.projectId || null,
          events: createForm.events,
          active: true,
        }),
      })
      toast.success('Webhook created', {
        description: `${createForm.name} is now active.`,
      })
      setCreateOpen(false)
      setCreateForm({ name: '', url: '', projectId: '', events: [] })
      fetchWebhooks()
    } catch (err) {
      toast.error('Failed to create webhook', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setCreating(false)
    }
  }

  // ── Delete webhook ─────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      setDeleting(true)
      await apiFetch(`/webhooks/${deleteTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ _delete: true }),
      })
      toast.success('Webhook deleted', {
        description: `${deleteTarget.name} has been removed.`,
      })
      setDeleteTarget(null)
      if (selectedWebhook?.id === deleteTarget.id) {
        setSelectedWebhook(null)
        setView('list')
      }
      fetchWebhooks()
    } catch (err) {
      toast.error('Failed to delete webhook', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setDeleting(false)
    }
  }

  // ── Toggle active/inactive ─────────────────────────────────────────────
  const handleToggleActive = async (webhook: WebhookItem) => {
    try {
      setTogglingId(webhook.id)
      await apiFetch(`/webhooks/${webhook.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !webhook.active }),
      })
      toast.success(webhook.active ? 'Webhook disabled' : 'Webhook enabled', {
        description: `${webhook.name} is now ${webhook.active ? 'inactive' : 'active'}.`,
      })
      fetchWebhooks()
      // Also refresh detail view if it's the same webhook
      if (selectedWebhook?.id === webhook.id) {
        fetchWebhookDetail(webhook.id)
      }
    } catch (err) {
      toast.error('Failed to update webhook', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setTogglingId(null)
    }
  }

  // ── Fetch webhook detail + deliveries ──────────────────────────────────
  const fetchWebhookDetail = async (id: string) => {
    try {
      const data = await apiFetch(`/webhooks/${id}`)
      setSelectedWebhook(data.webhook)
      // Recent deliveries come from the detail endpoint
      setDeliveries(data.webhook?.recentDeliveries || [])
    } catch (err) {
      toast.error('Failed to load webhook details', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  const fetchDeliveries = async (id: string) => {
    try {
      setDeliveriesLoading(true)
      const data = await apiFetch(`/webhooks/${id}/deliveries`)
      setDeliveries(data.deliveries || [])
    } catch (err) {
      toast.error('Failed to load deliveries', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setDeliveriesLoading(false)
    }
  }

  // ── Open detail view ───────────────────────────────────────────────────
  const openDetail = (webhook: WebhookItem) => {
    setView('detail')
    setSecretVisible(false)
    // Set initial data from list item
    setSelectedWebhook({
      ...webhook,
      recentDeliveries: [],
    })
    fetchWebhookDetail(webhook.id)
    fetchDeliveries(webhook.id)
  }

  // ── Test webhook ───────────────────────────────────────────────────────
  const handleTestWebhook = async (id: string, name: string) => {
    try {
      setTestingWebhookId(id)
      const data = await apiFetch(`/webhooks/${id}/test`, {
        method: 'POST',
      })
      if (data.delivery?.success) {
        toast.success('Test delivery succeeded', {
          description: `Status ${data.delivery.statusCode} in ${data.delivery.duration}ms`,
        })
      } else {
        toast.error('Test delivery failed', {
          description: data.delivery?.statusCode
            ? `Status ${data.delivery.statusCode} in ${data.delivery.duration}ms`
            : 'Could not reach the endpoint',
        })
      }
      // Refresh deliveries if viewing detail
      if (selectedWebhook?.id === id) {
        fetchDeliveries(id)
        fetchWebhookDetail(id)
      }
      fetchWebhooks()
    } catch (err) {
      toast.error('Test delivery failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setTestingWebhookId(null)
    }
  }

  // ── Copy secret ────────────────────────────────────────────────────────
  const copySecret = (secret: string) => {
    navigator.clipboard.writeText(secret).then(
      () => toast.success('Secret copied to clipboard'),
      () => toast.error('Failed to copy secret')
    )
  }

  // ── Event toggle in create form ────────────────────────────────────────
  const toggleEvent = (eventId: string) => {
    setCreateForm((prev) => ({
      ...prev,
      events: prev.events.includes(eventId)
        ? prev.events.filter((e) => e !== eventId)
        : [...prev.events, eventId],
    }))
  }

  // ── Render: Loading skeleton ───────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-10 w-36" />
        </div>
        {[1, 2, 3].map((i) => (
          <Card key={i}>
            <CardContent className="p-6">
              <div className="space-y-3">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-64" />
                <div className="flex gap-2">
                  <Skeleton className="h-6 w-24" />
                  <Skeleton className="h-6 w-24" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  // ── Render: Detail view ────────────────────────────────────────────────
  if (view === 'detail' && selectedWebhook) {
    return (
      <div className="space-y-6 p-4 md:p-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              setView('list')
              setSelectedWebhook(null)
              fetchWebhooks()
            }}
            className="shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xl font-semibold">{selectedWebhook.name}</h2>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Globe className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{selectedWebhook.url}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleTestWebhook(selectedWebhook.id, selectedWebhook.name)}
              disabled={testingWebhookId === selectedWebhook.id}
            >
              {testingWebhookId === selectedWebhook.id ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="mr-1.5 h-3.5 w-3.5" />
              )}
              Test
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleToggleActive(selectedWebhook)}
              disabled={togglingId === selectedWebhook.id}
            >
              {togglingId === selectedWebhook.id ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              {selectedWebhook.active ? 'Disable' : 'Enable'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:bg-destructive/10"
              onClick={() => setDeleteTarget(selectedWebhook)}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete
            </Button>
          </div>
        </div>

        {/* Status & meta */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Webhook Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {/* Status */}
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">Status</p>
                <div className="flex items-center gap-2">
                  {selectedWebhook.active ? (
                    <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      <CheckCircle2 className="mr-1 h-3 w-3" />
                      Active
                    </Badge>
                  ) : (
                    <Badge variant="secondary">
                      <XCircle className="mr-1 h-3 w-3" />
                      Inactive
                    </Badge>
                  )}
                </div>
              </div>

              {/* Project */}
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">Project</p>
                <p className="text-sm">
                  {selectedWebhook.project ? selectedWebhook.project.name : 'All Projects'}
                </p>
              </div>

              {/* Last triggered */}
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">Last Triggered</p>
                <div className="flex items-center gap-1.5 text-sm">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  {formatRelativeTime(selectedWebhook.lastTriggeredAt)}
                </div>
              </div>

              {/* Created */}
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">Created</p>
                <p className="text-sm">
                  {new Date(selectedWebhook.createdAt).toLocaleDateString(undefined, {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  })}
                </p>
              </div>
            </div>

            <Separator />

            {/* Events */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Subscribed Events</p>
              <div className="flex flex-wrap gap-2">
                {selectedWebhook.events.map((evt) => (
                  <Badge key={evt} variant="secondary" className={getEventBadgeColor(evt)}>
                    <Zap className="mr-1 h-3 w-3" />
                    {getEventLabel(evt)}
                  </Badge>
                ))}
              </div>
            </div>

            <Separator />

            {/* Secret */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">
                <Key className="mr-1 inline h-3.5 w-3.5" />
                Signing Secret
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md bg-muted px-3 py-2 text-xs font-mono break-all">
                  {secretVisible
                    ? selectedWebhook.secret
                    : '•••••••••••••••••••••••••••••••••••••••••••'}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  onClick={() => setSecretVisible(!secretVisible)}
                >
                  {secretVisible ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  onClick={() => copySecret(selectedWebhook.secret)}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Use this secret to verify webhook signatures. The signature is sent in the{' '}
                <code className="rounded bg-muted px-1 py-0.5">X-DeployHub-Signature</code> header.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Delivery history */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Delivery History</CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => fetchDeliveries(selectedWebhook.id)}
                disabled={deliveriesLoading}
              >
                {deliveriesLoading ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : null}
                Refresh
              </Button>
            </div>
            <CardDescription>Recent webhook deliveries and their status</CardDescription>
          </CardHeader>
          <CardContent>
            {deliveriesLoading && deliveries.length === 0 ? (
              <div className="space-y-3 py-4">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : deliveries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Send className="mb-3 h-10 w-10 text-muted-foreground/40" />
                <p className="text-sm font-medium text-muted-foreground">No deliveries yet</p>
                <p className="mt-1 text-xs text-muted-foreground/70">
                  Test the webhook or wait for an event to trigger a delivery.
                </p>
              </div>
            ) : (
              <ScrollArea className="max-h-96">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Event</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead className="text-right">Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deliveries.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell>
                          <Badge variant="secondary" className={getEventBadgeColor(d.event)}>
                            {getEventLabel(d.event)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            {d.success ? (
                              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                            ) : (
                              <XCircle className="h-4 w-4 text-destructive" />
                            )}
                            <span className="text-sm">
                              {d.statusCode ?? '—'}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {d.duration != null ? `${d.duration}ms` : '—'}
                        </TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground">
                          {formatRelativeTime(d.createdAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        {/* Delete confirmation dialog (detail view) */}
        <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Webhook</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This action
                cannot be undone. All delivery history will be permanently removed.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                disabled={deleting}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {deleting ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="mr-1.5 h-4 w-4" />
                )}
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    )
  }

  // ── Render: List view ──────────────────────────────────────────────────
  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Webhooks</h2>
          <p className="text-sm text-muted-foreground">
            Manage webhook endpoints to receive real-time event notifications.
          </p>
        </div>
        <Button
          onClick={() => setCreateOpen(true)}
          className="bg-emerald-600 hover:bg-emerald-700 shrink-0"
        >
          <Plus className="mr-1.5 h-4 w-4" />
          New Webhook
        </Button>
      </div>

      {/* Empty state */}
      {webhooks.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 rounded-full bg-emerald-100 p-4 dark:bg-emerald-950">
              <Webhook className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
            </div>
            <h3 className="text-lg font-semibold">No webhooks configured</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Create a webhook to receive HTTP requests when events like deployments, domain changes,
              or payments occur in your projects.
            </p>
            <Button
              onClick={() => setCreateOpen(true)}
              className="mt-4 bg-emerald-600 hover:bg-emerald-700"
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Create Your First Webhook
            </Button>
          </CardContent>
        </Card>
      ) : (
        /* Webhook list */
        <div className="grid gap-4">
          {webhooks.map((wh) => (
            <Card
              key={wh.id}
              className="group transition-shadow hover:shadow-md cursor-pointer"
              onClick={() => openDetail(wh)}
            >
              <CardContent className="p-4 md:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  {/* Left: info */}
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-emerald-100 dark:bg-emerald-950">
                        <Webhook className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="font-medium leading-tight">{wh.name}</h3>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Globe className="h-3 w-3 shrink-0" />
                          <span className="truncate">{truncateUrl(wh.url)}</span>
                          <ExternalLink className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </div>
                    </div>

                    {/* Events */}
                    <div className="flex flex-wrap gap-1.5">
                      {wh.events.slice(0, 3).map((evt) => (
                        <Badge
                          key={evt}
                          variant="secondary"
                          className={`text-xs ${getEventBadgeColor(evt)}`}
                        >
                          {getEventLabel(evt)}
                        </Badge>
                      ))}
                      {wh.events.length > 3 && (
                        <Badge variant="secondary" className="text-xs">
                          +{wh.events.length - 3} more
                        </Badge>
                      )}
                    </div>

                    {/* Meta row */}
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      {wh.project && (
                        <span className="flex items-center gap-1">
                          <Globe className="h-3 w-3" />
                          {wh.project.name}
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatRelativeTime(wh.lastTriggeredAt)}
                      </span>
                      {wh.deliveryCount > 0 && (
                        <span>{wh.deliveryCount} deliveries</span>
                      )}
                    </div>
                  </div>

                  {/* Right: actions */}
                  <div className="flex items-center gap-3 shrink-0" onClick={(e) => e.stopPropagation()}>
                    {/* Active toggle */}
                    <div className="flex items-center gap-2">
                      {togglingId === wh.id ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : (
                        <Switch
                          checked={wh.active}
                          onCheckedChange={() => handleToggleActive(wh)}
                          aria-label={`Toggle ${wh.name}`}
                          className="data-[state=checked]:bg-emerald-600"
                        />
                      )}
                      <span className="text-xs text-muted-foreground">
                        {wh.active ? 'Active' : 'Inactive'}
                      </span>
                    </div>

                    {/* Test */}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleTestWebhook(wh.id, wh.name)}
                      disabled={testingWebhookId === wh.id || !wh.active}
                    >
                      {testingWebhookId === wh.id ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Send className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      Test
                    </Button>

                    {/* Delete */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteTarget(wh)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ── Create Dialog ──────────────────────────────────────────────── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Webhook className="h-5 w-5 text-emerald-600" />
              Create Webhook
            </DialogTitle>
            <DialogDescription>
              Set up a new webhook to receive event notifications at your endpoint.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="wh-name">Name</Label>
              <Input
                id="wh-name"
                placeholder="e.g., Slack Notifications"
                value={createForm.name}
                onChange={(e) => setCreateForm((p) => ({ ...p, name: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                A descriptive name to identify this webhook.
              </p>
            </div>

            {/* URL */}
            <div className="space-y-2">
              <Label htmlFor="wh-url">Payload URL</Label>
              <Input
                id="wh-url"
                placeholder="https://example.com/webhooks/deployhub"
                value={createForm.url}
                onChange={(e) => setCreateForm((p) => ({ ...p, url: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                The URL where DeployHub will send HTTP POST requests.
              </p>
            </div>

            {/* Project selector */}
            <div className="space-y-2">
              <Label>Project (Optional)</Label>
              <Select
                value={createForm.projectId}
                onValueChange={(val) =>
                  setCreateForm((p) => ({ ...p, projectId: val === '__all__' ? '' : val }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="All Projects" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All Projects</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Limit this webhook to events from a specific project.
              </p>
            </div>

            <Separator />

            {/* Events */}
            <div className="space-y-3">
              <Label>Events</Label>
              <p className="text-xs text-muted-foreground">
                Choose which events should trigger this webhook.
              </p>
              <div className="space-y-2">
                {WEBHOOK_EVENTS.map((evt) => (
                  <label
                    key={evt.id}
                    className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors hover:bg-muted/50 has-[:checked]:border-emerald-500 has-[:checked]:bg-emerald-50 dark:has-[:checked]:bg-emerald-950/30"
                  >
                    <Checkbox
                      checked={createForm.events.includes(evt.id)}
                      onCheckedChange={() => toggleEvent(evt.id)}
                      className="mt-0.5 data-[state=checked]:bg-emerald-600 data-[state=checked]:border-emerald-600"
                    />
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium leading-none">{evt.label}</p>
                      <p className="text-xs text-muted-foreground">{evt.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={creating}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {creating ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-1.5 h-4 w-4" />
              )}
              Create Webhook
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirmation (list view) ─────────────────────────────── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Webhook</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This action
              cannot be undone. All delivery history will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-1.5 h-4 w-4" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
