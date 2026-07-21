'use client'

/**
 * Payment gateway readiness.
 *
 * The point of this screen is to make "can we actually take money?" a
 * question with a visible answer. It deliberately separates three different
 * kinds of not-working, because the fix for each is different:
 *   - no integration code exists   → engineering work
 *   - credentials missing          → operator sets env vars
 *   - sandbox/test credentials     → works, but takes no real money
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { apiFetch as baseApiFetch } from '@/store/auth-store'
import {
  Loader2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  FlaskConical,
} from 'lucide-react'

// Delegate to the shared client — see billing-admin-panel for why.
async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return (await baseApiFetch(path, init)) as T
}

interface Gateway {
  id: string
  label: string
  displayName: string
  implemented: boolean
  configured: boolean
  usable: boolean
  enabled: boolean
  seeded: boolean
  mode: 'live' | 'test' | 'unknown' | 'n/a'
  capabilities: string[]
  currencies: string[]
  requiredEnv: string[]
  missingEnv: string[]
  transactions: number
  completedTransactions: number
  volume: number
  note?: string
  blocker: string | null
  warning: string | null
}

interface GatewayData {
  gateways: Gateway[]
  summary: {
    total: number
    implemented: number
    usable: number
    enabled: number
    misconfiguredCount: number
    misconfigured: Array<{ id: string; blocker: string | null }>
    testModeCount: number
    testMode: string[]
    liveReady: boolean
  }
}

const CAPABILITY_LABELS: Record<string, string> = {
  redirect: 'Hosted checkout',
  recurring: 'Native recurring',
  refund_api: 'API refunds',
  webhook: 'Webhooks',
  manual_capture: 'Manual capture',
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'good' | 'warn' | 'bad'
}) {
  const color =
    tone === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : tone === 'bad'
          ? 'text-red-600 dark:text-red-400'
          : ''
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function GatewaysAdminPanel() {
  const [data, setData] = useState<GatewayData | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await apiFetch<GatewayData>('/admin/gateways'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load gateways')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const money = (n: number) => `$${Number(n || 0).toFixed(2)}`

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold">Payment gateways</h3>
          <p className="text-sm text-muted-foreground">
            What each gateway can do, and whether it can take money right now.
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

      {!data ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {loading ? 'Loading…' : 'No gateway data.'}
        </p>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Can take real money"
              value={data.summary.liveReady ? 'Yes' : 'No'}
              hint="At least one enabled, live gateway"
              tone={data.summary.liveReady ? 'good' : 'bad'}
            />
            <Stat
              label="Usable"
              value={`${data.summary.usable} / ${data.summary.total}`}
              hint="Integrated and configured"
            />
            <Stat
              label="Enabled"
              value={String(data.summary.enabled)}
              hint="Offered at checkout"
            />
            <Stat
              label="Needs attention"
              value={String(
                data.summary.misconfiguredCount + data.summary.testModeCount
              )}
              hint="Enabled but broken or in test mode"
              tone={
                data.summary.misconfiguredCount > 0
                  ? 'bad'
                  : data.summary.testModeCount > 0
                    ? 'warn'
                    : 'good'
              }
            />
          </div>

          {/* An enabled gateway that cannot work fails at checkout, in front
              of a paying customer — surface it loudly. */}
          {data.summary.misconfiguredCount > 0 && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-3">
              <p className="flex items-center gap-1.5 text-sm font-medium text-red-600 dark:text-red-400">
                <XCircle className="size-4" />
                {data.summary.misconfiguredCount} enabled gateway(s) cannot take
                payments
              </p>
              <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
                {data.summary.misconfigured.map((m) => (
                  <li key={m.id}>
                    <span className="font-medium">{m.id}</span> — {m.blocker}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.summary.testModeCount > 0 && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
              <p className="flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
                <FlaskConical className="size-4" />
                Test credentials in use: {data.summary.testMode.join(', ')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Checkout will appear to work but no real money moves. Swap in
                live keys before taking customer payments.
              </p>
            </div>
          )}

          <div className="space-y-2">
            {data.gateways.map((g) => (
              <div key={g.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 font-medium">
                      {g.usable ? (
                        <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                      ) : (
                        <XCircle className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      {g.displayName}
                      {g.mode === 'test' && (
                        <Badge
                          variant="outline"
                          className="border-amber-500/50 text-amber-600 dark:text-amber-400"
                        >
                          test mode
                        </Badge>
                      )}
                      {g.mode === 'live' && g.usable && (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/50 text-emerald-600 dark:text-emerald-400"
                        >
                          live
                        </Badge>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {g.currencies.length
                        ? g.currencies.join(', ')
                        : 'Operator-defined currency'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Badge variant={g.enabled ? 'default' : 'secondary'}>
                      {g.enabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                    {!g.implemented && (
                      <Badge variant="outline">No integration</Badge>
                    )}
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap gap-1">
                  {g.capabilities.map((c) => (
                    <Badge key={c} variant="secondary" className="text-[10px]">
                      {CAPABILITY_LABELS[c] || c}
                    </Badge>
                  ))}
                </div>

                {g.blocker && (
                  <p className="mt-2 flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
                    <XCircle className="mt-0.5 size-3.5 shrink-0" />
                    {g.blocker}
                  </p>
                )}
                {g.warning && (
                  <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    {g.warning}
                  </p>
                )}
                {g.note && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    {g.note}
                  </p>
                )}

                {g.transactions > 0 && (
                  <p className="mt-2 text-[11px] text-muted-foreground tabular-nums">
                    {g.completedTransactions} of {g.transactions} payment(s)
                    completed · {money(g.volume)} collected
                  </p>
                )}
              </div>
            ))}
          </div>

          <p className="text-[11px] text-muted-foreground">
            Gateways marked “No integration” are listed so you know they exist —
            there is no code behind them yet, and enabling one would fail at
            checkout. Adding one needs both a merchant account and development
            work.
          </p>
        </div>
      )}
    </div>
  )
}
