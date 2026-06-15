'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { Check, CreditCard, Zap, Crown, Building2, ArrowRight } from 'lucide-react'
import { toast } from 'sonner'

// ── Types ──────────────────────────────────────────────────────────────
interface Plan {
  id: string
  name: string
  slug: string
  description: string
  price: number
  ram: string
  cpu: string
  storage: string
  bandwidth: string
  projects: number
  ssl: boolean
  customDomain: boolean
  popular: boolean
}

interface Subscription {
  id: string
  planId: string
  status: string
  currentPeriodStart: string
  currentPeriodEnd: string
  plan?: { name: string; price: number; slug: string }
}

interface Payment {
  id: string
  amount: number
  currency: string
  status: string
  type: string
  metadata: { planName?: string; domainName?: string; purchaseType?: string } | null
  createdAt: string
  plan: { name: string; price: number } | null
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

// ── Static plan definitions (fallback when API has different names) ────
const PLAN_DEFINITIONS: {
  slug: string
  name: string
  price: number
  icon: React.ElementType
  features: string[]
  highlight?: boolean
}[] = [
  {
    slug: 'starter',
    name: 'Starter',
    price: 9,
    icon: Zap,
    features: ['1 GB RAM', '1 vCPU', '10 GB Storage', '100 GB Bandwidth', '1 Project', 'Free SSL'],
  },
  {
    slug: 'pro',
    name: 'Pro',
    price: 29,
    icon: Crown,
    features: ['4 GB RAM', '2 vCPU', '50 GB Storage', '500 GB Bandwidth', '5 Projects', 'Free SSL', 'Custom Domains'],
    highlight: true,
  },
  {
    slug: 'business',
    name: 'Business',
    price: 79,
    icon: Building2,
    features: ['16 GB RAM', '4 vCPU', '200 GB Storage', 'Unlimited Bandwidth', 'Unlimited Projects', 'Free SSL', 'Custom Domains', 'Priority Support'],
  },
]

// ── Status badge helper ────────────────────────────────────────────────
function PaymentStatusBadge({ status }: { status: string }) {
  const map: Record<string, { className: string; label: string }> = {
    completed: { className: 'bg-emerald-100 text-emerald-700 border-emerald-200', label: 'Completed' },
    pending: { className: 'bg-yellow-100 text-yellow-700 border-yellow-200', label: 'Pending' },
    failed: { className: 'bg-red-100 text-red-700 border-red-200', label: 'Failed' },
    refunded: { className: 'bg-gray-100 text-gray-700 border-gray-200', label: 'Refunded' },
  }
  const cfg = map[status] || map.pending
  return (
    <Badge variant="outline" className={cfg.className}>
      {cfg.label}
    </Badge>
  )
}

// ── Component ──────────────────────────────────────────────────────────
export function BillingPanel() {
  const [plans, setPlans] = useState<Plan[]>([])
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading] = useState(true)
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [plansRes, historyRes] = await Promise.all([
        apiFetch<{ plans: Plan[] }>('/billing/plans'),
        apiFetch<{ payments: Payment[] }>('/billing/history'),
      ])
      setPlans(plansRes.plans)
      setPayments(historyRes.payments)

      // Determine active subscription from payment metadata
      const activePayment = historyRes.payments.find(
        (p) => p.status === 'completed' && (p.type === 'hosting' || p.type === 'both')
      )
      if (activePayment) {
        const planId = activePayment.metadata?.planName
          ? plansRes.plans.find(
              (pl) => pl.name === activePayment.metadata?.planName
            )?.id
          : null
        setSubscription({
          id: activePayment.id,
          planId: planId || '',
          status: 'active',
          currentPeriodStart: activePayment.createdAt,
          currentPeriodEnd: new Date(
            new Date(activePayment.createdAt).getTime() + 30 * 24 * 60 * 60 * 1000
          ).toISOString(),
          plan: activePayment.plan
            ? { name: activePayment.plan.name, price: activePayment.plan.price, slug: activePayment.plan.name.toLowerCase() }
            : null,
        })
      }
    } catch {
      toast.error('Failed to load billing data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleCheckout = async (planId: string, planName: string) => {
    setCheckoutLoading(planId)
    try {
      await apiFetch('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ planId, type: 'hosting' }),
      })
      toast.success(`Subscribed to ${planName} plan!`)
      await fetchData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Checkout failed')
    } finally {
      setCheckoutLoading(null)
    }
  }

  // ── Loading skeleton ────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-48 w-full rounded-xl" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    )
  }

  const currentPlanSlug = subscription?.plan?.slug || subscription?.plan?.name?.toLowerCase() || ''

  return (
    <div className="space-y-6">
      {/* ── Current Plan ──────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="size-5 text-emerald-600" />
            Current Plan
          </CardTitle>
          <CardDescription>Your active subscription details</CardDescription>
        </CardHeader>
        <CardContent>
          {subscription ? (
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 rounded-lg border border-emerald-200 bg-emerald-50/50 p-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-semibold text-emerald-900">
                    {subscription.plan?.name || 'Active Plan'}
                  </h3>
                  <Badge className="bg-emerald-600 text-white border-emerald-600">
                    Active
                  </Badge>
                </div>
                <p className="text-sm text-emerald-700">
                  ${subscription.plan?.price || '—'}/month
                </p>
                <p className="text-xs text-emerald-600">
                  Renews {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
                </p>
              </div>
              <div className="flex items-center gap-2 text-emerald-700">
                <Check className="size-4" />
                <span className="text-sm">All features included</span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="size-12 rounded-full bg-muted flex items-center justify-center mb-3">
                <CreditCard className="size-6 text-muted-foreground" />
              </div>
              <p className="text-muted-foreground mb-3">No active subscription</p>
              <Button
                onClick={() => {
                  const el = document.getElementById('plan-comparison')
                  el?.scrollIntoView({ behavior: 'smooth' })
                }}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                Choose a Plan
                <ArrowRight className="size-4 ml-1" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Plan Comparison ───────────────────────────────────────── */}
      <div id="plan-comparison">
        <h2 className="text-xl font-semibold mb-4">Plan Comparison</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {PLAN_DEFINITIONS.map((def) => {
            const matchedPlan = plans.find(
              (p) => p.slug === def.slug || p.name.toLowerCase() === def.slug
            )
            const isCurrent = currentPlanSlug === def.slug
            const Icon = def.icon

            return (
              <Card
                key={def.slug}
                className={`relative flex flex-col ${
                  def.highlight
                    ? 'border-2 border-emerald-500 shadow-emerald-100 shadow-lg'
                    : ''
                }`}
              >
                {def.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-emerald-600 text-white border-emerald-600 px-3 py-1 text-xs">
                      POPULAR
                    </Badge>
                  </div>
                )}
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2">
                    <div
                      className={`size-9 rounded-lg flex items-center justify-center ${
                        def.highlight ? 'bg-emerald-100 text-emerald-600' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      <Icon className="size-5" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">{def.name}</CardTitle>
                      <CardDescription>{matchedPlan?.description || `${def.name} plan`}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="flex-1 space-y-4">
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold">${def.price}</span>
                    <span className="text-sm text-muted-foreground">/month</span>
                  </div>
                  <ul className="space-y-2">
                    {def.features.map((f) => (
                      <li key={f} className="flex items-center gap-2 text-sm">
                        <Check className="size-4 text-emerald-500 shrink-0" />
                        {f}
                      </li>
                    ))}
                  </ul>
                </CardContent>
                <CardFooter>
                  {isCurrent ? (
                    <Button variant="outline" className="w-full" disabled>
                      Current Plan
                    </Button>
                  ) : (
                    <Button
                      className={`w-full ${
                        def.highlight
                          ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                          : ''
                      }`}
                      variant={def.highlight ? 'default' : 'outline'}
                      disabled={checkoutLoading !== null}
                      onClick={() => {
                        if (matchedPlan) {
                          handleCheckout(matchedPlan.id, def.name)
                        } else {
                          toast.error('Plan not available')
                        }
                      }}
                    >
                      {checkoutLoading === matchedPlan?.id ? (
                        <span className="flex items-center gap-2">
                          <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                          Processing…
                        </span>
                      ) : (
                        'Select Plan'
                      )}
                    </Button>
                  )}
                </CardFooter>
              </Card>
            )
          })}
        </div>
      </div>

      {/* ── Payment History ───────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="size-5 text-emerald-600" />
            Payment History
          </CardTitle>
          <CardDescription>Your recent transactions</CardDescription>
        </CardHeader>
        <CardContent>
          {payments.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <p className="text-muted-foreground">No payments yet</p>
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="text-muted-foreground">
                        {new Date(p.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        {p.metadata?.planName
                          ? `${p.metadata.planName} Plan`
                          : p.type === 'domain'
                          ? `Domain: ${p.metadata?.domainName || 'Registration'}`
                          : p.type === 'both'
                          ? `Hosting + Domain`
                          : p.type.charAt(0).toUpperCase() + p.type.slice(1)}
                      </TableCell>
                      <TableCell className="font-medium">
                        ${p.amount.toFixed(2)}
                      </TableCell>
                      <TableCell>
                        <PaymentStatusBadge status={p.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
