'use client'

/**
 * Admin — Email Hosting.
 *
 * Operator view of every standalone email service: who owns it, what plan it
 * runs on, live usage from Mailcow, and the actions to suspend, restore,
 * change plan/add-ons, or close an account.
 *
 * Usage is one Mailcow round-trip per row, so the list is paginated and the
 * usage column can be turned off when scanning a large account base.
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  Mail,
  Search,
  RefreshCw,
  Loader2,
  Pause,
  Play,
  Trash2,
  SlidersHorizontal,
  AlertTriangle,
  HardDrive,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface Usage {
  mailboxes: number
  mailboxLimit: number
  usedBytes: number
  totalStorageBytes: number
  percentStorage: number
}

interface AdminEmailRow {
  id: string
  domain: string
  status: string
  user: { id: string; email: string; name: string | null } | null
  plan: { id: string; name: string; slug: string; price: number } | null
  limits: { mailboxLimit: number; storagePerMailboxGB: number; totalStorageGB: number }
  extraMailboxes: number
  extraStorageGB: number
  usage: Usage | null
  provisioned: boolean
  dkimGenerated: boolean
  lastError: string | null
  suspendedAt: string | null
  createdAt: string
}

interface PlanOption {
  id: string
  name: string
  price: number
  emailMailboxes: number | null
}

/** The httpOnly session cookie authenticates same-origin requests. */
function authHeaders(): HeadersInit {
  return { 'Content-Type': 'application/json' }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: authHeaders(), cache: 'no-store' })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    throw new Error((data as { error?: string })?.error || `Request failed (${res.status})`)
  }
  return data as T
}

function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    active: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
    suspended: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
    pending: 'bg-blue-500/15 text-blue-600 border-blue-500/30',
    cancelled: 'bg-muted text-muted-foreground',
  }
  return (
    <Badge variant="outline" className={map[status] || map.pending}>
      {status}
    </Badge>
  )
}

export default function EmailAdminPanel() {
  const [rows, setRows] = useState<AdminEmailRow[] | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [total, setTotal] = useState(0)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('all')
  const [skip, setSkip] = useState(0)
  const [showUsage, setShowUsage] = useState(true)
  const [loading, setLoading] = useState(false)
  const [plans, setPlans] = useState<PlanOption[]>([])

  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState<AdminEmailRow | null>(null)
  const [mode, setMode] = useState<'limits' | 'terminate' | null>(null)
  const [planId, setPlanId] = useState('')
  const [extraMailboxes, setExtraMailboxes] = useState(0)
  const [extraStorageGB, setExtraStorageGB] = useState(0)
  const [confirm, setConfirm] = useState('')

  const TAKE = 25

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        take: String(TAKE),
        skip: String(skip),
        usage: showUsage ? '1' : '0',
      })
      if (q.trim()) params.set('q', q.trim())
      if (status !== 'all') params.set('status', status)
      const d = await api<{
        services: AdminEmailRow[]
        total: number
        counts: Record<string, number>
      }>(`/api/admin/email?${params}`)
      setRows(d.services || [])
      setTotal(d.total || 0)
      setCounts(d.counts || {})
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load email services')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [q, status, skip, showUsage])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    api<{ plans: PlanOption[] }>('/api/billing/plans?type=email')
      .then((d) => setPlans(d.plans || []))
      .catch(() => setPlans([]))
  }, [])

  const act = async (
    row: AdminEmailRow,
    body: Record<string, unknown>,
    successMsg: string
  ) => {
    setBusy(true)
    try {
      await api(`/api/admin/email/${row.id}`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      toast.success(successMsg)
      setTarget(null)
      setMode(null)
      setConfirm('')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Mail className="h-5 w-5 text-primary" />
            Email Hosting
          </h2>
          <p className="text-sm text-muted-foreground">
            {total} service{total === 1 ? '' : 's'}
            {Object.entries(counts).length > 0 &&
              ' · ' +
                Object.entries(counts)
                  .map(([k, v]) => `${v} ${k}`)
                  .join(', ')}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => {
                setSkip(0)
                setQ(e.target.value)
              }}
              placeholder="domain or customer"
              className="pl-8 w-56"
            />
          </div>
          <Select
            value={status}
            onValueChange={(v) => {
              setSkip(0)
              setStatus(v)
            }}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="suspended">Suspended</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowUsage((v) => !v)}
            title="Usage costs one Mailcow lookup per row"
          >
            {showUsage ? 'Usage on' : 'Usage off'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6 space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              <Mail className="h-8 w-8 mx-auto mb-3 opacity-40" />
              No email services match.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Allowance</TableHead>
                  {showUsage && <TableHead>Usage</TableHead>}
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[1%]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">
                      <div>{r.domain}</div>
                      {r.lastError && (
                        <div className="text-xs text-amber-600 flex items-center gap-1 mt-0.5">
                          <AlertTriangle className="h-3 w-3" />
                          {r.lastError}
                        </div>
                      )}
                      {!r.dkimGenerated && (
                        <div className="text-xs text-muted-foreground mt-0.5">
                          DKIM not generated
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      <div>{r.user?.name || '—'}</div>
                      <div className="text-muted-foreground text-xs">{r.user?.email}</div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.plan?.name || '—'}
                      {r.plan && (
                        <div className="text-muted-foreground text-xs">
                          ${r.plan.price.toFixed(2)}/mo
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <Users className="h-3 w-3 text-muted-foreground" />
                        {r.limits.mailboxLimit}
                        {r.extraMailboxes > 0 && (
                          <span className="text-emerald-600 text-xs">
                            (+{r.extraMailboxes})
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-muted-foreground text-xs">
                        <HardDrive className="h-3 w-3" />
                        {r.limits.totalStorageGB} GB
                        {r.extraStorageGB > 0 && (
                          <span className="text-emerald-600">(+{r.extraStorageGB})</span>
                        )}
                      </div>
                    </TableCell>
                    {showUsage && (
                      <TableCell className="text-sm whitespace-nowrap">
                        {r.usage ? (
                          <>
                            <div>
                              {r.usage.mailboxes}/{r.usage.mailboxLimit} boxes
                            </div>
                            <div className="text-muted-foreground text-xs">
                              {formatBytes(r.usage.usedBytes)} ({r.usage.percentStorage}%)
                            </div>
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    )}
                    <TableCell>{statusBadge(r.status)}</TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          title="Plan & add-ons"
                          onClick={() => {
                            setTarget(r)
                            setMode('limits')
                            setPlanId(r.plan?.id || '')
                            setExtraMailboxes(r.extraMailboxes)
                            setExtraStorageGB(r.extraStorageGB)
                          }}
                        >
                          <SlidersHorizontal className="h-3.5 w-3.5" />
                        </Button>
                        {r.status === 'active' ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            title="Suspend"
                            disabled={busy}
                            onClick={() => void act(r, { action: 'suspend' }, `${r.domain} suspended`)}
                          >
                            <Pause className="h-3.5 w-3.5" />
                          </Button>
                        ) : r.status === 'suspended' ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 text-emerald-600"
                            title="Resume"
                            disabled={busy}
                            onClick={() => void act(r, { action: 'resume' }, `${r.domain} restored`)}
                          >
                            <Play className="h-3.5 w-3.5" />
                          </Button>
                        ) : null}
                        {r.status !== 'cancelled' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                            title="Close account"
                            onClick={() => {
                              setTarget(r)
                              setMode('terminate')
                              setConfirm('')
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {total > TAKE && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {skip + 1}–{Math.min(skip + TAKE, total)} of {total}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={skip === 0 || loading}
              onClick={() => setSkip(Math.max(0, skip - TAKE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={skip + TAKE >= total || loading}
              onClick={() => setSkip(skip + TAKE)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* ── Plan & add-ons ── */}
      <Dialog
        open={mode === 'limits' && target !== null}
        onOpenChange={(o) => !o && (setMode(null), setTarget(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Plan &amp; add-ons — {target?.domain}</DialogTitle>
            <DialogDescription>
              Changes are pushed to the mail server immediately. A downgrade is
              refused if it would leave more mailboxes than the new plan allows.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Plan</Label>
              <Select value={planId} onValueChange={setPlanId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a plan" />
                </SelectTrigger>
                <SelectContent>
                  {plans.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} — ${p.price.toFixed(2)} ({p.emailMailboxes} boxes)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="ea-boxes">Extra mailboxes</Label>
                <Input
                  id="ea-boxes"
                  type="number"
                  min={0}
                  value={extraMailboxes}
                  onChange={(e) => setExtraMailboxes(Number(e.target.value) || 0)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ea-storage">Extra storage (GB)</Label>
                <Input
                  id="ea-storage"
                  type="number"
                  min={0}
                  value={extraStorageGB}
                  onChange={(e) => setExtraStorageGB(Number(e.target.value) || 0)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMode(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              disabled={busy || !target}
              onClick={async () => {
                if (!target) return
                if (planId && planId !== target.plan?.id) {
                  await act(target, { action: 'set-plan', planId }, 'Plan changed')
                }
                await act(
                  target,
                  { action: 'set-addons', extraMailboxes, extraStorageGB },
                  'Allowance updated'
                )
              }}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Terminate ── */}
      <Dialog
        open={mode === 'terminate' && target !== null}
        onOpenChange={(o) => !o && (setMode(null), setTarget(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close email hosting for {target?.domain}?</DialogTitle>
            <DialogDescription>
              This deletes every mailbox on the domain and all stored mail, and
              removes the domain from the mail server. It cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="ea-confirm">Type {target?.domain} to confirm</Label>
            <Input
              id="ea-confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={target?.domain}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMode(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                busy ||
                !target ||
                confirm.trim().toLowerCase() !== (target?.domain || '').toLowerCase()
              }
              onClick={() =>
                target &&
                void act(
                  target,
                  { action: 'terminate', confirm },
                  `${target.domain} closed`
                )
              }
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
