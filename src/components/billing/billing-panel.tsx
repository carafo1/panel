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
  Building,
  Wallet,
  ArrowRight,
  Globe,
  Server,
  Package,
  ExternalLink,
  Loader2,
  Search,
  Settings2,
  Ban,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'

// ── Types ──────────────────────────────────────────────────────────────
interface Plan {
  id: string
  name: string
  slug: string
  description: string
  price: number
  /** Discounted 12-month price. Null when the plan is monthly-only. */
  annualPrice?: number | null
  tagline?: string | null
  badge?: string | null
  ram: string
  cpu: string
  storage: string
  bandwidth: string
  projects: number
  ssl: boolean
  customDomain: boolean
  popular: boolean
  /** Card bullets, authored in Admin → Plans. */
  highlights?: string[]
}

interface Subscription {
  id: string
  planId: string
  status: string
  currentPeriodStart: string
  currentPeriodEnd: string
  cancelAtPeriodEnd?: boolean
  stripeSubId?: string | null
  stripeCustomerId?: string | null
  plan?: { name: string; price: number; slug: string; id: string }
}

interface Payment {
  id: string
  amount: number
  currency: string
  status: string
  type: string
  stripePaymentId?: string | null
  stripeInvoiceId?: string | null
  metadata: { planName?: string; domainName?: string; purchaseType?: string; checkoutSessionId?: string } | null
  createdAt: string
  plan: { name: string; price: number } | null
}

type PurchaseType = 'hosting' | 'domain' | 'both'

interface CheckoutResult {
  // Stripe Checkout fields (real mode)
  sessionId?: string
  url?: string | null
  demo?: boolean
  paymentId?: string
  message?: string
  // Demo-mode success payload
  payment?: { id: string; amount: number; currency: string; status: string; type: string }
  subscription?: { id: string; status: string; planName: string; planId: string } | null
  project?: { id: string; name: string; slug: string; subdomain: string; status: string; framework: string; customDomain: string | null } | null
  domain?: { id: string; name: string; status: string; registrar: string } | null
  deployment?: { id: string; status: string; deployUrl: string | null; branch: string } | null
  automation?: { processed: boolean; actionsCount: number; results: unknown[] }
  // Unified multi-payment fields (#18 / #22)
  method?: string // "stripe" | "waafi" | "manual"
  status?: string // "redirect_required" | "pending" | "completed"
  redirectUrl?: string | null
  transactionId?: string
  // Offline / bank-transfer details the admin configured, so the customer
  // knows where to send the money and which reference to quote.
  paymentDetails?: {
    reference?: string | null
    instructions?: string | null
    accounts?: Array<{
      label?: string | null
      type?: string | null
      accountName?: string | null
      accountNumber?: string | null
      iban?: string | null
      swift?: string | null
      phone?: string | null
      note?: string | null
    }> | null
  } | null
}

interface PortalResult {
  url: string | null
  demo?: boolean
  message?: string
  subscription?: {
    id: string
    status: string
    planName: string
    currentPeriodEnd: string
    cancelAtPeriodEnd: boolean
  }
}

// ── API helper ─────────────────────────────────────────────────────────
async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('apsamo_token')
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

/**
 * Presentation only — icon and emphasis for a plan card.
 *
 * There used to be a hardcoded PLAN_DEFINITIONS catalogue here (Starter $9,
 * Pro $29, Business $79) that the tab rendered and then tried to match against
 * the real plans by slug. Once the catalogue was renamed to
 * starter/professional/enterprise, two of the three cards matched nothing:
 * they advertised invented prices and, on click, fabricated a Plan with a fake
 * id like "plan-pro" that checkout rejected as not found.
 *
 * Cards are now rendered straight from /api/billing/plans. This only decides
 * which icon to draw.
 */
const PLAN_ICONS: React.ElementType[] = [Zap, Crown, Building2]

function planIcon(index: number): React.ElementType {
  return PLAN_ICONS[index] ?? Building2
}

/** Card bullets: authored in Admin → Plans, with a spec-derived fallback. */
function planFeatures(plan: Plan): string[] {
  if (plan.highlights && plan.highlights.length > 0) return plan.highlights
  return [plan.ram, plan.cpu, plan.storage, plan.bandwidth].filter(Boolean)
}

const FRAMEWORKS = [
  { value: 'nextjs', label: 'Next.js' },
  { value: 'react', label: 'React' },
  { value: 'node', label: 'Node.js' },
  { value: 'static', label: 'Static Site' },
]

// ── Payment method helpers ─────────────────────────────────────────────
interface PaymentMethodOption {
  method: string // "stripe" | "waafi" | "manual"
  displayName: string
  icon: string | null
  sortOrder: number
  config: Record<string, unknown> | null
}

const METHOD_ICON_MAP: Record<string, React.ElementType> = {
  'credit-card': CreditCard,
  creditcard: CreditCard,
  stripe: CreditCard,
  card: CreditCard,
  wallet: Wallet,
  waafi: Wallet,
  banknote: Building,
  bank: Building,
  building: Building,
  manual: Building,
}

function getMethodIcon(method: string, icon: string | null): React.ElementType {
  if (icon) {
    const key = icon.toLowerCase().trim()
    if (METHOD_ICON_MAP[key]) return METHOD_ICON_MAP[key]
  }
  if (method === 'stripe') return CreditCard
  if (method === 'waafi') return Wallet
  if (method === 'manual') return Building
  return CreditCard
}

// ── Status badge helper ────────────────────────────────────────────────
function PaymentStatusBadge({ status }: { status: string }) {
  const map: Record<string, { className: string; label: string }> = {
    completed: { className: 'bg-indigo-100 text-indigo-700 border-indigo-200', label: 'Completed' },
    pending: { className: 'bg-yellow-100 text-yellow-700 border-yellow-200', label: 'Pending' },
    failed: { className: 'bg-red-100 text-red-700 border-red-200', label: 'Failed' },
    refunded: { className: 'bg-gray-100 text-gray-700 border-gray-200', label: 'Refunded' },
    past_due: { className: 'bg-orange-100 text-orange-700 border-orange-200', label: 'Past Due' },
    cancelled: { className: 'bg-gray-100 text-gray-700 border-gray-200', label: 'Cancelled' },
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
  planIndex,
  onSuccess,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  plan: Plan
  planIndex: number
  onSuccess: (result: CheckoutResult) => void
}) {
  const [purchaseType, setPurchaseType] = useState<PurchaseType>('hosting')
  const [domainName, setDomainName] = useState('')
  const [projectName, setProjectName] = useState('')
  const [framework, setFramework] = useState('nextjs')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState<CheckoutResult | null>(null)

  // Payment-method selection state.
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodOption[]>([])
  const [selectedMethod, setSelectedMethod] = useState<string>('')
  const [methodsLoading, setMethodsLoading] = useState(false)
  const [methodsError, setMethodsError] = useState<string | null>(null)

  // Fetch active payment methods whenever the dialog opens. Public endpoint
  // (no auth) — returns the methods the super admin has enabled.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setMethodsLoading(true)
    setMethodsError(null)
    fetch('/api/billing/methods')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('Failed to load payment methods'))))
      .then((data: { methods: PaymentMethodOption[] }) => {
        if (cancelled) return
        const methods = data.methods || []
        setPaymentMethods(methods)
        // Auto-select when there's exactly one active method.
        if (methods.length === 1) {
          setSelectedMethod(methods[0]!.method)
        } else if (methods.length > 0 && !methods.find((m) => m.method === selectedMethod)) {
          // Default to the first method if the current selection is no longer valid.
          setSelectedMethod(methods[0]!.method)
        }
      })
      .catch((err) => {
        if (cancelled) return
        setMethodsError(err instanceof Error ? err.message : 'Failed to load payment methods')
        setPaymentMethods([])
      })
      .finally(() => {
        if (!cancelled) setMethodsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const showDomain = purchaseType === 'domain' || purchaseType === 'both'
  const showProject = purchaseType === 'hosting' || purchaseType === 'both'

  /**
   * Real registration price for the typed domain.
   *
   * This dialog used to display a flat $12.99 for every domain while checkout
   * charged the per-TLD price from the catalogue — so a customer buying a .ai
   * was shown $12.99 and billed $95.60. Quote the same source checkout bills
   * from, and show nothing rather than a guess until we have it.
   */
  const [domainQuote, setDomainQuote] = useState<number | null>(null)
  const [quoting, setQuoting] = useState(false)

  useEffect(() => {
    const candidate = domainName.trim().toLowerCase()
    if (!showDomain || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(candidate)) {
      setDomainQuote(null)
      return
    }
    let cancelled = false
    setQuoting(true)
    // Debounced: the customer is still typing, and each call prices a TLD.
    const timer = setTimeout(() => {
      apiFetch<{ quote?: { total: number } }>(
        `/domains/checkout?domain=${encodeURIComponent(candidate)}&kind=register&years=1`
      )
        .then((data) => {
          if (!cancelled) setDomainQuote(data.quote?.total ?? null)
        })
        .catch(() => {
          if (!cancelled) setDomainQuote(null)
        })
        .finally(() => {
          if (!cancelled) setQuoting(false)
        })
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [domainName, showDomain])

  /**
   * Total for the current selection, or null while the domain price is unknown.
   * Callers must render "—" for null rather than substituting a placeholder
   * number — that substitution is what produced the mismatch above.
   */
  const calculateTotal = (): number | null => {
    if (purchaseType === 'hosting') return plan.price
    if (domainQuote === null) return null
    return purchaseType === 'domain' ? domainQuote : plan.price + domainQuote
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
    if (!selectedMethod) {
      toast.error('Please select a payment method')
      return
    }

    setLoading(true)
    try {
      const result = await apiFetch<CheckoutResult>('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({
          planId: plan.id,
          type: purchaseType,
          method: selectedMethod,
          domainName: showDomain ? domainName.trim() : undefined,
          projectName: showProject ? projectName.trim() : undefined,
          framework: showProject ? framework : undefined,
        }),
      })

      // ── Manual payment: status 'pending' — no resources provisioned yet.
      // Show the pending state with bank details / reference number.
      if (result.status === 'pending' && result.method === 'manual') {
        setSuccess(result)
        toast.success('Payment recorded. Awaiting admin confirmation.')
        return
      }

      // ── Real Stripe mode: redirect to Stripe Checkout ─────────
      // Backward-compat: existing demo-mode response has `demo: true` +
      // provisioned resources. Real Stripe responses have a `url`.
      if (!result.demo && result.url) {
        toast.success('Redirecting to Stripe Checkout…')
        try {
          sessionStorage.setItem('apsamo_pending_checkout', result.sessionId || '1')
        } catch {
          /* ignore */
        }
        window.location.href = result.url
        return
      }

      // ── Waafi (or any unified redirect_required response) ──────
      if (result.status === 'redirect_required' && result.redirectUrl) {
        toast.success('Redirecting to payment gateway…')
        window.location.href = result.redirectUrl
        return
      }

      // ── Demo mode: show the in-app success dialog ─────────────
      setSuccess(result)
      toast.success('Purchase completed successfully! (demo mode)')
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
    setSelectedMethod('')
    onOpenChange(false)
  }

  const Icon = planIcon(planIndex)

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        {success ? (
          // ── Success State ──────────────────────────────────────
          <div className="space-y-4">
            {/* ── Manual payment pending ── */}
            {success.method === 'manual' && success.status === 'pending' ? (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-amber-700">
                    <AlertTriangle className="size-5" />
                    Payment Awaiting Confirmation
                  </DialogTitle>
                  <DialogDescription>
                    Your manual payment has been recorded. Your subscription
                    will be activated once an admin confirms the transfer.
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/50 p-4">
                  <div className="flex items-start gap-3">
                    <Building className="size-5 text-amber-600 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-sm">Reference Number</p>
                      <p className="text-sm font-mono text-amber-700 mt-0.5">
                        {success.transactionId || '—'}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Include this reference on your bank transfer so we can
                        match it to your account.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <CreditCard className="size-5 text-amber-600 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-sm">Amount Due</p>
                      <p className="text-sm text-amber-700 mt-0.5">
                        {calculateTotal() === null
                          ? '—'
                          : `$${calculateTotal()!.toFixed(2)}`}{' '}
                        {calculateTotal() !== null &&
                          (purchaseType !== 'domain' ? '/mo' : '/yr')}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Where to send the money — configured by the admin under
                    Admin → Payment Methods → Manual. */}
                {(() => {
                  const d = success.paymentDetails
                  if (!d) return null
                  const accounts = (d.accounts || []).filter((a) => a && a.label)
                  if (!accounts.length && !d.instructions) return null
                  return (
                    <div className="space-y-3 rounded-lg border p-4">
                      {accounts.length > 0 && (
                        <div className="space-y-3">
                          <p className="font-medium text-sm">
                            {accounts.length > 1
                              ? 'Pay to any one of these accounts'
                              : 'Where to send your payment'}
                          </p>
                          {accounts.map((acc, i) => {
                            const rows: Array<[string, string | null | undefined]> = [
                              ['Account holder', acc.accountName],
                              ['Account number', acc.accountNumber],
                              ['IBAN', acc.iban],
                              ['SWIFT / BIC', acc.swift],
                              ['Number', acc.phone],
                              ['Details', acc.note],
                            ]
                            const shown = rows.filter(([, v]) => v && String(v).trim())
                            return (
                              <div
                                key={i}
                                className="rounded-md border bg-muted/30 p-3"
                              >
                                <p className="text-sm font-medium mb-1.5">
                                  {acc.label}
                                </p>
                                <dl className="space-y-1">
                                  {shown.map(([label, value]) => (
                                    <div
                                      key={label}
                                      className="flex justify-between gap-4 text-sm"
                                    >
                                      <dt className="text-muted-foreground shrink-0">
                                        {label}
                                      </dt>
                                      <dd className="font-mono text-right break-all">
                                        {value}
                                      </dd>
                                    </div>
                                  ))}
                                </dl>
                              </div>
                            )
                          })}
                        </div>
                      )}
                      {d.instructions && (
                        <div className="text-sm whitespace-pre-line border-t pt-3">
                          {d.instructions}
                        </div>
                      )}
                    </div>
                  )
                })()}

                <p className="text-xs text-muted-foreground">
                  You will receive an email notification once the payment is
                  verified. You can close this dialog — your pending payment is
                  visible in the Payment History table.
                </p>

                <DialogFooter>
                  <Button
                    onClick={handleClose}
                    className="bg-amber-600 hover:bg-amber-700 text-white"
                  >
                    Done
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-indigo-700">
                    <Check className="size-5" />
                    Purchase Complete!
                  </DialogTitle>
                  <DialogDescription>
                    Your resources have been provisioned automatically.
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-3 rounded-lg border p-4 bg-indigo-50/50">
                  {success.project && (
                    <div className="flex items-start gap-3">
                      <Server className="size-5 text-indigo-600 mt-0.5 shrink-0" />
                      <div>
                        <p className="font-medium text-sm">Project Created</p>
                        <p className="text-sm text-muted-foreground">{success.project.name}</p>
                        <p className="text-xs text-indigo-600 mt-1">
                          https://{success.project.subdomain}
                        </p>
                        {success.project.customDomain && (
                          <p className="text-xs text-indigo-600">
                            Custom: {success.project.customDomain}
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {success.domain && (
                    <div className="flex items-start gap-3">
                      <Globe className="size-5 text-indigo-600 mt-0.5 shrink-0" />
                      <div>
                        <p className="font-medium text-sm">Domain Registered</p>
                        <p className="text-sm text-muted-foreground">{success.domain.name}</p>
                        <p className="text-xs text-indigo-600 mt-1">
                          Status: {success.domain.status}
                        </p>
                      </div>
                    </div>
                  )}

                  {success.deployment && (
                    <div className="flex items-start gap-3">
                      <Package className="size-5 text-indigo-600 mt-0.5 shrink-0" />
                      <div>
                        <p className="font-medium text-sm">Initial Deployment</p>
                        <p className="text-xs text-indigo-600 mt-1">
                          Status: {success.deployment.status} | Branch: {success.deployment.branch}
                        </p>
                      </div>
                    </div>
                  )}

                  {success.subscription && (
                    <div className="flex items-start gap-3">
                      <CreditCard className="size-5 text-indigo-600 mt-0.5 shrink-0" />
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
                  <Button onClick={handleClose} className="bg-indigo-600 hover:bg-indigo-700 text-white">
                    Done
                  </Button>
                </DialogFooter>
              </>
            )}
          </div>
        ) : (
          // ── Checkout Form ──────────────────────────────────────
          <div className="space-y-5">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Icon className="size-5 text-indigo-600" />
                {plan.name} Plan Checkout
              </DialogTitle>
              <DialogDescription>
                Configure your purchase and complete checkout.
              </DialogDescription>
            </DialogHeader>

            {/* Plan summary */}
            <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{plan.name} Plan</span>
                <span className="text-sm font-bold">${plan.price.toFixed(2)}/mo</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {planFeatures(plan).slice(0, 4).map((f) => (
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
                  className={`flex flex-col items-center gap-1.5 rounded-lg border p-3 cursor-pointer transition-colors hover:bg-indigo-50 ${
                    purchaseType === 'hosting' ? 'border-indigo-500 bg-indigo-50' : ''
                  }`}
                >
                  <RadioGroupItem value="hosting" id="type-hosting" className="sr-only" />
                  <Server className="size-5 text-indigo-600" />
                  <span className="text-xs font-medium text-center">Hosting Only</span>
                  <span className="text-xs text-muted-foreground">${plan.price}/mo</span>
                </Label>
                <Label
                  htmlFor="type-domain"
                  className={`flex flex-col items-center gap-1.5 rounded-lg border p-3 cursor-pointer transition-colors hover:bg-indigo-50 ${
                    purchaseType === 'domain' ? 'border-indigo-500 bg-indigo-50' : ''
                  }`}
                >
                  <RadioGroupItem value="domain" id="type-domain" className="sr-only" />
                  <Globe className="size-5 text-indigo-600" />
                  <span className="text-xs font-medium text-center">Domain Only</span>
                  <span className="text-xs text-muted-foreground">price by extension</span>
                </Label>
                <Label
                  htmlFor="type-both"
                  className={`flex flex-col items-center gap-1.5 rounded-lg border p-3 cursor-pointer transition-colors hover:bg-indigo-50 ${
                    purchaseType === 'both' ? 'border-indigo-500 bg-indigo-50' : ''
                  }`}
                >
                  <RadioGroupItem value="both" id="type-both" className="sr-only" />
                  <Package className="size-5 text-indigo-600" />
                  <span className="text-xs font-medium text-center">Hosting + Domain</span>
                  <span className="text-xs text-muted-foreground">
                    ${plan.price.toFixed(2)} + domain
                  </span>
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
                    A subdomain will be auto-generated (e.g., my-awesome-project.apsamo.com)
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

            {/* Payment method picker */}
            <div className="space-y-2">
              <Label>Payment Method</Label>
              {methodsLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground rounded-lg border p-3">
                  <Loader2 className="size-4 animate-spin" />
                  Loading payment methods…
                </div>
              ) : methodsError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {methodsError}
                </div>
              ) : paymentMethods.length === 0 ? (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
                  <AlertTriangle className="size-4 mt-0.5 shrink-0" />
                  <div>
                    <span className="font-semibold">
                      No payment methods available.
                    </span>{' '}
                    Contact support to complete your purchase.
                  </div>
                </div>
              ) : (
                <RadioGroup
                  value={selectedMethod}
                  onValueChange={setSelectedMethod}
                  className={`grid gap-2 ${
                    paymentMethods.length === 1
                      ? 'grid-cols-1'
                      : paymentMethods.length === 2
                        ? 'grid-cols-2'
                        : 'grid-cols-1 sm:grid-cols-3'
                  }`}
                >
                  {paymentMethods.map((m) => {
                    const MethodIcon = getMethodIcon(m.method, m.icon)
                    const isSelected = selectedMethod === m.method
                    return (
                      <Label
                        key={m.method}
                        htmlFor={`pm-${m.method}`}
                        className={`flex flex-col items-center gap-1.5 rounded-lg border p-3 cursor-pointer transition-colors hover:bg-indigo-50 ${
                          isSelected ? 'border-indigo-500 bg-indigo-50' : ''
                        }`}
                      >
                        <RadioGroupItem
                          value={m.method}
                          id={`pm-${m.method}`}
                          className="sr-only"
                        />
                        <MethodIcon className="size-5 text-indigo-600" />
                        <span className="text-xs font-medium text-center leading-tight">
                          {m.displayName}
                        </span>
                      </Label>
                    )
                  })}
                </RadioGroup>
              )}
              {selectedMethod === 'manual' && paymentMethods.find((m) => m.method === 'manual') && (
                <p className="text-xs text-muted-foreground">
                  Manual payments are confirmed by an admin after proof of
                  transfer is received. Your subscription activates after
                  confirmation.
                </p>
              )}
            </div>

            {/* Total */}
            <div className="flex items-center justify-between rounded-lg border border-indigo-200 bg-indigo-50/50 p-3">
              <span className="text-sm font-medium">Total</span>
              <span className="text-lg font-bold text-indigo-700">
                {quoting
                  ? 'pricing…'
                  : calculateTotal() === null
                  ? 'enter a domain'
                  : `$${calculateTotal()!.toFixed(2)}${
                      purchaseType !== 'domain' ? '/mo' : '/yr'
                    }`}
              </span>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleClose} disabled={loading}>
                Cancel
              </Button>
              <Button
                onClick={handlePurchase}
                disabled={
                  loading ||
                  methodsLoading ||
                  !!methodsError ||
                  paymentMethods.length === 0 ||
                  !selectedMethod
                }
                className="bg-indigo-600 hover:bg-indigo-700 text-white"
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
  const [portalLoading, setPortalLoading] = useState(false)
  const [cancelLoading, setCancelLoading] = useState(false)

  // Checkout dialog state
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null)
  const [selectedPlanIndex, setSelectedPlanIndex] = useState(0)

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

  // ── Refresh data after Stripe Checkout redirect ──────────────
  // Note: toast notifications + URL cleanup are handled centrally by the
  // root page (src/app/page.tsx). Here we only refresh billing data so the
  // newly-completed payment/subscription is shown.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    const paymentStatus = url.searchParams.get('payment')
    if (paymentStatus === 'success') {
      fetchData()
    }
  }, [fetchData])

  const handleSelectPlan = (plan: Plan, index: number) => {
    setSelectedPlan(plan)
    setSelectedPlanIndex(index)
    setCheckoutOpen(true)
  }

  const handleCheckoutSuccess = (_result: CheckoutResult) => {
    setCheckoutOpen(false)
    setSelectedPlan(null)
    setSelectedPlanIndex(0)
    fetchData() // Refresh all data
  }

  // ── Open Stripe Customer Portal ──────────────────────────────
  const handleManageSubscription = async () => {
    setPortalLoading(true)
    try {
      const result = await apiFetch<PortalResult>('/billing/portal', {
        method: 'POST',
      })
      if (result.url) {
        window.location.href = result.url
        return
      }
      // Demo mode - show the explanatory message
      if (result.message) {
        toast.info(result.message)
      } else {
        toast.info('Customer portal is not available in demo mode.')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to open customer portal')
    } finally {
      setPortalLoading(false)
    }
  }

  // ── Cancel the user's active subscription ────────────────────
  const handleCancelSubscription = async () => {
    if (!subscription) return
    const confirmed = window.confirm(
      `Cancel your ${subscription.plan?.name || 'current'} subscription? ` +
      `You'll retain access until ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}.`
    )
    if (!confirmed) return

    setCancelLoading(true)
    try {
      await apiFetch<{ cancelled: boolean; cancelledViaStripe: boolean; activeUntil: string }>(
        '/billing/subscription',
        { method: 'DELETE' }
      )
      toast.success('Subscription cancelled. Access remains until the end of the current period.')
      await fetchData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to cancel subscription')
    } finally {
      setCancelLoading(false)
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
            <CreditCard className="size-5 text-indigo-600" />
            Current Plan
          </CardTitle>
          <CardDescription>Your active subscription details</CardDescription>
        </CardHeader>
        <CardContent>
          {subscription ? (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 rounded-lg border border-indigo-200 bg-indigo-50/50 p-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-lg font-semibold text-indigo-900">
                      {subscription.plan?.name || 'Active Plan'}
                    </h3>
                    <Badge
                      className={
                        subscription.status === 'active'
                          ? 'bg-indigo-600 text-white border-indigo-600'
                          : subscription.status === 'past_due'
                          ? 'bg-red-100 text-red-700 border-red-200'
                          : subscription.status === 'pending'
                          ? 'bg-yellow-100 text-yellow-700 border-yellow-200'
                          : 'bg-gray-100 text-gray-700 border-gray-200'
                      }
                    >
                      {subscription.status === 'past_due'
                        ? 'Past Due'
                        : subscription.status === 'pending'
                        ? 'Pending'
                        : subscription.cancelAtPeriodEnd
                        ? 'Cancelling'
                        : 'Active'}
                    </Badge>
                    {subscription.stripeSubId && (
                      <Badge variant="outline" className="bg-white/70 border-indigo-200 text-indigo-700 gap-1">
                        <ShieldCheck className="size-3" />
                        Stripe
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-indigo-700">
                    ${subscription.plan?.price || '—'}/month
                  </p>
                  <p className="text-xs text-indigo-600">
                    {subscription.cancelAtPeriodEnd
                      ? `Cancels on ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`
                      : `Renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`}
                  </p>
                </div>
                <div className="flex items-center gap-2 text-indigo-700">
                  <Check className="size-4" />
                  <span className="text-sm">All features included</span>
                </div>
              </div>

              {/* Subscription management actions */}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleManageSubscription}
                  disabled={portalLoading}
                >
                  {portalLoading ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="size-4 animate-spin" />
                      Opening…
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Settings2 className="size-4" />
                      Manage Subscription
                    </span>
                  )}
                </Button>
                {!subscription.cancelAtPeriodEnd && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCancelSubscription}
                    disabled={cancelLoading}
                    className="text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
                  >
                    {cancelLoading ? (
                      <span className="flex items-center gap-2">
                        <Loader2 className="size-4 animate-spin" />
                        Cancelling…
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <Ban className="size-4" />
                        Cancel Subscription
                      </span>
                    )}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  asChild
                >
                  <a
                    href="#plan-comparison"
                    className="flex items-center gap-2"
                  >
                    <ArrowRight className="size-4" />
                    Change Plan
                  </a>
                </Button>
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
                className="bg-indigo-600 hover:bg-indigo-700 text-white"
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
          {plans.map((plan, index) => {
            const isCurrent = currentPlanSlug === plan.slug
            const Icon = planIcon(index)
            const featured = plan.popular || Boolean(plan.badge)
            const yearlySaving =
              plan.annualPrice && plan.price * 12 > plan.annualPrice
                ? Math.round(((plan.price * 12 - plan.annualPrice) / (plan.price * 12)) * 100)
                : null

            return (
              <Card
                key={plan.id}
                className={`relative flex flex-col ${
                  featured ? 'border-2 border-indigo-500 shadow-indigo-100 shadow-lg' : ''
                }`}
              >
                {featured && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap">
                    <Badge className="bg-indigo-600 text-white border-indigo-600 px-3 py-1 text-xs">
                      {plan.badge || 'POPULAR'}
                    </Badge>
                  </div>
                )}
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2">
                    <div
                      className={`size-9 rounded-lg flex items-center justify-center ${
                        featured ? 'bg-indigo-100 text-indigo-600' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      <Icon className="size-5" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">{plan.name}</CardTitle>
                      <CardDescription>{plan.tagline || plan.description}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="flex-1 space-y-4">
                  <div>
                    <div className="flex items-baseline gap-1">
                      <span className="text-3xl font-bold">${plan.price.toFixed(2)}</span>
                      <span className="text-sm text-muted-foreground">/month</span>
                    </div>
                    {plan.annualPrice ? (
                      <p className="text-xs text-muted-foreground mt-1">
                        or ${plan.annualPrice.toFixed(2)}/year
                        {yearlySaving ? ` · save ${yearlySaving}%` : ''}
                      </p>
                    ) : null}
                  </div>
                  <ul className="space-y-2">
                    {planFeatures(plan).map((f) => (
                      <li key={f} className="flex items-center gap-2 text-sm">
                        <Check className="size-4 text-indigo-500 shrink-0" />
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
                        featured ? 'bg-indigo-600 hover:bg-indigo-700 text-white' : ''
                      }`}
                      variant={featured ? 'default' : 'outline'}
                      disabled={checkoutLoading !== null}
                      onClick={() => handleSelectPlan(plan, index)}
                    >
                      {checkoutLoading === plan.id ? (
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
            <CreditCard className="size-5 text-indigo-600" />
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
                    <TableHead className="hidden md:table-cell">Transaction ID</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((p) => {
                    const txId =
                      p.stripePaymentId ||
                      p.stripeInvoiceId ||
                      (p.metadata?.checkoutSessionId as string | undefined) ||
                      '—'
                    return (
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
                        <TableCell className="hidden md:table-cell font-mono text-xs text-muted-foreground max-w-[180px] truncate" title={txId}>
                          {txId}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Checkout Dialog ───────────────────────────────────────── */}
      {selectedPlan && (
        <CheckoutDialog
          open={checkoutOpen}
          onOpenChange={setCheckoutOpen}
          plan={selectedPlan}
          planIndex={selectedPlanIndex}
          onSuccess={handleCheckoutSuccess}
        />
      )}
    </div>
  )
}
