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
import { apiFetch as baseApiFetch } from '@/store/auth-store'
import { Loader2, RefreshCw, Check, X, CalendarPlus } from 'lucide-react'

// ── API helper ─────────────────────────────────────────────────────────
// Delegate to the shared client so auth (token key, base path, error shape)
// lives in exactly one place. A local copy previously read the wrong
// localStorage key and silently sent no Authorization header.
async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return (await baseApiFetch(path, init)) as T
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

interface AdminInvoice {
  id: string
  number: string
  status: string
  rawStatus: string
  total: number
  amountPaid: number
  amountRefunded: number
  balanceDue: number
  invoiceType: string
  currency: string
  createdAt: string
  dueDate: string | null
  paidAt: string | null
  planName: string | null
  domainName: string | null
  type: string
  user: { id: string; name: string | null; email: string } | null
}

interface AdminSubscription {
  id: string
  status: string
  currentPeriodEnd: string
  cancelAtPeriodEnd: boolean
  managedByStripe: boolean
  autoRenew: boolean
  renewalAttempts: number
  lastRenewalError: string | null
  daysLeft: number
  expired: boolean
  user: { id: string; name: string | null; email: string } | null
  plan: { id: string; name: string; price: number } | null
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'completed' || status === 'active' || status === 'paid') return 'default'
  if (status === 'pending' || status === 'unpaid') return 'secondary'
  if (
    status === 'failed' ||
    status === 'suspended' ||
    status === 'overdue'
  )
    return 'destructive'
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
            <span className="text-end">
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
              <Loader2 className="size-4 animate-spin me-1.5" />
            ) : (
              <X className="size-4 me-1.5" />
            )}
            Reject
          </Button>
          <Button disabled={busy !== null} onClick={() => run('confirm')}>
            {busy === 'confirm' ? (
              <Loader2 className="size-4 animate-spin me-1.5" />
            ) : (
              <Check className="size-4 me-1.5" />
            )}
            Confirm payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Invoice actions: record a payment / issue a refund ─────────────────
function InvoiceActionDialog({
  invoice,
  mode,
  open,
  onOpenChange,
  onDone,
}: {
  invoice: AdminInvoice | null
  mode: 'payment' | 'refund'
  open: boolean
  onOpenChange: (v: boolean) => void
  onDone: () => void
}) {
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [destination, setDestination] = useState<'wallet' | 'gateway'>('wallet')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || !invoice) return
    setNote('')
    setDestination('wallet')
    // Default to the whole remaining amount — the common case.
    setAmount(
      mode === 'payment'
        ? invoice.balanceDue.toFixed(2)
        : Math.max(0, invoice.amountPaid - invoice.amountRefunded).toFixed(2)
    )
  }, [open, invoice, mode])

  if (!invoice) return null

  const max =
    mode === 'payment'
      ? invoice.balanceDue
      : Math.max(0, invoice.amountPaid - invoice.amountRefunded)

  const run = async () => {
    const amt = Number(amount)
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error('Enter an amount greater than 0')
      return
    }
    setBusy(true)
    try {
      const res = await apiFetch<{ message?: string }>('/admin/invoices', {
        method: 'PATCH',
        body: JSON.stringify({
          id: invoice.id,
          action: mode === 'payment' ? 'add_payment' : 'refund',
          amount: amt,
          note: note || undefined,
          ...(mode === 'refund' ? { destination } : { gateway: 'manual' }),
        }),
      })
      toast.success(res.message || 'Done')
      onDone()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === 'payment' ? 'Record a payment' : 'Issue a refund'}
          </DialogTitle>
          <DialogDescription>
            {invoice.number} — {invoice.user?.email}. {mode === 'payment'
              ? `Partial payments are allowed; ${invoice.currency} ${max.toFixed(2)} is still due.`
              : `Up to ${invoice.currency} ${max.toFixed(2)} can be refunded.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="inv-amount">Amount</Label>
            <Input
              id="inv-amount"
              type="number"
              step="0.01"
              min={0}
              max={max}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          {mode === 'refund' && (
            <div className="space-y-1.5">
              <Label htmlFor="inv-dest">Refund to</Label>
              <select
                id="inv-dest"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={destination}
                onChange={(e) =>
                  setDestination(e.target.value as 'wallet' | 'gateway')
                }
              >
                <option value="wallet">Account credit (instant)</option>
                <option value="gateway">Original payment method (record only)</option>
              </select>
              {destination === 'gateway' && (
                <p className="text-xs text-amber-600">
                  This only records the refund for your books — you still need
                  to issue it in your payment provider&apos;s dashboard.
                </p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="inv-note">
              {mode === 'payment' ? 'Reference / note' : 'Reason'}
            </Label>
            <Input
              id="inv-note"
              placeholder={
                mode === 'payment' ? 'e.g. Salaam Bank ref #4821' : 'e.g. service not delivered'
              }
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={run}
            disabled={busy}
            className={
              mode === 'refund' ? 'bg-red-600 hover:bg-red-700 text-white' : ''
            }
          >
            {busy && <Loader2 className="size-4 animate-spin me-1.5" />}
            {mode === 'payment' ? 'Record payment' : 'Refund'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Change plan (upgrade / downgrade with proration) ───────────────────
function ChangePlanDialog({
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
  const [plans, setPlans] = useState<
    Array<{ id: string; name: string; price: number; currency: string; billingCycle: string }>
  >([])
  const [planId, setPlanId] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setPlanId('')
    apiFetch<{ plans: typeof plans }>('/admin/plans')
      .then((d) => setPlans(d.plans || []))
      .catch(() => setPlans([]))
  }, [open])

  if (!sub) return null

  const target = plans.find((p) => p.id === planId)
  const current = sub.plan
  // Mirror of the server-side proration so the admin sees the charge first.
  const preview = (() => {
    if (!target || !current) return null
    const end = new Date(sub.currentPeriodEnd).getTime()
    const now = Date.now()
    const daysLeft = Math.max(0, Math.ceil((end - now) / 86400000))
    if (daysLeft > 365 * 50) return null // lifetime
    const totalDays = 30 // display estimate only; server is authoritative
    const ratio = Math.min(1, daysLeft / totalDays)
    const credit = current.price * ratio
    const cost = target.price * ratio
    return { daysLeft, credit, cost, net: cost - credit }
  })()

  const run = async () => {
    if (!planId) {
      toast.error('Pick a plan')
      return
    }
    setBusy(true)
    try {
      const res = await apiFetch<{
        invoiceNumber?: string
        creditNote?: string
        proration?: { netCharge: number }
      }>('/admin/subscriptions', {
        method: 'PATCH',
        body: JSON.stringify({ id: sub.id, action: 'change_plan', planId }),
      })
      toast.success(
        res.invoiceNumber
          ? `Plan changed — invoice ${res.invoiceNumber} raised`
          : res.creditNote
            ? 'Plan changed — customer is in credit (see note)'
            : 'Plan changed'
      )
      onDone()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Change failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change plan</DialogTitle>
          <DialogDescription>
            {sub.user?.email} — currently {current?.name || '—'}. The renewal
            date doesn&apos;t move; only the price is prorated.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="cp-plan">New plan</Label>
          <select
            id="cp-plan"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={planId}
            onChange={(e) => setPlanId(e.target.value)}
          >
            <option value="">Select…</option>
            {plans
              .filter((p) => p.id !== current?.id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.currency} {p.price.toFixed(2)} / {p.billingCycle}
                </option>
              ))}
          </select>
        </div>

        {preview && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                Unused credit ({preview.daysLeft}d left)
              </span>
              <span>-{preview.credit.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">New plan (prorated)</span>
              <span>{preview.cost.toFixed(2)}</span>
            </div>
            <div className="flex justify-between border-t pt-1 font-medium">
              <span>{preview.net >= 0 ? 'Customer owes' : 'Customer credit'}</span>
              <span>{Math.abs(preview.net).toFixed(2)}</span>
            </div>
            <p className="text-[11px] text-muted-foreground pt-1">
              Estimate — the server recalculates from the real period length.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={run} disabled={busy || !planId}>
            {busy && <Loader2 className="size-4 animate-spin me-1.5" />}
            Change plan
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
            {busy && <Loader2 className="size-4 animate-spin me-1.5" />}
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
  const [invoices, setInvoices] = useState<AdminInvoice[]>([])
  const [outstanding, setOutstanding] = useState(0)
  const [loading, setLoading] = useState(false)
  const [payFilter, setPayFilter] = useState('pending')
  const [target, setTarget] = useState<AdminPayment | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [extendTarget, setExtendTarget] = useState<AdminSubscription | null>(null)
  const [extendOpen, setExtendOpen] = useState(false)
  const [planTarget, setPlanTarget] = useState<AdminSubscription | null>(null)
  const [planOpen, setPlanOpen] = useState(false)
  const [invTarget, setInvTarget] = useState<AdminInvoice | null>(null)
  const [invMode, setInvMode] = useState<'payment' | 'refund'>('payment')
  const [invOpen, setInvOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [p, s, inv] = await Promise.all([
        apiFetch<{ payments: AdminPayment[] }>(
          `/admin/payments?status=${encodeURIComponent(payFilter)}`
        ),
        apiFetch<{ subscriptions: AdminSubscription[] }>(
          '/admin/subscriptions?status=all'
        ),
        apiFetch<{
          invoices: AdminInvoice[]
          counts: { outstandingTotal: number }
        }>('/admin/invoices?status=all'),
      ])
      setPayments(p.payments || [])
      setSubs(s.subscriptions || [])
      setInvoices(inv.invoices || [])
      setOutstanding(inv.counts?.outstandingTotal ?? 0)
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
              <Badge variant="secondary" className="ms-1.5">
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="invoices">
            Invoices
            {outstanding > 0 && (
              <Badge variant="secondary" className="ms-1.5">
                ${outstanding.toFixed(2)} due
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
                  <tr className="text-start">
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
                      <td className="p-2 text-end">
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

        {/* ── Invoices ─────────────────────────────────────────────── */}
        <TabsContent value="invoices">
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {loading
                ? 'Loading…'
                : 'No invoices yet — one is raised automatically when a customer checks out.'}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-start">
                    <th className="p-2 font-medium">Invoice</th>
                    <th className="p-2 font-medium">Customer</th>
                    <th className="p-2 font-medium">For</th>
                    <th className="p-2 font-medium">Total</th>
                    <th className="p-2 font-medium">Status</th>
                    <th className="p-2 font-medium">Due</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id} className="border-t align-middle">
                      <td className="p-2 font-mono text-xs">{inv.number}</td>
                      <td className="p-2">
                        <div className="font-medium">{inv.user?.name || '—'}</div>
                        <div className="text-xs text-muted-foreground">
                          {inv.user?.email}
                        </div>
                      </td>
                      <td className="p-2 text-xs">
                        {inv.planName || inv.domainName || inv.type}
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        {inv.currency} {Number(inv.total).toFixed(2)}
                        {inv.balanceDue > 0 && inv.amountPaid > 0 && (
                          <div className="text-xs text-amber-600">
                            {inv.balanceDue.toFixed(2)} due
                          </div>
                        )}
                        {inv.amountRefunded > 0 && (
                          <div className="text-xs text-muted-foreground">
                            −{inv.amountRefunded.toFixed(2)} refunded
                          </div>
                        )}
                      </td>
                      <td className="p-2">
                        <Badge variant={statusVariant(inv.status)}>
                          {inv.status === 'partially_paid' ? 'partial' : inv.status}
                        </Badge>
                        {inv.invoiceType === 'credit_note' && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            credit note
                          </div>
                        )}
                      </td>
                      <td className="p-2 whitespace-nowrap text-xs text-muted-foreground">
                        {inv.dueDate
                          ? new Date(inv.dueDate).toLocaleDateString()
                          : '—'}
                      </td>
                      <td className="p-2 text-end">
                        {inv.rawStatus === 'unpaid' && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={async () => {
                              try {
                                const r = await apiFetch<{ message?: string }>(
                                  '/admin/invoices',
                                  {
                                    method: 'PATCH',
                                    body: JSON.stringify({
                                      id: inv.id,
                                      action: 'mark_paid',
                                    }),
                                  }
                                )
                                toast.success(r.message || 'Marked paid')
                                load()
                              } catch (err) {
                                toast.error(
                                  err instanceof Error
                                    ? err.message
                                    : 'Failed'
                                )
                              }
                            }}
                          >
                            Mark paid
                          </Button>
                        )}
                        {(inv.rawStatus === 'unpaid' ||
                          inv.rawStatus === 'partially_paid') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Record a payment (supports partial)"
                            onClick={() => {
                              setInvTarget(inv)
                              setInvMode('payment')
                              setInvOpen(true)
                            }}
                          >
                            Add payment
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Open the PDF (print or save from there)"
                          onClick={() => {
                            // The session cookie authenticates the download.
                            window.open(`/api/invoices/${inv.id}/pdf`, '_blank', 'noopener')
                          }}
                        >
                          PDF
                        </Button>
                        {inv.rawStatus !== 'paid' &&
                          inv.rawStatus !== 'void' &&
                          inv.invoiceType !== 'credit_note' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              title="Email the customer a reminder"
                              onClick={async () => {
                                try {
                                  const r = await apiFetch<{ message?: string }>(
                                    '/admin/invoices',
                                    {
                                      method: 'PATCH',
                                      body: JSON.stringify({
                                        id: inv.id,
                                        action: 'send_reminder',
                                      }),
                                    }
                                  )
                                  toast.success(r.message || 'Reminder sent')
                                  load()
                                } catch (err) {
                                  toast.error(
                                    err instanceof Error ? err.message : 'Failed'
                                  )
                                }
                              }}
                            >
                              Remind
                            </Button>
                          )}
                        {inv.amountPaid > inv.amountRefunded &&
                          inv.invoiceType !== 'credit_note' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-red-600 hover:text-red-700"
                              title="Refund this invoice"
                              onClick={() => {
                                setInvTarget(inv)
                                setInvMode('refund')
                                setInvOpen(true)
                              }}
                            >
                              Refund
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
                  <tr className="text-start">
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
                        {!s.managedByStripe && !s.autoRenew && (
                          <div className="text-xs text-amber-600 mt-0.5">
                            auto-renew off
                          </div>
                        )}
                        {s.renewalAttempts > 0 && (
                          <div
                            className="text-xs text-red-600 mt-0.5"
                            title={s.lastRenewalError || ''}
                          >
                            {s.renewalAttempts} failed renewal(s)
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
                      <td className="p-2 text-end">
                        {!s.managedByStripe && (
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setExtendTarget(s)
                                setExtendOpen(true)
                              }}
                            >
                              <CalendarPlus className="size-4 me-1.5" />
                              Extend
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              title="Bill the next period now"
                              onClick={async () => {
                                if (
                                  !confirm(
                                    `Renew ${s.user?.email}'s ${s.plan?.name || 'plan'} now? This raises the next period's invoice.`
                                  )
                                )
                                  return
                                try {
                                  const r = await apiFetch<{ message?: string }>(
                                    '/admin/subscriptions',
                                    {
                                      method: 'PATCH',
                                      body: JSON.stringify({
                                        id: s.id,
                                        action: 'renew',
                                      }),
                                    }
                                  )
                                  toast.success(r.message || 'Renewed')
                                  load()
                                } catch (err) {
                                  toast.error(
                                    err instanceof Error ? err.message : 'Failed'
                                  )
                                }
                              }}
                            >
                              Renew
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              title={
                                s.autoRenew
                                  ? 'Turn auto-renew off'
                                  : 'Turn auto-renew on'
                              }
                              onClick={async () => {
                                try {
                                  const r = await apiFetch<{ message?: string }>(
                                    '/admin/subscriptions',
                                    {
                                      method: 'PATCH',
                                      body: JSON.stringify({
                                        id: s.id,
                                        action: 'auto_renew',
                                        autoRenew: !s.autoRenew,
                                      }),
                                    }
                                  )
                                  toast.success(r.message || 'Updated')
                                  load()
                                } catch (err) {
                                  toast.error(
                                    err instanceof Error ? err.message : 'Failed'
                                  )
                                }
                              }}
                            >
                              {s.autoRenew ? 'Auto: on' : 'Auto: off'}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setPlanTarget(s)
                                setPlanOpen(true)
                              }}
                            >
                              Change plan
                            </Button>
                            {s.status !== 'cancelled' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-red-600 hover:text-red-700"
                                onClick={async () => {
                                  if (
                                    !confirm(
                                      `Cancel ${s.user?.email}'s subscription immediately? Access ends now, not at period end.`
                                    )
                                  )
                                    return
                                  try {
                                    await apiFetch('/admin/subscriptions', {
                                      method: 'PATCH',
                                      body: JSON.stringify({
                                        id: s.id,
                                        action: 'force_cancel',
                                      }),
                                    })
                                    toast.success('Subscription cancelled')
                                    load()
                                  } catch (err) {
                                    toast.error(
                                      err instanceof Error ? err.message : 'Failed'
                                    )
                                  }
                                }}
                              >
                                Cancel now
                              </Button>
                            )}
                          </div>
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
      <ChangePlanDialog
        sub={planTarget}
        open={planOpen}
        onOpenChange={setPlanOpen}
        onDone={load}
      />
      <InvoiceActionDialog
        invoice={invTarget}
        mode={invMode}
        open={invOpen}
        onOpenChange={setInvOpen}
        onDone={load}
      />
    </div>
  )
}
