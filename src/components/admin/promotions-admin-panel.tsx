'use client'

/**
 * Admin panel for coupons, tax rates and customer wallet credit.
 * These three all change what a customer is actually charged, so they live
 * together rather than being scattered across the billing screens.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
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
import { Loader2, RefreshCw, Plus } from 'lucide-react'

// Delegate to the shared client — see billing-admin-panel for why.
async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return (await baseApiFetch(path, init)) as T
}

interface Coupon {
  id: string
  code: string
  description: string | null
  type: string
  value: number
  currency: string
  recurring: boolean
  firstPurchaseOnly: boolean
  minSubtotal: number | null
  maxRedemptions: number | null
  maxPerCustomer: number | null
  redemptions: number
  expiresAt: string | null
  active: boolean
  expired: boolean
  exhausted: boolean
}

interface TaxRate {
  id: string
  name: string
  rate: number
  country: string | null
  region: string | null
  active: boolean
  priority: number
  compound: boolean
}

interface CreditUser {
  id: string
  name: string | null
  email: string
  creditBalance: number
}

// ── Coupon dialog ──────────────────────────────────────────────────────
function CouponDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSaved: () => void
}) {
  const [f, setF] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open)
      setF({
        code: '',
        type: 'percent',
        value: 10,
        currency: 'USD',
        recurring: false,
        firstPurchaseOnly: false,
        active: true,
      })
  }, [open])

  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }))

  const save = async () => {
    setBusy(true)
    try {
      await apiFetch('/admin/coupons', {
        method: 'POST',
        body: JSON.stringify(f),
      })
      toast.success('Coupon created')
      onSaved()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New coupon</DialogTitle>
          <DialogDescription>
            Leave a limit blank for unlimited. Recurring coupons re-apply on
            every renewal; otherwise the discount is one-time.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="c-code">Code</Label>
              <Input
                id="c-code"
                placeholder="LAUNCH20"
                value={String(f.code ?? '')}
                onChange={(e) => set('code', e.target.value.toUpperCase())}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-type">Type</Label>
              <select
                id="c-type"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={String(f.type ?? 'percent')}
                onChange={(e) => set('type', e.target.value)}
              >
                <option value="percent">Percentage (%)</option>
                <option value="fixed">Fixed amount</option>
              </select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="c-value">
                {f.type === 'fixed' ? 'Amount off' : 'Percent off'}
              </Label>
              <Input
                id="c-value"
                type="number"
                min={0}
                value={String(f.value ?? '')}
                onChange={(e) => set('value', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-min">Min. subtotal</Label>
              <Input
                id="c-min"
                type="number"
                min={0}
                placeholder="none"
                value={String(f.minSubtotal ?? '')}
                onChange={(e) =>
                  set('minSubtotal', e.target.value === '' ? null : e.target.value)
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-exp">Expires</Label>
              <Input
                id="c-exp"
                type="date"
                value={String(f.expiresAt ?? '')}
                onChange={(e) =>
                  set('expiresAt', e.target.value === '' ? null : e.target.value)
                }
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="c-maxr">Max total uses</Label>
              <Input
                id="c-maxr"
                type="number"
                min={1}
                placeholder="unlimited"
                value={String(f.maxRedemptions ?? '')}
                onChange={(e) =>
                  set('maxRedemptions', e.target.value === '' ? null : e.target.value)
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-maxc">Max per customer</Label>
              <Input
                id="c-maxc"
                type="number"
                min={1}
                placeholder="unlimited"
                value={String(f.maxPerCustomer ?? '')}
                onChange={(e) =>
                  set('maxPerCustomer', e.target.value === '' ? null : e.target.value)
                }
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
            {(
              [
                ['recurring', 'Applies to renewals'],
                ['firstPurchaseOnly', 'First purchase only'],
                ['active', 'Active'],
              ] as const
            ).map(([k, label]) => (
              <label className="flex items-center gap-2 text-sm" key={k}>
                <input
                  type="checkbox"
                  checked={f[k] === true}
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
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Tax rate dialog ────────────────────────────────────────────────────
function TaxDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSaved: () => void
}) {
  const [f, setF] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) setF({ name: 'VAT', rate: 20, active: true, compound: false })
  }, [open])

  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }))

  const save = async () => {
    setBusy(true)
    try {
      await apiFetch('/admin/tax-rates', {
        method: 'POST',
        body: JSON.stringify(f),
      })
      toast.success('Tax rate created')
      onSaved()
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
          <DialogTitle>New tax rate</DialogTitle>
          <DialogDescription>
            Leave country blank for a global default. A country-specific rate
            overrides the default for those customers.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="t-name">Name</Label>
              <Input
                id="t-name"
                placeholder="VAT"
                value={String(f.name ?? '')}
                onChange={(e) => set('name', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-rate">Rate (%)</Label>
              <Input
                id="t-rate"
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={String(f.rate ?? '')}
                onChange={(e) => set('rate', e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="t-country">Country (ISO-2)</Label>
              <Input
                id="t-country"
                placeholder="blank = all"
                maxLength={2}
                value={String(f.country ?? '')}
                onChange={(e) => set('country', e.target.value.toUpperCase())}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-region">Region</Label>
              <Input
                id="t-region"
                placeholder="optional"
                value={String(f.region ?? '')}
                onChange={(e) => set('region', e.target.value)}
              />
            </div>
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={f.active === true}
                onChange={(e) => set('active', e.target.checked)}
              />
              Active
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={f.compound === true}
                onChange={(e) => set('compound', e.target.checked)}
              />
              Compound (charge on top of other taxes)
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin mr-1.5" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Main panel ─────────────────────────────────────────────────────────
export function PromotionsAdminPanel() {
  const [coupons, setCoupons] = useState<Coupon[]>([])
  const [rates, setRates] = useState<TaxRate[]>([])
  const [creditUsers, setCreditUsers] = useState<CreditUser[]>([])
  const [totalCredit, setTotalCredit] = useState(0)
  const [loading, setLoading] = useState(false)
  const [couponOpen, setCouponOpen] = useState(false)
  const [taxOpen, setTaxOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, t, cr] = await Promise.all([
        apiFetch<{ coupons: Coupon[] }>('/admin/coupons'),
        apiFetch<{ rates: TaxRate[] }>('/admin/tax-rates'),
        apiFetch<{ users: CreditUser[]; totalOutstandingCredit: number }>(
          '/admin/credit'
        ),
      ])
      setCoupons(c.coupons || [])
      setRates(t.rates || [])
      setCreditUsers(cr.users || [])
      setTotalCredit(cr.totalOutstandingCredit || 0)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const toggleCoupon = async (c: Coupon) => {
    try {
      await apiFetch('/admin/coupons', {
        method: 'PATCH',
        body: JSON.stringify({ id: c.id, active: !c.active }),
      })
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold">Discounts &amp; Tax</h3>
          <p className="text-sm text-muted-foreground">
            Coupons, tax rates and customer wallet balances.
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

      <Tabs defaultValue="coupons" className="space-y-4">
        <TabsList>
          <TabsTrigger value="coupons">Coupons</TabsTrigger>
          <TabsTrigger value="tax">Tax rates</TabsTrigger>
          <TabsTrigger value="credit">
            Credit
            {totalCredit > 0 && (
              <Badge variant="secondary" className="ml-1.5">
                ${totalCredit.toFixed(2)}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Coupons */}
        <TabsContent value="coupons" className="space-y-3">
          <Button size="sm" onClick={() => setCouponOpen(true)}>
            <Plus className="size-4 mr-1.5" /> New coupon
          </Button>
          {coupons.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {loading ? 'Loading…' : 'No coupons yet.'}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    <th className="p-2 font-medium">Code</th>
                    <th className="p-2 font-medium">Discount</th>
                    <th className="p-2 font-medium">Used</th>
                    <th className="p-2 font-medium">Expires</th>
                    <th className="p-2 font-medium">Status</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {coupons.map((c) => (
                    <tr key={c.id} className="border-t">
                      <td className="p-2 font-mono">{c.code}</td>
                      <td className="p-2">
                        {c.type === 'percent'
                          ? `${c.value}%`
                          : `${c.currency} ${c.value.toFixed(2)}`}
                        {c.recurring && (
                          <Badge variant="outline" className="ml-1.5 text-[10px]">
                            recurring
                          </Badge>
                        )}
                      </td>
                      <td className="p-2">
                        {c.redemptions}
                        {c.maxRedemptions != null && ` / ${c.maxRedemptions}`}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {c.expiresAt
                          ? new Date(c.expiresAt).toLocaleDateString()
                          : '—'}
                      </td>
                      <td className="p-2">
                        {c.expired ? (
                          <Badge variant="destructive">expired</Badge>
                        ) : c.exhausted ? (
                          <Badge variant="destructive">used up</Badge>
                        ) : c.active ? (
                          <Badge>active</Badge>
                        ) : (
                          <Badge variant="outline">off</Badge>
                        )}
                      </td>
                      <td className="p-2 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => toggleCoupon(c)}
                        >
                          {c.active ? 'Disable' : 'Enable'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        {/* Tax */}
        <TabsContent value="tax" className="space-y-3">
          <Button size="sm" onClick={() => setTaxOpen(true)}>
            <Plus className="size-4 mr-1.5" /> New tax rate
          </Button>
          {rates.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {loading
                ? 'Loading…'
                : 'No tax rates — invoices are issued with no tax.'}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    <th className="p-2 font-medium">Name</th>
                    <th className="p-2 font-medium">Rate</th>
                    <th className="p-2 font-medium">Applies to</th>
                    <th className="p-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rates.map((t) => (
                    <tr key={t.id} className="border-t">
                      <td className="p-2">
                        {t.name}
                        {t.compound && (
                          <Badge variant="outline" className="ml-1.5 text-[10px]">
                            compound
                          </Badge>
                        )}
                      </td>
                      <td className="p-2">{t.rate}%</td>
                      <td className="p-2 text-xs">
                        {t.country
                          ? `${t.country}${t.region ? ` / ${t.region}` : ''}`
                          : 'All customers (default)'}
                      </td>
                      <td className="p-2">
                        {t.active ? (
                          <Badge>active</Badge>
                        ) : (
                          <Badge variant="outline">off</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        {/* Credit */}
        <TabsContent value="credit">
          {creditUsers.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {loading ? 'Loading…' : 'No customers hold a balance.'}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    <th className="p-2 font-medium">Customer</th>
                    <th className="p-2 font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {creditUsers.map((u) => (
                    <tr key={u.id} className="border-t">
                      <td className="p-2">
                        <div className="font-medium">{u.name || '—'}</div>
                        <div className="text-xs text-muted-foreground">
                          {u.email}
                        </div>
                      </td>
                      <td className="p-2 font-medium">
                        {u.creditBalance.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <CouponDialog open={couponOpen} onOpenChange={setCouponOpen} onSaved={load} />
      <TaxDialog open={taxOpen} onOpenChange={setTaxOpen} onSaved={load} />
    </div>
  )
}
