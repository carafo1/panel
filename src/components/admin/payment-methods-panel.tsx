'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { Skeleton } from '@/components/ui/skeleton'
import {
  CreditCard,
  Wallet,
  Building,
  Settings,
  AlertTriangle,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { toast } from 'sonner'

// ── Types ──────────────────────────────────────────────────────────────
interface PaymentMethod {
  method: string // "stripe" | "waafi" | "manual"
  displayName: string
  active: boolean
  icon: string | null
  sortOrder: number
  config: Record<string, unknown> | null
}

// ── Icon resolver ──────────────────────────────────────────────────────
// Maps a payment-method `icon` string to a Lucide component. Falls back to
// a method-based lookup so the UI keeps working even when the icon column
// is empty.
const ICON_MAP: Record<string, React.ElementType> = {
  'credit-card': CreditCard,
  creditcard: CreditCard,
  stripe: CreditCard,
  card: CreditCard,
  wallet: Wallet,
  waafi: Wallet,
  banknote: Building,
  bank: Building,
  building: Building,
  manual: Building,
}

function getMethodIcon(method: string, icon: string | null): React.ElementType {
  if (icon) {
    const key = icon.toLowerCase().trim()
    if (ICON_MAP[key]) return ICON_MAP[key]
  }
  if (method === 'stripe') return CreditCard
  if (method === 'waafi') return Wallet
  if (method === 'manual') return Building
  return CreditCard
}

const METHOD_DESCRIPTIONS: Record<string, string> = {
  stripe:
    'Credit / debit card payments processed by Stripe. Best international option with automatic reconciliation.',
  waafi:
    'Waafi Pay — popular mobile-money / wallet gateway in East Africa. Requires merchant credentials.',
  manual:
    'Manual bank transfer. The user uploads / emails proof of payment and an admin confirms the subscription manually.',
}

// ── API helper ─────────────────────────────────────────────────────────
async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('deployhub_token')
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(data.error || `Request failed with status ${res.status}`)
  }
  return res.json()
}

// ── Config Editor Dialog ───────────────────────────────────────────────
function ConfigDialog({
  open,
  onOpenChange,
  method,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  method: PaymentMethod | null
  onSaved: () => void
}) {
  const [displayName, setDisplayName] = useState('')
  const [icon, setIcon] = useState('')
  const [sortOrder, setSortOrder] = useState(0)
  const [configText, setConfigText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset form whenever a new method is opened.
  useEffect(() => {
    if (method) {
      setDisplayName(method.displayName)
      setIcon(method.icon || '')
      setSortOrder(method.sortOrder)
      setConfigText(
        method.config ? JSON.stringify(method.config, null, 2) : '{}'
      )
      setError(null)
    }
  }, [method])

  if (!method) return null

  const Icon = getMethodIcon(method.method, method.icon)

  const handleSave = async () => {
    setLoading(true)
    setError(null)
    try {
      // Validate JSON config first.
      let parsedConfig: unknown = null
      try {
        parsedConfig = JSON.parse(configText || '{}')
      } catch (e) {
        throw new Error(
          'Config JSON is invalid: ' +
            (e instanceof Error ? e.message : String(e))
        )
      }

      const sortOrderNum = Number(sortOrder)
      if (!Number.isFinite(sortOrderNum)) {
        throw new Error('Sort order must be a number')
      }

      await apiFetch(`/admin/payment-methods/${method.method}`, {
        method: 'PATCH',
        body: JSON.stringify({
          displayName: displayName.trim() || method.displayName,
          icon: icon.trim() || null,
          sortOrder: sortOrderNum,
          config: parsedConfig,
        }),
      })

      toast.success(`${method.method} settings updated`)
      onSaved()
      onOpenChange(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save'
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="size-5 text-emerald-600" />
            Configure {method.displayName}
          </DialogTitle>
          <DialogDescription>
            Update the display name, icon, sort order, and provider-specific
            config. Changes apply immediately to the checkout UI.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Display name */}
          <div className="space-y-2">
            <Label htmlFor="pm-display-name">Display Name</Label>
            <Input
              id="pm-display-name"
              placeholder="Credit / Debit Card"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Shown to users in the checkout payment-method picker.
            </p>
          </div>

          {/* Icon */}
          <div className="space-y-2">
            <Label htmlFor="pm-icon">Icon Key</Label>
            <Input
              id="pm-icon"
              placeholder="credit-card | wallet | building"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              One of: <code>credit-card</code>, <code>wallet</code>,{' '}
              <code>building</code>. Falls back to a per-method default when
              empty.
            </p>
          </div>

          {/* Sort order */}
          <div className="space-y-2">
            <Label htmlFor="pm-sort">Sort Order</Label>
            <Input
              id="pm-sort"
              type="number"
              placeholder="10"
              value={sortOrder}
              onChange={(e) => setSortOrder(Number(e.target.value))}
            />
            <p className="text-xs text-muted-foreground">
              Lower numbers appear first in the checkout picker.
            </p>
          </div>

          {/* Method-specific config (JSON editor) */}
          <div className="space-y-2">
            <Label htmlFor="pm-config">
              Method Config (JSON)
            </Label>
            <Textarea
              id="pm-config"
              className="font-mono text-xs min-h-[160px]"
              spellCheck={false}
              value={configText}
              onChange={(e) => setConfigText(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {method.method === 'waafi' &&
                'Waafi: e.g. { "merchantId": "...", "apiUserId": "..." }. Secrets live in env vars, not here.'}
              {method.method === 'manual' &&
                'Manual: bank details shown to the user. e.g. { "bankName": "...", "accountNumber": "...", "instructions": "..." }'}
              {method.method === 'stripe' &&
                'Stripe: usually empty — Stripe secret / publishable keys live in env vars.'}
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={loading}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                Saving…
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <Settings className="size-4" />
                Save Settings
              </span>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Component ──────────────────────────────────────────────────────────
export function PaymentMethodsPanel() {
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState<string | null>(null)
  const [configTarget, setConfigTarget] = useState<PaymentMethod | null>(null)
  const [configOpen, setConfigOpen] = useState(false)

  const fetchMethods = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch<{ methods: PaymentMethod[] }>(
        '/admin/payment-methods'
      )
      setMethods(res.methods || [])
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : 'Failed to load payment methods. Make sure you have super admin access.'
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchMethods()
  }, [fetchMethods])

  const activeCount = methods.filter((m) => m.active).length

  const handleToggle = async (method: PaymentMethod, nextActive: boolean) => {
    // Warning: disabling the LAST active method.
    if (!nextActive && activeCount <= 1) {
      const ok = window.confirm(
        `You are about to disable the last active payment method (${method.displayName}). ` +
          'No users will be able to complete checkout until at least one method is re-enabled. Continue?'
      )
      if (!ok) return
    }

    setToggling(method.method)
    try {
      await apiFetch(`/admin/payment-methods/${method.method}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: nextActive }),
      })
      toast.success(
        `${method.displayName} ${nextActive ? 'enabled' : 'disabled'}`
      )
      await fetchMethods()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Toggle failed')
    } finally {
      setToggling(null)
    }
  }

  const handleOpenConfig = (method: PaymentMethod) => {
    setConfigTarget(method)
    setConfigOpen(true)
  }

  // ── Loading skeleton ────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 rounded-xl" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  if (methods.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <AlertTriangle className="size-10 text-muted-foreground mb-3" />
          <p className="text-muted-foreground">
            No payment methods found. Default methods will be seeded on first
            checkout request.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={fetchMethods}
          >
            <RefreshCw className="size-4 mr-1" />
            Refresh
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* ── Header card with active count + warning ──────────────────── */}
      <Card className={activeCount === 0 ? 'border-red-300 bg-red-50/40' : ''}>
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <CreditCard className="size-5 text-emerald-600" />
                Payment Methods
              </CardTitle>
              <CardDescription>
                Toggle which payment options are shown at checkout and edit
                per-method configuration. Super admin only.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                className={
                  activeCount === 0
                    ? 'bg-red-100 text-red-700 border-red-200'
                    : activeCount === 1
                      ? 'bg-yellow-100 text-yellow-700 border-yellow-200'
                      : 'bg-emerald-100 text-emerald-700 border-emerald-200'
                }
              >
                {activeCount} active
              </Badge>
              <Button
                variant="outline"
                size="sm"
                onClick={fetchMethods}
                disabled={loading}
              >
                <RefreshCw
                  className={`size-4 ${loading ? 'animate-spin' : ''}`}
                />
                <span className="ml-1 hidden sm:inline">Refresh</span>
              </Button>
            </div>
          </div>
        </CardHeader>
        {activeCount === 0 && (
          <CardContent className="pt-0">
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <AlertTriangle className="size-4 mt-0.5 shrink-0" />
              <div>
                <span className="font-semibold">No active payment methods.</span>{' '}
                Users will not be able to complete checkout. Enable at least one
                method below.
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* ── Method cards ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {methods.map((m) => {
          const Icon = getMethodIcon(m.method, m.icon)
          const isLastActive = m.active && activeCount <= 1
          return (
            <Card
              key={m.method}
              className={
                m.active
                  ? 'border-emerald-200'
                  : 'opacity-90'
              }
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={`size-10 rounded-lg flex items-center justify-center ${
                        m.active
                          ? 'bg-emerald-50 text-emerald-600'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      <Icon className="size-5" />
                    </div>
                    <div>
                      <CardTitle className="text-base leading-tight">
                        {m.displayName}
                      </CardTitle>
                      <CardDescription className="text-xs">
                        <code className="text-xs">{m.method}</code> · order{' '}
                        {m.sortOrder}
                      </CardDescription>
                    </div>
                  </div>
                  <Switch
                    checked={m.active}
                    disabled={toggling === m.method}
                    onCheckedChange={(checked) => handleToggle(m, checked)}
                    aria-label={`Toggle ${m.displayName}`}
                  />
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground line-clamp-3 min-h-[36px]">
                  {METHOD_DESCRIPTIONS[m.method] ||
                    'Configure this payment method below.'}
                </p>

                <div className="flex items-center justify-between pt-1 border-t">
                  <Badge
                    variant="outline"
                    className={
                      m.active
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-gray-50 text-gray-600 border-gray-200'
                    }
                  >
                    {m.active ? 'Active' : 'Disabled'}
                  </Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleOpenConfig(m)}
                  >
                    <Settings className="size-4 mr-1" />
                    Configure
                  </Button>
                </div>

                {isLastActive && (
                  <div className="flex items-start gap-2 rounded-md border border-yellow-200 bg-yellow-50 p-2 text-xs text-yellow-700">
                    <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
                    <span>
                      Last active method — disabling will block all checkouts.
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* ── Config dialog ──────────────────────────────────────────── */}
      <ConfigDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        method={configTarget}
        onSaved={fetchMethods}
      />
    </div>
  )
}
