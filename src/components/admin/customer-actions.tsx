'use client'

/**
 * Per-customer admin tools, opened from the ⋯ menu on each row of Admin → Users:
 * billing overview, credit adjustments, usage against plan limits, support
 * access ("log in as customer") and sign-out-everywhere. Each talks to an
 * existing admin API; nothing here is computed client-side.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  MoreHorizontal,
  Receipt,
  Wallet,
  Gauge,
  LifeBuoy,
  LogOut,
  Loader2,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

export interface CustomerRef {
  id: string
  name: string
  email: string
  role: string
}

type Panel = 'billing' | 'credit' | 'usage' | null

const money = (n: number | null | undefined, currency = 'USD') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(Number(n) || 0)
const day = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString() : '—')

function Loading() {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground justify-center">
      <Loader2 className="size-4 animate-spin" /> Loading…
    </div>
  )
}

function ErrorLine({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
      <span className="flex items-center gap-2">
        <AlertTriangle className="size-4" /> {message}
      </span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

// ── Billing ──────────────────────────────────────────────────────────────
interface BillingData {
  summary: {
    lifetimeValue: number
    outstanding: number
    creditBalance: number
    invoiceCount: number
    paidCount: number
    unpaidCount: number
    activeSubscriptions: number
  }
  subscriptions: Array<{ id: string; status: string; planName: string | null; price: number | null; billingCycle: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean }>
  invoices: Array<{ id: string; number: string; status: string; total: number; currency: string; dueDate: string | null; paidAt: string | null; createdAt: string }>
  payments: Array<{ id: string; amount: number; currency: string; status: string; method: string; createdAt: string }>
}

function BillingDialog({ customer, onClose }: { customer: CustomerRef; onClose: () => void }) {
  const [data, setData] = useState<BillingData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    setError(null)
    apiFetch<BillingData>(`/admin/customers/${customer.id}/billing`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load billing'))
  }, [customer.id])
  useEffect(load, [load])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Billing — {customer.name}</DialogTitle>
          <DialogDescription>{customer.email}</DialogDescription>
        </DialogHeader>
        {error ? (
          <ErrorLine message={error} onRetry={load} />
        ) : !data ? (
          <Loading />
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                ['Lifetime value', money(data.summary.lifetimeValue)],
                ['Outstanding', money(data.summary.outstanding)],
                ['Credit balance', money(data.summary.creditBalance)],
                ['Invoices', `${data.summary.paidCount} paid · ${data.summary.unpaidCount} unpaid`],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-1 font-semibold">{value}</p>
                </div>
              ))}
            </div>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Subscriptions</h3>
              {data.subscriptions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No subscriptions.</p>
              ) : (
                <ul className="divide-y rounded-md border text-sm">
                  {data.subscriptions.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                      <span className="font-medium">{s.planName || 'Plan'}</span>
                      <span className="text-muted-foreground">
                        {s.price !== null ? `${money(s.price)} / ${s.billingCycle || 'month'}` : ''} · renews {day(s.currentPeriodEnd)}
                        {s.cancelAtPeriodEnd ? ' · cancels at period end' : ''}
                      </span>
                      <Badge variant="outline">{s.status}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Invoices</h3>
              {data.invoices.length === 0 ? (
                <p className="text-sm text-muted-foreground">No invoices.</p>
              ) : (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Number</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Total</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">PDF</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.invoices.slice(0, 50).map((i) => (
                        <TableRow key={i.id}>
                          <TableCell className="font-mono text-xs">{i.number}</TableCell>
                          <TableCell>{day(i.createdAt)}</TableCell>
                          <TableCell>{money(i.total, i.currency)}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{i.status}</Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button size="sm" variant="ghost" onClick={() => window.open(`/api/invoices/${i.id}/pdf`, '_blank', 'noopener')}>
                              Open
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Payments</h3>
              {data.payments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No payments.</p>
              ) : (
                <ul className="divide-y rounded-md border text-sm">
                  {data.payments.slice(0, 50).map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                      <span>{money(p.amount, p.currency)}</span>
                      <span className="text-muted-foreground">
                        {p.method} · {day(p.createdAt)}
                      </span>
                      <Badge variant="outline">{p.status}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ── Credit ───────────────────────────────────────────────────────────────
interface CreditData {
  user: { creditBalance: number }
  history: Array<{ id: string; amount: number; balanceAfter: number; description: string | null; createdAt: string }>
}

function CreditDialog({ customer, onClose }: { customer: CustomerRef; onClose: () => void }) {
  const [data, setData] = useState<CreditData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    setError(null)
    apiFetch<CreditData>(`/admin/credit?userId=${encodeURIComponent(customer.id)}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load credit'))
  }, [customer.id])
  useEffect(load, [load])

  const value = Number(amount)
  const valid = amount.trim() !== '' && Number.isFinite(value) && value !== 0 && Math.abs(value) <= 100000

  const submit = async () => {
    if (!valid) return
    setSaving(true)
    try {
      const res = await apiFetch<{ message?: string }>('/admin/credit', {
        method: 'POST',
        body: JSON.stringify({ userId: customer.id, amount: value, description: note.trim() || undefined }),
      })
      toast.success(res.message || (value > 0 ? 'Credit added' : 'Credit removed'))
      setAmount('')
      setNote('')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not adjust credit')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Account credit — {customer.name}</DialogTitle>
          <DialogDescription>
            Credit is applied to the customer&apos;s next invoices automatically. Use a negative amount to remove credit;
            the balance can never go below zero.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <ErrorLine message={error} onRetry={load} />
        ) : !data ? (
          <Loading />
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Current balance</p>
              <p className="mt-1 text-xl font-semibold">{money(data.user.creditBalance)}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
              <div className="space-y-1.5">
                <Label htmlFor="credit-amount">Amount (USD)</Label>
                <Input
                  id="credit-amount"
                  inputMode="decimal"
                  placeholder="e.g. 10 or -5"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="credit-note">Reason (shown in the customer&apos;s history)</Label>
                <Input id="credit-note" placeholder="Goodwill for the outage on 12 Nov" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
              </div>
            </div>
            {data.history.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-semibold">History</h3>
                <ul className="max-h-48 divide-y overflow-y-auto rounded-md border text-sm">
                  {data.history.map((h) => (
                    <li key={h.id} className="flex items-center justify-between gap-2 p-2.5">
                      <span className="truncate">{h.description || '—'}</span>
                      <span className={h.amount >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                        {h.amount >= 0 ? '+' : ''}
                        {money(h.amount)}
                      </span>
                      <span className="text-xs text-muted-foreground">{day(h.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={submit} disabled={!valid || saving || !data}>
            {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
            {value < 0 ? 'Remove credit' : 'Add credit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Usage ────────────────────────────────────────────────────────────────
interface LimitCheck {
  key?: string
  label?: string
  used?: number
  limit?: number | null
  over?: boolean
}
interface UsageData {
  usage: Record<string, unknown> | null
  limits: { overCount?: number; checks?: LimitCheck[] } | null
  history: Array<{ id: string; capturedAt: string }>
}

function UsageDialog({ customer, onClose }: { customer: CustomerRef; onClose: () => void }) {
  const [data, setData] = useState<UsageData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'snapshot' | 'reset' | null>(null)

  const load = useCallback(() => {
    setError(null)
    apiFetch<UsageData>(`/admin/usage?userId=${encodeURIComponent(customer.id)}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load usage'))
  }, [customer.id])
  useEffect(load, [load])

  const act = async (action: 'snapshot' | 'reset') => {
    if (action === 'reset' && !window.confirm(`Reset usage history for ${customer.email}? A fresh baseline is taken.`)) return
    setBusy(action)
    try {
      const res = await apiFetch<{ message?: string }>('/admin/usage', {
        method: 'POST',
        body: JSON.stringify({ action, userId: customer.id }),
      })
      toast.success(res.message || 'Done')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  const checks = data?.limits?.checks ?? []

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Usage — {customer.name}</DialogTitle>
          <DialogDescription>Measured consumption against the customer&apos;s plan limits.</DialogDescription>
        </DialogHeader>
        {error ? (
          <ErrorLine message={error} onRetry={load} />
        ) : !data ? (
          <Loading />
        ) : checks.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            No plan limits to compare against (no active subscription, or no usage captured yet).
          </p>
        ) : (
          <ul className="divide-y rounded-md border text-sm">
            {checks.map((c, i) => (
              <li key={c.key || c.label || i} className="flex items-center justify-between gap-2 p-3">
                <span>{c.label || c.key}</span>
                <span className={c.over ? 'font-medium text-destructive' : 'text-muted-foreground'}>
                  {c.used ?? 0} / {c.limit === null || c.limit === undefined ? '∞' : c.limit}
                  {c.over ? ' — over limit' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        {data && <p className="text-xs text-muted-foreground">{data.history.length} snapshot(s) recorded.</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => act('reset')} disabled={!!busy || !data}>
            {busy === 'reset' && <Loader2 className="mr-2 size-4 animate-spin" />}
            Reset history
          </Button>
          <Button onClick={() => act('snapshot')} disabled={!!busy || !data}>
            {busy === 'snapshot' ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
            Measure now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Menu ─────────────────────────────────────────────────────────────────
export function CustomerActionsMenu({
  customer,
  isSelf,
  isSuperAdmin,
  onSignOutEverywhere,
}: {
  customer: CustomerRef
  isSelf: boolean
  isSuperAdmin: boolean
  onSignOutEverywhere: (userId: string, email: string) => void
}) {
  const [panel, setPanel] = useState<Panel>(null)
  const [starting, setStarting] = useState(false)
  const targetIsAdmin = customer.role === 'admin' || customer.role === 'super_admin'
  const canSupport = isSuperAdmin && !isSelf && !targetIsAdmin

  const startSupport = async () => {
    if (
      !window.confirm(
        `Log in as ${customer.email}?\n\nYou will see the panel exactly as they do for up to 1 hour. ` +
          'Everything you do is logged against your admin account. Use "Return to admin" to come back.'
      )
    )
      return
    setStarting(true)
    try {
      await apiFetch('/admin/impersonate', {
        method: 'POST',
        body: JSON.stringify({ userId: customer.id, switchSession: true }),
      })
      window.location.assign('/')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start support access')
      setStarting(false)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Actions for ${customer.email}`} disabled={starting}>
            {starting ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontal className="size-4" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="truncate">{customer.email}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setPanel('billing')}>
            <Receipt className="size-4" /> Billing overview
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setPanel('credit')}>
            <Wallet className="size-4" /> Adjust credit
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setPanel('usage')}>
            <Gauge className="size-4" /> Usage &amp; limits
          </DropdownMenuItem>
          {canSupport && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={startSupport}>
                <LifeBuoy className="size-4" /> Log in as customer
              </DropdownMenuItem>
            </>
          )}
          {!isSelf && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onSignOutEverywhere(customer.id, customer.email)}>
                <LogOut className="size-4" /> Sign out all devices
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {panel === 'billing' && <BillingDialog customer={customer} onClose={() => setPanel(null)} />}
      {panel === 'credit' && <CreditDialog customer={customer} onClose={() => setPanel(null)} />}
      {panel === 'usage' && <UsageDialog customer={customer} onClose={() => setPanel(null)} />}
    </>
  )
}
