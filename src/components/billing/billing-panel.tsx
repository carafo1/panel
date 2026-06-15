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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Check,
  CreditCard,
  Zap,
  Crown,
  Building2,
  ArrowRight,
  Globe,
  Server,
  Package,
  ExternalLink,
  Loader2,
  Search,
} from 'lucide-react'
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
  plan?: { name: string; price: number; slug: string; id: string }
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

type PurchaseType = 'hosting' | 'domain' | 'both'

interface CheckoutResult {
  payment: { id: string; amount: number; currency: string; status: string; type: string }
  subscription: { id: string; status: string; planName: string; planId: string } | null
  project?: { id: string; name: string; slug: string; subdomain: string; status: string; framework: string; customDomain: string | null } | null
  domain?: { id: string; name: string; status: string; registrar: string } | null
  deployment?: { id: string; status: string; deployUrl: string | null; branch: string } | null
  automation?: { processed: boolean; actionsCount: number; results: unknown[] }
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

const FRAMEWORKS = [
  { value: 'nextjs', label: 'Next.js' },
  { value: 'react', label: 'React' },
  { value: 'node', label: 'Node.js' },
  { value: 'static', label: 'Static Site' },
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

// ── Checkout Dialog Component ──────────────────────────────────────────
function CheckoutDialog({
  open,
  onOpenChange,
  plan,
  planDefinition,
  onSuccess,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  plan: Plan
  planDefinition: typeof PLAN_DEFINITIONS[number]
  onSuccess: (result: CheckoutResult) => void
}) {
  const [purchaseType, setPurchaseType] = useState<PurchaseType>('hosting')
  const [domainName, setDomainName] = useState('')
  const [projectName, setProjectName] = useState('')
  const [framework, setFramework] = useState('nextjs')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState<CheckoutResult | null>(null)

  const showDomain = purchaseType === 'domain' || purchaseType === 'both'
  const showProject = purchaseType === 'hosting' || purchaseType === 'both'

  const calculateTotal = () => {
    if (purchaseType === 'domain') return 12.99
    if (purchaseType === 'both') return plan.price + 12.99
    return plan.price
  }

  const handlePurchase = async () => {
    if (showDomain && !domainName.trim()) {
      toast.error('Please enter a domain name')
      return
    }
    if (showProject && !projectName.trim()) {
      toast.error('Please enter a project name')
      return
    }

    setLoading(true)
    try {
      const result = await apiFetch<CheckoutResult>('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({
          planId: plan.id,
          type: purchaseType,
          domainName: showDomain ? domainName.trim() : undefined,
          projectName: showProject ? projectName.trim() : undefined,
          framework: showProject ? framework : undefined,
        }),
      })
      setSuccess(result)
      toast.success('Purchase completed successfully!')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Checkout failed')
    } finally {
      setLoading(false)
    }
  }

  const handleClose = () => {
    if (success) {
      onSuccess(success)
    }
    setSuccess(null)
    setPurchaseType('hosting')
    setDomainName('')
    setProjectName('')
    setFramework('nextjs')
    onOpenChange(false)
  }

  const Icon = planDefinition.icon

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        {success ? (
          // ── Success State ──────────────────────────────────────
          <div className="space-y-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-emerald-700">
                <Check className="size-5" />
                Purchase Complete!
              </DialogTitle>
              <DialogDescription>
                Your resources have been provisioned automatically.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 rounded-lg border p-4 bg-emerald-50/50">
              {success.project && (
                <div className="flex items-start gap-3">
                  <Server className="size-5 text-emerald-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-sm">Project Created</p>
                    <p className="text-sm text-muted-foreground">{success.project.name}</p>
                    <p className="text-xs text-emerald-600 mt-1">
                      https://{success.project.subdomain}
                    </p>
                    {success.project.customDomain && (
                      <p className="text-xs text-emerald-600">
                        Custom: {success.project.customDomain}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {success.domain && (
                <div className="flex items-start gap-3">
                  <Globe className="size-5 text-emerald-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-sm">Domain Registered</p>
                    <p className="text-sm text-muted-foreground">{success.domain.name}</p>
                    <p className="text-xs text-emerald-600 mt-1">
                      Status: {success.domain.status}
                    </p>
                  </div>
                </div>
              )}

              {success.deployment && (
                <div className="flex items-start gap-3">
                  <Package className="size-5 text-emerald-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-sm">Initial Deployment</p>
                    <p className="text-xs text-emerald-600 mt-1">
                      Status: {success.deployment.status} | Branch: {success.deployment.branch}
                    </p>
                  </div>
                </div>
              )}

              {success.subscription && (
                <div className="flex items-start gap-3">
                  <CreditCard className="size-5 text-emerald-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-sm">Subscription Active</p>
                    <p className="text-sm text-muted-foreground">
                      {success.subscription.planName} Plan
                    </p>
                  </div>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button onClick={handleClose} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          // ── Checkout Form ──────────────────────────────────────
          <div className="space-y-5">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Icon className="size-5 text-emerald-600" />
                {planDefinition.name} Plan Checkout
              </DialogTitle>
              <DialogDescription>
                Configure your purchase and complete checkout.
              </DialogDescription>
            </DialogHeader>

            {/* Plan summary */}
            <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{planDefinition.name} Plan</span>
                <span className="text-sm font-bold">${planDefinition.price}/mo</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {planDefinition.features.slice(0, 4).map((f) => (
                  <span key={f} className="text-xs bg-background border rounded px-1.5 py-0.5">
                    {f}
                  </span>
                ))}
              </div>
            </div>

            {/* Purchase type selection */}
            <div className="space-y-2">
              <Label>What would you like to purchase?</Label>
              <RadioGroup
                value={purchaseType}
                onValueChange={(v) => setPurchaseType(v as PurchaseType)}
                className="grid grid-cols-3 gap-2"
              >
                <Label
                  htmlFor="type-hosting"
                  className={`flex flex-col items-center gap-1.5 rounded-lg border p-3 cursor-pointer transition-colors hover:bg-emerald-50 ${
                    purchaseType === 'hosting' ? 'border-emerald-500 bg-emerald-50' : ''
                  }`}
                >
                  <RadioGroupItem value="hosting" id="type-hosting" className="sr-only" />
                  <Server className="size-5 text-emerald-600" />
                  <span className="text-xs font-medium text-center">Hosting Only</span>
                  <span className="text-xs text-muted-foreground">${plan.price}/mo</span>
                </Label>
                <Label
                  htmlFor="type-domain"
                  className={`flex flex-col items-center gap-1.5 rounded-lg border p-3 cursor-pointer transition-colors hover:bg-emerald-50 ${
                    purchaseType === 'domain' ? 'border-emerald-500 bg-emerald-50' : ''
                  }`}
                >
                  <RadioGroupItem value="domain" id="type-domain" className="sr-only" />
                  <Globe className="size-5 text-emerald-600" />
                  <span className="text-xs font-medium text-center">Domain Only</span>
                  <span className="text-xs text-muted-foreground">$12.99/yr</span>
                </Label>
                <Label
                  htmlFor="type-both"
                  className={`flex flex-col items-center gap-1.5 rounded-lg border p-3 cursor-pointer transition-colors hover:bg-emerald-50 ${
                    purchaseType === 'both' ? 'border-emerald-500 bg-emerald-50' : ''
                  }`}
                >
                  <RadioGroupItem value="both" id="type-both" className="sr-only" />
                  <Package className="size-5 text-emerald-600" />
                  <span className="text-xs font-medium text-center">Hosting + Domain</span>
                  <span className="text-xs text-muted-foreground">${(plan.price + 12.99).toFixed(2)}</span>
                </Label>
              </RadioGroup>
            </div>

            {/* Domain input */}
            {showDomain && (
              <div className="space-y-2">
                <Label htmlFor="domain-name">Domain Name</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                  <Input
                    id="domain-name"
                    placeholder="example.com"
                    value={domainName}
                    onChange={(e) => setDomainName(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Enter the domain you want to register (e.g., myapp.com)
                </p>
              </div>
            )}

            {/* Project input */}
            {showProject && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="project-name">Project Name</Label>
                  <Input
                    id="project-name"
                    placeholder="My Awesome Project"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    A subdomain will be auto-generated (e.g., my-awesome-project.deployhub.io)
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>Framework</Label>
                  <Select value={framework} onValueChange={setFramework}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select framework" />
                    </SelectTrigger>
                    <SelectContent>
                      {FRAMEWORKS.map((fw) => (
                        <SelectItem key={fw.value} value={fw.value}>
                          {fw.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* Total */}
            <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
              <span className="text-sm font-medium">Total</span>
              <span className="text-lg font-bold text-emerald-700">
                ${calculateTotal().toFixed(2)}
                {purchaseType !== 'domain' ? '/mo' : '/yr'}
              </span>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleClose} disabled={loading}>
                Cancel
              </Button>
              <Button
                onClick={handlePurchase}
                disabled={loading}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    Processing…
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    Complete Purchase
                    <ArrowRight className="size-4" />
                  </span>
                )}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ── Component ──────────────────────────────────────────────────────────
export function BillingPanel() {
  const [plans, setPlans] = useState<Plan[]>([])
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading] = useState(true)
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null)

  // Checkout dialog state
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null)
  const [selectedPlanDef, setSelectedPlanDef] = useState<typeof PLAN_DEFINITIONS[number] | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [plansRes, historyRes, subRes] = await Promise.all([
        apiFetch<{ plans: Plan[] }>('/billing/plans'),
        apiFetch<{ payments: Payment[] }>('/billing/history'),
        apiFetch<{ subscription: Subscription | null }>('/billing/subscription'),
      ])
      setPlans(plansRes.plans)
      setPayments(historyRes.payments)
      setSubscription(subRes.subscription)
    } catch {
      toast.error('Failed to load billing data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleSelectPlan = (plan: Plan, planDef: typeof PLAN_DEFINITIONS[number]) => {
    setSelectedPlan(plan)
    setSelectedPlanDef(planDef)
    setCheckoutOpen(true)
  }

  const handleCheckoutSuccess = (_result: CheckoutResult) => {
    setCheckoutOpen(false)
    setSelectedPlan(null)
    setSelectedPlanDef(null)
    fetchData() // Refresh all data
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
                          handleSelectPlan(matchedPlan, def)
                        } else {
                          // Fallback: create a plan object from the definition
                          const fallbackPlan: Plan = {
                            id: `plan-${def.slug}`,
                            name: def.name,
                            slug: def.slug,
                            description: `${def.name} plan`,
                            price: def.price,
                            ram: def.features[0] || '1GB',
                            cpu: def.features[1] || '1 vCPU',
                            storage: def.features[2] || '10GB',
                            bandwidth: def.features[3] || '100GB',
                            projects: 1,
                            ssl: true,
                            customDomain: def.slug !== 'starter',
                            popular: def.slug === 'pro',
                          }
                          handleSelectPlan(fallbackPlan, def)
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

      {/* ── Checkout Dialog ───────────────────────────────────────── */}
      {selectedPlan && selectedPlanDef && (
        <CheckoutDialog
          open={checkoutOpen}
          onOpenChange={setCheckoutOpen}
          plan={selectedPlan}
          planDefinition={selectedPlanDef}
          onSuccess={handleCheckoutSuccess}
        />
      )}
    </div>
  )
}
