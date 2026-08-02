'use client'

/**
 * Plan change dialog.
 *
 * The billing page had one path for every plan card: open checkout. For a
 * customer who already pays for something, that bought a SECOND subscription
 * rather than moving them — and there was no way at all to move down.
 *
 * This is the other path. It previews before it charges, because the two
 * things a customer needs to know before committing are what it costs today
 * (not next month) and whether their existing sites still fit. The preview
 * endpoint answers both, and a preview that reports "does not fit" is a
 * successful preview — it comes back with the specifics so we can show them
 * instead of a generic refusal.
 */
import { useState, useEffect, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Loader2,
  ArrowUpRight,
  ArrowDownRight,
  AlertTriangle,
  Wallet,
  Receipt,
} from 'lucide-react'
import { toast } from 'sonner'

export interface PlanChangePreview {
  ok: boolean
  error?: string
  direction: 'upgrade' | 'downgrade' | 'same'
  currentPlan: { id: string; name: string; price: number }
  targetPlan: { id: string; name: string; price: number }
  daysRemaining: number
  /** Positive = customer owes; negative = credit issued. */
  amountDue: number
  blockers: Array<{ resource: string; used: number; limit: number }>
}

interface PlanChangeResult {
  ok: boolean
  error?: string
  message?: string
  invoiceNumber?: string
  creditIssued?: number
  amountDue?: number
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The plan the customer clicked. */
  targetPlanId: string
  targetPlanName: string
  /** Called after a successful change so the page can refetch. */
  onChanged: () => void
  /**
   * Injected rather than imported so this component does not have to know how
   * the panel authenticates.
   */
  apiFetch: <T>(path: string, init?: RequestInit) => Promise<T>
}

export function PlanChangeDialog({
  open,
  onOpenChange,
  targetPlanId,
  targetPlanName,
  onChanged,
  apiFetch,
}: Props) {
  const [preview, setPreview] = useState<PlanChangePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadPreview = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    setPreview(null)
    try {
      const p = await apiFetch<PlanChangePreview>(
        `/billing/plan-change?planId=${encodeURIComponent(targetPlanId)}`
      )
      setPreview(p)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not price this change')
    } finally {
      setLoading(false)
    }
  }, [apiFetch, targetPlanId])

  useEffect(() => {
    if (open && targetPlanId) loadPreview()
  }, [open, targetPlanId, loadPreview])

  const handleApply = async () => {
    setApplying(true)
    try {
      const res = await apiFetch<PlanChangeResult>('/billing/plan-change', {
        method: 'POST',
        body: JSON.stringify({ planId: targetPlanId }),
      })
      toast.success(res.message || `Moved to ${targetPlanName}.`)
      onOpenChange(false)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not change plan')
    } finally {
      setApplying(false)
    }
  }

  const money = (n: number) => `$${Math.abs(n).toFixed(2)}`
  const isUpgrade = preview?.direction === 'upgrade'
  const owes = (preview?.amountDue ?? 0) > 0
  const credited = (preview?.amountDue ?? 0) < 0
  const blocked = Boolean(preview && !preview.ok)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isUpgrade ? (
              <ArrowUpRight className="size-5 text-indigo-600" />
            ) : (
              <ArrowDownRight className="size-5 text-amber-600" />
            )}
            Change to {targetPlanName}
          </DialogTitle>
          <DialogDescription>
            {loading
              ? 'Working out what this costs…'
              : preview
              ? `${preview.currentPlan.name} → ${preview.targetPlan.name}`
              : 'Review the change before it is applied.'}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin mr-2" />
            Pricing this change…
          </div>
        )}

        {loadError && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <p className="font-medium text-destructive mb-1">Could not price this change</p>
            <p className="text-muted-foreground">{loadError}</p>
          </div>
        )}

        {preview && !loading && (
          <div className="space-y-4">
            {/* Blockers first — this is the reason a downgrade is refused, and
                it is more important than the price. */}
            {blocked && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="size-4 text-amber-600 mt-0.5 shrink-0" />
                  <div className="text-sm">
                    <p className="font-medium mb-1">
                      Your account uses more than {preview.targetPlan.name} allows
                    </p>
                    {preview.blockers.length > 0 ? (
                      <ul className="space-y-1 text-muted-foreground">
                        {preview.blockers.map((b) => (
                          <li key={b.resource}>
                            {b.used} {b.resource}{' '}
                            <span className="text-amber-700 dark:text-amber-500">
                              (limit {b.limit})
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground">{preview.error}</p>
                    )}
                    {preview.blockers.length > 0 && (
                      <p className="text-muted-foreground mt-2">
                        Remove what you no longer need, then try again.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {!blocked && (
              <>
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Current plan</span>
                    <span>
                      {preview.currentPlan.name} · {money(preview.currentPlan.price)}/mo
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">New plan</span>
                    <span className="font-medium">
                      {preview.targetPlan.name} · {money(preview.targetPlan.price)}/mo
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Left in this period</span>
                    <span>
                      {preview.daysRemaining} day{preview.daysRemaining === 1 ? '' : 's'}
                    </span>
                  </div>
                </div>

                {/* Say plainly what happens to money. */}
                {owes && (
                  <div className="rounded-lg border border-indigo-500/40 bg-indigo-500/5 p-4">
                    <div className="flex items-start gap-2">
                      <Receipt className="size-4 text-indigo-600 mt-0.5 shrink-0" />
                      <div className="text-sm">
                        <p className="font-medium">
                          {money(preview.amountDue)} due now
                        </p>
                        <p className="text-muted-foreground mt-0.5">
                          Only the {preview.daysRemaining} day
                          {preview.daysRemaining === 1 ? '' : 's'} left in your current
                          period — not a full month. Your normal price resumes at the next
                          renewal.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {credited && (
                  <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
                    <div className="flex items-start gap-2">
                      <Wallet className="size-4 text-emerald-600 mt-0.5 shrink-0" />
                      <div className="text-sm">
                        <p className="font-medium">
                          {money(preview.amountDue)} added as account credit
                        </p>
                        <p className="text-muted-foreground mt-0.5">
                          The unused part of your current period. It comes off your next
                          invoice rather than being refunded to your card.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {!owes && !credited && (
                  <p className="text-sm text-muted-foreground">
                    Nothing to pay for the rest of this period.
                  </p>
                )}

                {/* A plan change rewrites CPU/RAM caps, but a running container
                    keeps its current limits until it is recreated. Say so
                    rather than letting them wonder why nothing changed. */}
                <p className="text-xs text-muted-foreground">
                  Redeploy your sites afterwards to apply the new CPU and memory limits.
                </p>
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applying}>
            {blocked ? 'Close' : 'Cancel'}
          </Button>
          {!blocked && preview && !loading && (
            <Button onClick={handleApply} disabled={applying}>
              {applying ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" />
                  Applying…
                </span>
              ) : owes ? (
                `Pay ${money(preview.amountDue)} and switch`
              ) : (
                `Switch to ${preview.targetPlan.name}`
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Small badge for a plan card: "Upgrade" / "Downgrade" vs the current plan. */
export function PlanDirectionBadge({
  currentPrice,
  planPrice,
}: {
  currentPrice: number
  planPrice: number
}) {
  if (planPrice === currentPrice) return null
  const up = planPrice > currentPrice
  return (
    <Badge
      variant="outline"
      className={
        up
          ? 'border-indigo-500/50 text-indigo-600'
          : 'border-amber-500/50 text-amber-600'
      }
    >
      {up ? 'Upgrade' : 'Downgrade'}
    </Badge>
  )
}
