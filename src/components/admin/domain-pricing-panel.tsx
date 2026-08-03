'use client'

/**
 * Domain pricing for the admin.
 *
 * There was one global markup applied identically to registration, renewal and
 * transfer. That forces the same margin on the first year — where resellers
 * usually compete on price — and on renewals, where the margin actually is.
 *
 * Every field shows the wholesale cost it sits on top of, and a live worked
 * example, because "$2 markup" means nothing without knowing whether .com
 * costs us $10 or $90. An abstract percentage is exactly how you end up
 * selling .ai below cost.
 */
import { useCallback, useEffect, useState } from 'react'
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@/components/ui/table'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import { Loader2, RefreshCw, Tag, Percent, AlertTriangle } from 'lucide-react'

interface Settings {
  registerMarkup: number
  renewMarkup: number
  transferMarkup: number
  discountPercent: number
  registerDiscount: number
  renewDiscount: number
  transferDiscount: number
  globalMarkup: number
}

interface Example {
  tld: string
  wholesale: number
  registration: number
  renewal: number
  transfer: number
}

interface Response {
  settings: Settings
  examples: Example[]
  fallbackMarkup: number
}

const usd = (n: number) => `$${n.toFixed(2)}`

export function DomainPricingPanel() {
  const [data, setData] = useState<Response | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Held as strings so a half-typed "1." does not become NaN mid-keystroke.
  const [reg, setReg] = useState('')
  const [ren, setRen] = useState('')
  const [xfer, setXfer] = useState('')
  const [disc, setDisc] = useState('')
  const [dReg, setDReg] = useState('')
  const [dRen, setDRen] = useState('')
  const [dXfer, setDXfer] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await apiFetch<Response>('/admin/domain-pricing')
      setData(r)
      setReg(String(r.settings.registerMarkup))
      setRen(String(r.settings.renewMarkup))
      setXfer(String(r.settings.transferMarkup))
      setDisc(String(r.settings.discountPercent))
      setDReg(String(r.settings.registerDiscount))
      setDRen(String(r.settings.renewDiscount))
      setDXfer(String(r.settings.transferDiscount))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load domain pricing')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const save = async () => {
    setSaving(true)
    try {
      const r = await apiFetch<{ message?: string }>('/admin/domain-pricing', {
        method: 'PUT',
        body: JSON.stringify({
          registerMarkup: reg,
          renewMarkup: ren,
          transferMarkup: xfer,
          discountPercent: disc,
          registerDiscount: dReg,
          renewDiscount: dRen,
          transferDiscount: dXfer,
        }),
      })
      toast.success(r.message || 'Domain pricing updated.')
      load()
    } catch (err) {
      // The route explains itself — "must be zero or more", "looks like a
      // mistake" — so show that rather than a generic failure.
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Skeleton className="h-96 w-full" />
  if (!data) return null

  // Preview the numbers as typed, before saving.
  const n = (s: string) => {
    const v = parseFloat(s)
    return Number.isFinite(v) ? v : 0
  }
  // A blank per-action discount follows "All actions", matching the server.
  const pct = (s: string, fallback: number) => {
    const v = parseFloat(s)
    return Number.isFinite(v) && v > 0 ? Math.min(v, 90) : fallback
  }
  const allPct = Math.min(Math.max(n(disc), 0), 90)
  const preview = (wholesale: number, markup: number, discountStr: string) =>
    Math.max(
      0,
      Math.round((wholesale + markup) * (1 - pct(discountStr, allPct) / 100) * 100) / 100
    )

  const dirty =
    n(reg) !== data.settings.registerMarkup ||
    n(ren) !== data.settings.renewMarkup ||
    n(xfer) !== data.settings.transferMarkup ||
    n(disc) !== data.settings.discountPercent ||
    n(dReg) !== data.settings.registerDiscount ||
    n(dRen) !== data.settings.renewDiscount ||
    n(dXfer) !== data.settings.transferDiscount

  const belowCost = data.examples.some(
    (e) =>
      preview(e.wholesale, n(reg), dReg) < e.wholesale ||
      preview(e.wholesale, n(ren), dRen) < e.wholesale ||
      preview(e.wholesale, n(xfer), dXfer) < e.wholesale
  )

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <Tag className="size-5" />
                Domain Pricing
              </CardTitle>
              <CardDescription className="mt-1">
                What you add to the registrar&apos;s wholesale price. Applies to new quotes
                immediately.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={load}>
              <RefreshCw className="size-3.5 mr-1" />
              Refresh
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="dp-reg">Registration markup</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                <Input
                  id="dp-reg"
                  className="pl-6"
                  inputMode="decimal"
                  placeholder="e.g. 5.00"
                  value={reg}
                  onChange={(e) => setReg(e.target.value)}
                />
              </div>
              <p className="text-xs text-muted-foreground">Added to wholesale for a new domain.</p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="dp-ren">Renewal markup</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                <Input
                  id="dp-ren"
                  className="pl-6"
                  inputMode="decimal"
                  placeholder="e.g. 8.00"
                  value={ren}
                  onChange={(e) => setRen(e.target.value)}
                />
              </div>
              <p className="text-xs text-muted-foreground">Charged every year after the first.</p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="dp-xfer">Transfer markup</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                <Input
                  id="dp-xfer"
                  className="pl-6"
                  inputMode="decimal"
                  placeholder="e.g. 3.00"
                  value={xfer}
                  onChange={(e) => setXfer(e.target.value)}
                />
              </div>
              <p className="text-xs text-muted-foreground">For a domain moved in from elsewhere.</p>
            </div>
          </div>

          <div className="pt-2 border-t">
            <p className="text-sm font-medium mb-1">Discounts</p>
            <p className="text-xs text-muted-foreground mb-3">
              “All actions” fills the other three — set it first, then adjust any one
              of them. Each box is what customers are charged, so 0 means no discount.
              Max 90%: the registrar still charges you wholesale.
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="dp-disc" className="flex items-center gap-1">
                  <Percent className="size-3.5" />
                  All actions
                </Label>
                <div className="relative">
                  <Input id="dp-disc" className="pr-8" inputMode="decimal" placeholder="0"
                    value={disc}
                    onChange={(e) => {
                      // Writes through to all three rather than being inherited
                      // silently — the four boxes always show what is charged.
                      setDisc(e.target.value)
                      setDReg(e.target.value)
                      setDRen(e.target.value)
                      setDXfer(e.target.value)
                    }} />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
                </div>
                <p className="text-xs text-muted-foreground">Sets all three.</p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="dp-dreg">Registration</Label>
                <div className="relative">
                  <Input id="dp-dreg" className="pr-8" inputMode="decimal" placeholder="0"
                    value={dReg} onChange={(e) => setDReg(e.target.value)} />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
                </div>
                <p className="text-xs text-muted-foreground">First year only.</p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="dp-dren">Renewal</Label>
                <div className="relative">
                  <Input id="dp-dren" className="pr-8" inputMode="decimal" placeholder="0"
                    value={dRen} onChange={(e) => setDRen(e.target.value)} />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
                </div>
                <p className="text-xs text-muted-foreground">Every year after.</p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="dp-dxfer">Transfer</Label>
                <div className="relative">
                  <Input id="dp-dxfer" className="pr-8" inputMode="decimal" placeholder="0"
                    value={dXfer} onChange={(e) => setDXfer(e.target.value)} />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
                </div>
                <p className="text-xs text-muted-foreground">Moved in from elsewhere.</p>
              </div>
            </div>
          </div>

          {belowCost && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 flex items-start gap-2 text-sm">
              <AlertTriangle className="size-4 text-destructive mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">This sells at least one TLD below cost</p>
                <p className="text-muted-foreground mt-0.5">
                  The registrar still charges you wholesale. Check the table below.
                </p>
              </div>
            </div>
          )}
        </CardContent>

        <CardFooter className="flex items-center gap-2">
          <Button onClick={save} disabled={saving || !dirty}>
            {saving ? <Loader2 className="size-4 mr-2 animate-spin" /> : null}
            Save
          </Button>
          {dirty && <span className="text-xs text-muted-foreground">unsaved changes</span>}
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What customers would pay</CardTitle>
          <CardDescription>
            Live preview using the values above — before you save.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>TLD</TableHead>
                  <TableHead>Wholesale</TableHead>
                  <TableHead>Register</TableHead>
                  <TableHead>Renew</TableHead>
                  <TableHead>Transfer</TableHead>
                  <TableHead className="text-right">Margin / yr</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.examples.map((e) => {
                  const r = preview(e.wholesale, n(reg), dReg)
                  const rn = preview(e.wholesale, n(ren), dRen)
                  const x = preview(e.wholesale, n(xfer), dXfer)
                  const margin = rn - e.wholesale
                  return (
                    <TableRow key={e.tld}>
                      <TableCell className="font-mono">{e.tld}</TableCell>
                      <TableCell className="text-muted-foreground">{usd(e.wholesale)}</TableCell>
                      <TableCell className={r < e.wholesale ? 'text-destructive font-medium' : ''}>
                        {usd(r)}
                      </TableCell>
                      <TableCell className={rn < e.wholesale ? 'text-destructive font-medium' : ''}>
                        {usd(rn)}
                      </TableCell>
                      <TableCell className={x < e.wholesale ? 'text-destructive font-medium' : ''}>
                        {usd(x)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant="outline"
                          className={
                            margin <= 0
                              ? 'border-destructive/50 text-destructive'
                              : 'border-emerald-500/50 text-emerald-600'
                          }
                        >
                          {margin >= 0 ? '+' : ''}
                          {usd(margin)}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Wholesale is what the registrar charges. Margin is the renewal price minus
            wholesale — the recurring part.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
