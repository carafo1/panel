'use client'

/**
 * Admin billing panel — Payments + Subscriptions.
 *
 * With offline/bank-transfer payments the admin *is* the payment gateway:
 * they confirm that money arrived (which provisions the service) and manage
 * subscription periods for people who pay late.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { toast } from 'sonner'
import { Loader2, RefreshCw, Check, X, CalendarPlus } from 'lucide-react'

// ── API helper ─────────────────────────────────────────────────────────
async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token =
    typeof window !== 'undefined' ? localStorage.getItem('token') : null
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return res.json()
}

interface AdminPayment {
  id: string
  amount: number
  currency: string
  status: string
  method: string
  createdAt: string
  reference: string | null
  planName: string | null
  purchaseType: string | null
  domainName: string | null
  adminConfirmed: boolean
  confirmedByEmail: string | null
  confirmedAt: string | null
  confirmationNote: string | null
  user: { id: string; name: string | null; email: string } | null
}

interface AdminSubscription {
  id: string
  status: string
  currentPeriodEnd: string
  cancelAtPeriodEnd: boolean
  managedByStripe: boolean
  daysLeft: number
  expired: boolean
  user: { id: string; name: string | null; email: string } | null
  plan: { id: string; name: string; price: number } | null
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'completed' || status === 'active') return 'default'
  if (status === 'pending') return 'secondary'
  if (status === 'failed' || status === 'suspended') return 'destructive'
  return 'outline'
}

function money(amount: number, currency: string) {
  return `${currency?.toUpperCase() || 'USD'} ${Number(amount || 0).toFixed(2)}`
}

// ── Confirm / reject dialog ────────────────────────────────────────────
function ConfirmDialog({
  payment,
  open,
  onOpenChange,
  onDone,
}: {
  payment: AdminPayment | null
  open: boolean
  onOpenChange: (v: boolean) => void
  onDone: () => void
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'confirm' | 'reject' | null>(null)

  useEffect(() => {
    if (open) setNote('')
  }, [open, payment])

  if (!payment) return null

  const run = async (action: 'confirm' | 'reject') => {
    setBusy(action)
    try {
      const res = await apiFetch<{ message?: string }>(
        `/admin/payments/${payment.id}/confirm`,
        { method: 'POST', body: JSON.stringify({ action, note }) }
      )
      toast.success(res.message || `Payment ${action}ed`)
      onDone()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to ${action}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Confirm payment</DialogTitle>
          <DialogDescription>
            Only confirm once the money has actually arrived. Confirming
            activates the subscription and provisions the service.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 rounded-md border p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Customer</span>
            <span className="text-right">
              {payment.user?.email || '—'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Amount</span>
            <span className="font-medium">
              {money(payment.amount, payment.currency)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Reference</span>
            <span className="font-mono text-xs">{payment.reference || '—'}</span>
          </div>
          {payment.planName && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Plan</span>
              <span>{payment.planName}</span>
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="confirm-note">Note (optional)</Label>
          <Input
            id="confirm-note"
            placeholder="e.g. Salaam Bank, receipt #4821"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Recorded on the payment for your records. If rejecting, this is
            sent to the customer as the reason.
          </p>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            className="text-red-600 hover:text-red-700"
            disabled={busy !== null}
            onClick={() => run('reject')}
          >
            {busy === 'reject' ? (
              <Loader2 className="size-4 animate-spin mr-1.5" />
            ) : (
              <X className="size-4 mr-1.5" />
            )}
            Reject
          </Button>
          <Button disabled={busy !== null} onClick={() => run('confirm')}>
            {busy === 'confirm' ? (
              <Loader2 className="size-4 animate-spin mr-1.5" />
            ) : (
              <Check className="size-4 mr-1.5" />
            )}
            Confirm payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Extend subscription dialog ─────────────────────────────────────────
function ExtendDialog({
  sub,
  open,
  onOpenChange,
  onDone,
}: {
  sub: AdminSubscription | null
  open: boolean
  onOpenChange: (v: boolean) => void
  onDone: () => void
}) {
  const [days, setDays] = useState('30')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) setDays('30')
  }, [open, sub])

  if (!sub) return null

  const run = async () => {
    setBusy(true)
    try {
      const res = await apiFetch<{ message?: string }>('/admin/subscriptions', {
        method: 'PATCH',
        body: JSON.stringify({
          id: sub.id,
          action: 'extend',
          days: Number(days),
        }),
      })
      toast.success(res.message || 'Subscription extended')
      onDone()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to extend')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Extend subscription</DialogTitle>
          <DialogDescription>
            {sub.user?.email} — {sub.plan?.name || 'plan'}. Use this when
            someone has paid offline. Extending also sets it back to active.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="extend-days">Days to add</Label>
          <Input
            id="extend-days"
            type="number"
            min={1}
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Counts from today if the period has already expired, otherwise
            from the current end date.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={run} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin mr-1.5" />}
            Extend
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Main panel ─────────────────────────────────────────────────────────
export function BillingAdminPanel() {
  const [payments, setPayments] = useState<AdminPayment[]>([])
  const [subs, setSubs] = useState<AdminSubscription[]>([])
  const [loading, setLoading] = useState(false)
  const [payFilter, setPayFilter] = useState('pending')
  const [target, setTarget] = useState<AdminPayment | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [extendTarget, setExtendTarget] = useState<AdminSubscription | null>(null)
  const [extendOpen, setExtendOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [p, s] = await Promise.all([
        apiFetch<{ payments: AdminPayment[] }>(
          `/admin/payments?status=${encodeURIComponent(payFilter)}`
        ),
        apiFetch<{ subscriptions: AdminSubscription[] }>(
          '/admin/subscriptions?status=all'
        ),
      ])
      setPayments(p.payments || [])
      setSubs(s.subscriptions || [])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load billing data')
    } finally {
      setLoading(false)
    }
  }, [payFilter])

  useEffect(() => {
    load()
  }, [load])

  const pendingCount = payments.filter((p) => p.status === 'pending').length

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold">Billing</h3>
          <p className="text-sm text-muted-foreground">
            Confirm offline payments and manage subscription periods.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
        </Button>
      </div>

      <Tabs defaultValue="payments" className="space-y-4">
        <TabsList>
          <TabsTrigger value="payments">
            Payments
            {pendingCount > 0 && (
              <Badge variant="secondary" className="ml-1.5">
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
        </TabsList>

        {/* ── Payments ─────────────────────────────────────────────── */}
        <TabsContent value="payments" className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {['pending', 'completed', 'failed', 'all'].map((f) => (
              <Button
                key={f}
                size="sm"
                variant={payFilter === f ? 'default' : 'outline'}
                onClick={() => setPayFilter(f)}
                className="capitalize"
              >
                {f}
              </Button>
            ))}
          </div>

          {payments.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {loading ? 'Loading…' : `No ${payFilter} payments.`}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    <th className="p-2 font-medium">Customer</th>
                    <th className="p-2 font-medium">Amount</th>
                    <th className="p-2 font-medium">Reference</th>
                    <th className="p-2 font-medium">Method</th>
                    <th className="p-2 font-medium">Status</th>
                    <th className="p-2 font-medium">Date</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id} className="border-t align-middle">
                      <td className="p-2">
                        <div className="font-medium">{p.user?.name || '—'}</div>
                        <div className="text-xs text-muted-foreground">
                          {p.user?.email}
                        </div>
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        {money(p.amount, p.currency)}
                      </td>
                      <td className="p-2 font-mono text-xs break-all">
                        {p.reference || '—'}
                      </td>
                      <td className="p-2 capitalize">{p.method}</td>
                      <td className="p-2">
                        <Badge variant={statusVariant(p.status)}>{p.status}</Badge>
                        {p.confirmedByEmail && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            by {p.confirmedByEmail}
                          </div>
                        )}
                      </td>
                      <td className="p-2 whitespace-nowrap text-xs text-muted-foreground">
                        {new Date(p.createdAt).toLocaleDateString()}
                      </td>
                      <td className="p-2 text-right">
                        {p.status === 'pending' && (
                          <Button
                            size="sm"
                            onClick={() => {
                              setTarget(p)
                              setConfirmOpen(true)
                            }}
                          >
                            Review
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        {/* ── Subscriptions ────────────────────────────────────────── */}
        <TabsContent value="subscriptions">
          {subs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {loading ? 'Loading…' : 'No subscriptions yet.'}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    <th className="p-2 font-medium">Customer</th>
                    <th className="p-2 font-medium">Plan</th>
                    <th className="p-2 font-medium">Status</th>
                    <th className="p-2 font-medium">Renews / expires</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {subs.map((s) => (
                    <tr key={s.id} className="border-t align-middle">
                      <td className="p-2">
                        <div className="font-medium">{s.user?.name || '—'}</div>
                        <div className="text-xs text-muted-foreground">
                          {s.user?.email}
                        </div>
                      </td>
                      <td className="p-2">{s.plan?.name || '—'}</td>
                      <td className="p-2">
                        <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                        {s.managedByStripe && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            via Stripe
                          </div>
                        )}
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        <div>
                          {new Date(s.currentPeriodEnd).toLocaleDateString()}
                        </div>
                        <div
                          className={`text-xs ${
                            s.expired
                              ? 'text-red-600'
                              : s.daysLeft <= 5
                                ? 'text-amber-600'
                                : 'text-muted-foreground'
                          }`}
                        >
                          {s.expired
                            ? `expired ${Math.abs(s.daysLeft)}d ago`
                            : `${s.daysLeft}d left`}
                        </div>
                      </td>
                      <td className="p-2 text-right">
                        {!s.managedByStripe && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setExtendTarget(s)
                              setExtendOpen(true)
                            }}
                          >
                            <CalendarPlus className="size-4 mr-1.5" />
                            Extend
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        payment={target}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onDone={load}
      />
      <ExtendDialog
        sub={extendTarget}
        open={extendOpen}
        onOpenChange={setExtendOpen}
        onDone={load}
      />
    </div>
  )
}
