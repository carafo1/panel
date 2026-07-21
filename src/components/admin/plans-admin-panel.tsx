'use client'

/**
 * Admin plan management.
 *
 * Before this, plans could only be changed by editing seed.ts and redeploying.
 * This gives the super admin real control: create, edit, clone, enable/disable,
 * hide, archive and delete packages — including billing cycle, trial, and the
 * per-resource limits the rest of the platform enforces.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import { apiFetch as baseApiFetch } from '@/store/auth-store'
import { Loader2, RefreshCw, Plus, Copy, Trash2, Pencil } from 'lucide-react'

// Delegate to the shared client — see billing-admin-panel for why.
async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return (await baseApiFetch(path, init)) as T
}

interface Plan {
  id: string
  name: string
  slug: string
  description: string
  price: number
  currency: string
  billingCycle: string
  trialDays: number
  setupFee: number
  ram: string
  cpu: string
  storage: string
  bandwidth: string
  projects: number
  active: boolean
  hidden: boolean
  archived: boolean
  popular: boolean
  promotional: boolean
  priority: number
  diskMB: number | null
  bandwidthMB: number | null
  cpuCores: number | null
  ramMB: number | null
  maxDatabases: number | null
  maxEmailAccounts: number | null
  maxFtpAccounts: number | null
  maxCronJobs: number | null
  maxBackups: number | null
  maxDomains: number | null
  maxSubdomains: number | null
  allowedApps: string[] | null
  _count?: { subscriptions: number }
}

const CYCLES = ['monthly', 'quarterly', 'annual', 'biennial', 'lifetime']
const APPS = [
  'wordpress',
  'laravel',
  'nodejs',
  'nextjs',
  'python',
  'php',
  'docker',
  'ghost',
  'joomla',
  'drupal',
]

// Numeric limits rendered in the editor. Blank = unlimited.
const LIMIT_FIELDS: Array<{ key: keyof Plan; label: string }> = [
  { key: 'diskMB', label: 'Disk (MB)' },
  { key: 'bandwidthMB', label: 'Bandwidth (MB)' },
  { key: 'cpuCores', label: 'CPU cores' },
  { key: 'ramMB', label: 'RAM (MB)' },
  { key: 'maxDatabases', label: 'Databases' },
  { key: 'maxEmailAccounts', label: 'Email accounts' },
  { key: 'maxFtpAccounts', label: 'FTP accounts' },
  { key: 'maxCronJobs', label: 'Cron jobs' },
  { key: 'maxBackups', label: 'Backups' },
  { key: 'maxDomains', label: 'Domains' },
  { key: 'maxSubdomains', label: 'Subdomains' },
]

function money(p: Plan) {
  return `${p.currency || 'USD'} ${Number(p.price || 0).toFixed(2)}`
}

// ── Editor dialog ──────────────────────────────────────────────────────
function PlanDialog({
  plan,
  open,
  onOpenChange,
  onSaved,
}: {
  plan: Plan | null // null = create
  open: boolean
  onOpenChange: (v: boolean) => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<Record<string, unknown>>({})
  const [apps, setApps] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    if (plan) {
      setForm({ ...plan })
      setApps(plan.allowedApps ?? [])
    } else {
      setForm({
        name: '',
        description: '',
        price: 0,
        currency: 'USD',
        billingCycle: 'monthly',
        trialDays: 0,
        setupFee: 0,
        projects: 1,
        active: true,
        hidden: false,
      })
      setApps([])
    }
  }, [open, plan])

  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }))

  const save = async () => {
    if (!String(form.name || '').trim()) {
      toast.error('Name is required')
      return
    }
    setBusy(true)
    try {
      const payload = {
        ...form,
        allowedApps: apps.length ? apps : null,
      }
      if (plan) {
        await apiFetch(`/admin/plans/${plan.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        })
        toast.success('Plan updated')
      } else {
        await apiFetch('/admin/plans', {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        toast.success('Plan created')
      }
      onSaved()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{plan ? `Edit ${plan.name}` : 'New plan'}</DialogTitle>
          <DialogDescription>
            Leave a limit blank for unlimited. Hidden plans stay sellable by
            direct link but aren&apos;t listed publicly.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="p-name">Name</Label>
              <Input
                id="p-name"
                value={String(form.name ?? '')}
                onChange={(e) => set('name', e.target.value)}
                placeholder="Business"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-price">Price (per cycle)</Label>
              <Input
                id="p-price"
                type="number"
                step="0.01"
                min={0}
                value={String(form.price ?? 0)}
                onChange={(e) => set('price', e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="p-desc">Description</Label>
            <Textarea
              id="p-desc"
              className="min-h-[60px]"
              value={String(form.description ?? '')}
              onChange={(e) => set('description', e.target.value)}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="p-cycle">Billing cycle</Label>
              <select
                id="p-cycle"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={String(form.billingCycle ?? 'monthly')}
                onChange={(e) => set('billingCycle', e.target.value)}
              >
                {CYCLES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-currency">Currency</Label>
              <Input
                id="p-currency"
                value={String(form.currency ?? 'USD')}
                onChange={(e) => set('currency', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-trial">Trial (days)</Label>
              <Input
                id="p-trial"
                type="number"
                min={0}
                value={String(form.trialDays ?? 0)}
                onChange={(e) => set('trialDays', e.target.value)}
              />
            </div>
          </div>

          {/* Display strings shown on the pricing cards */}
          <div className="grid gap-3 sm:grid-cols-4">
            {(['ram', 'cpu', 'storage', 'bandwidth'] as const).map((k) => (
              <div className="space-y-1.5" key={k}>
                <Label htmlFor={`p-${k}`} className="capitalize">
                  {k}
                </Label>
                <Input
                  id={`p-${k}`}
                  value={String(form[k] ?? '')}
                  onChange={(e) => set(k, e.target.value)}
                  placeholder={k === 'ram' ? '2GB' : ''}
                />
              </div>
            ))}
          </div>

          {/* Enforced numeric limits */}
          <div>
            <p className="text-sm font-medium mb-2">Resource limits</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {LIMIT_FIELDS.map((f) => (
                <div className="space-y-1.5" key={String(f.key)}>
                  <Label htmlFor={`p-${String(f.key)}`} className="text-xs">
                    {f.label}
                  </Label>
                  <Input
                    id={`p-${String(f.key)}`}
                    type="number"
                    min={0}
                    placeholder="unlimited"
                    value={
                      form[f.key as string] === null ||
                      form[f.key as string] === undefined
                        ? ''
                        : String(form[f.key as string])
                    }
                    onChange={(e) =>
                      set(String(f.key), e.target.value === '' ? null : e.target.value)
                    }
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Allowed applications */}
          <div>
            <p className="text-sm font-medium mb-2">
              Applications{' '}
              <span className="text-xs font-normal text-muted-foreground">
                (none selected = allow all)
              </span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              {APPS.map((a) => {
                const on = apps.includes(a)
                return (
                  <Button
                    key={a}
                    type="button"
                    size="sm"
                    variant={on ? 'default' : 'outline'}
                    className="capitalize"
                    onClick={() =>
                      setApps((prev) =>
                        on ? prev.filter((x) => x !== a) : [...prev, a]
                      )
                    }
                  >
                    {a}
                  </Button>
                )
              })}
            </div>
          </div>

          {/* Flags */}
          <div className="flex flex-wrap gap-4">
            {(
              [
                ['active', 'Enabled'],
                ['hidden', 'Hidden'],
                ['popular', 'Popular'],
                ['promotional', 'Promotional'],
              ] as const
            ).map(([k, label]) => (
              <label className="flex items-center gap-2 text-sm" key={k}>
                <input
                  type="checkbox"
                  checked={form[k] === true}
                  onChange={(e) => set(k, e.target.checked)}
                />
                {label}
              </label>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin mr-1.5" />}
            {plan ? 'Save changes' : 'Create plan'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Main panel ─────────────────────────────────────────────────────────
export function PlansAdminPanel() {
  const [plans, setPlans] = useState<Plan[]>([])
  const [loading, setLoading] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState<Plan | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch<{ plans: Plan[] }>(
        `/admin/plans${showArchived ? '?includeArchived=1' : ''}`
      )
      setPlans(data.plans || [])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load plans')
    } finally {
      setLoading(false)
    }
  }, [showArchived])

  useEffect(() => {
    load()
  }, [load])

  const clone = async (p: Plan) => {
    try {
      await apiFetch('/admin/plans', {
        method: 'POST',
        body: JSON.stringify({ cloneFromId: p.id }),
      })
      toast.success(`Cloned ${p.name} (created hidden)`)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Clone failed')
    }
  }

  const toggle = async (p: Plan, field: 'active' | 'hidden') => {
    try {
      await apiFetch(`/admin/plans/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ [field]: !p[field] }),
      })
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed')
    }
  }

  const remove = async (p: Plan) => {
    const inUse = (p._count?.subscriptions ?? 0) > 0
    const msg = inUse
      ? `${p.name} has ${p._count?.subscriptions} subscription(s). It will be ARCHIVED (existing services keep running) rather than deleted. Continue?`
      : `Delete ${p.name} permanently?`
    if (!confirm(msg)) return
    try {
      const res = await apiFetch<{ message?: string }>(`/admin/plans/${p.id}`, {
        method: 'DELETE',
      })
      toast.success(res.message || 'Done')
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold">Plans</h3>
          <p className="text-sm text-muted-foreground">
            Define the packages customers can buy — pricing, billing cycle, and
            resource limits.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            <Plus className="size-4 mr-1.5" />
            New plan
          </Button>
        </div>
      </div>

      {plans.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {loading ? 'Loading…' : 'No plans yet — create your first package.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-left">
                <th className="p-2 font-medium">Plan</th>
                <th className="p-2 font-medium">Price</th>
                <th className="p-2 font-medium">Cycle</th>
                <th className="p-2 font-medium">Subs</th>
                <th className="p-2 font-medium">Status</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id} className="border-t align-middle">
                  <td className="p-2">
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-muted-foreground line-clamp-1">
                      {p.description}
                    </div>
                  </td>
                  <td className="p-2 whitespace-nowrap">
                    {money(p)}
                    {p.trialDays > 0 && (
                      <div className="text-xs text-muted-foreground">
                        {p.trialDays}d trial
                      </div>
                    )}
                  </td>
                  <td className="p-2 capitalize whitespace-nowrap">
                    {p.billingCycle}
                  </td>
                  <td className="p-2">{p._count?.subscriptions ?? 0}</td>
                  <td className="p-2">
                    <div className="flex flex-wrap gap-1">
                      {p.archived ? (
                        <Badge variant="outline">archived</Badge>
                      ) : p.active ? (
                        <Badge>enabled</Badge>
                      ) : (
                        <Badge variant="destructive">disabled</Badge>
                      )}
                      {p.hidden && !p.archived && (
                        <Badge variant="secondary">hidden</Badge>
                      )}
                      {p.popular && <Badge variant="secondary">popular</Badge>}
                    </div>
                  </td>
                  <td className="p-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Edit"
                        onClick={() => {
                          setEditing(p)
                          setDialogOpen(true)
                        }}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Clone"
                        onClick={() => clone(p)}
                      >
                        <Copy className="size-4" />
                      </Button>
                      {!p.archived && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => toggle(p, 'active')}
                        >
                          {p.active ? 'Disable' : 'Enable'}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-600 hover:text-red-700"
                        title="Delete / archive"
                        onClick={() => remove(p)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PlanDialog
        plan={editing}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={load}
      />
    </div>
  )
}
