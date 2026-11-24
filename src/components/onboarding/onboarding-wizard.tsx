'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Rocket,
  ArrowRight,
  ArrowLeft,
  Check,
  Triangle,
  Hexagon,
  FileCode,
  Layout,
  Search,
  Globe,
  Star,
  Quote,
  Sparkles,
  ExternalLink,
  Loader2,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useAuthStore } from '@/store/auth-store'
import { useAppStore } from '@/store/app-store'
import { toast } from 'sonner'
import {
  availabilityOf, availabilityErrorFromResponse, AvailabilityIcon, AVAILABILITY_COPY,
  type AvailabilityState,
} from '@/components/domains/domain-availability'

/* ── Types ── */
interface FrameworkOption {
  id: string
  name: string
  icon: React.ElementType
  description: string
  color: string
}

/**
 * POST /api/domains/search (single). `price` is set only for an available,
 * sellable name; premium names come back with available=true but are NOT
 * purchasable here. 503 means availability could not be confirmed.
 */
interface DomainResult {
  domain: string
  available: boolean | null
  premium?: boolean
  status?: 'available' | 'unavailable' | 'premium' | 'unknown'
  sellable?: boolean
  price: number | null
  message: string
  suggestions?: Array<{
    domain: string
    available: boolean | null
    status?: 'available' | 'unavailable' | 'premium' | 'unknown'
    price: number | null
  }>
}

/** What the hosting checkout answered, for the final step. */
type DeployOutcome = 'live' | 'awaiting_payment'

interface PlanOption {
  id: string
  name: string
  price: number
  description: string
  features: string[]
  popular?: boolean
}

/* ── Data ── */
const FRAMEWORKS: FrameworkOption[] = [
  { id: 'nextjs', name: 'Next.js', icon: Triangle, description: 'Full-stack React framework with SSR', color: 'text-black dark:text-white' },
  { id: 'react', name: 'React', icon: Hexagon, description: 'Client-side SPA with React', color: 'text-indigo-500' },
  { id: 'nodejs', name: 'Node.js', icon: FileCode, description: 'Backend API server', color: 'text-indigo-600' },
  { id: 'static', name: 'Static', icon: Layout, description: 'HTML/CSS/JS static site', color: 'text-indigo-500' },
]

const STEP_LABELS = ['Welcome', 'Project', 'Domain', 'Plan', 'Deploy']

/* ── Confetti particles ── */
function ConfettiEffect() {
  const particles = Array.from({ length: 30 }, (_, i) => ({
    id: i,
    left: `${Math.random() * 100}%`,
    delay: `${Math.random() * 0.8}s`,
    color: ['#10b981', '#34d399', '#6ee7b7', '#fbbf24', '#f59e0b', '#8b5cf6', '#ec4899'][i % 7],
    size: Math.random() * 8 + 4,
  }))

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {particles.map((p) => (
        <div
          key={p.id}
          className="absolute animate-confetti"
          style={{
            left: p.left,
            top: '30%',
            animationDelay: p.delay,
            width: p.size,
            height: p.size,
            backgroundColor: p.color,
            borderRadius: Math.random() > 0.5 ? '50%' : '2px',
          }}
        />
      ))}
    </div>
  )
}

/* ── Domain option row ── */
function DomainOption({
  domain,
  state,
  price,
  selected,
  onChoose,
}: {
  domain: string
  state: AvailabilityState
  price: number | null
  selected: boolean
  onChoose: (domain: string, price: number) => void
}) {
  const buyable = state === 'available' && typeof price === 'number' && price > 0
  return (
    <li>
      <button
        type="button"
        disabled={!buyable}
        aria-pressed={buyable ? selected : undefined}
        onClick={() => {
          if (buyable) onChoose(domain, price)
        }}
        className={`w-full flex items-center justify-between gap-3 p-3 rounded-lg border-2 text-start transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          !buyable
            ? 'border-border opacity-70 cursor-not-allowed'
            : selected
              ? 'border-indigo-500 bg-indigo-500/5'
              : 'border-border hover:border-indigo-500/30'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <AvailabilityIcon
            state={state}
            className={`size-4 shrink-0 ${buyable ? 'text-indigo-500' : 'text-muted-foreground'}`}
          />
          <span className="font-medium text-sm truncate">{domain}</span>
          <Badge
            variant="secondary"
            className={`text-[10px] ${buyable ? 'bg-indigo-500/10 text-indigo-600' : ''}`}
          >
            {AVAILABILITY_COPY[state].label}
          </Badge>
        </div>
        {buyable ? (
          <span className="font-semibold text-indigo-600 shrink-0">${price.toFixed(2)}/yr</span>
        ) : state === 'unknown' ? (
          <span className="text-xs text-muted-foreground shrink-0 hidden sm:inline">Try again later</span>
        ) : null}
      </button>
    </li>
  )
}

/* ── Main Component ── */
interface OnboardingWizardProps {
  onComplete: () => void
  onSkip: () => void
}

export default function OnboardingWizard({ onComplete, onSkip }: OnboardingWizardProps) {
  const [step, setStep] = useState(1)
  const [projectName, setProjectName] = useState('my-first-app')
  const [framework, setFramework] = useState('nextjs')
  const [domainSearch, setDomainSearch] = useState('')
  const [domainResults, setDomainResults] = useState<DomainResult | null>(null)
  const [domainError, setDomainError] = useState<string | null>(null)
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null)
  const [selectedDomainPrice, setSelectedDomainPrice] = useState<number | null>(null)
  const [deployOutcome, setDeployOutcome] = useState<DeployOutcome>('live')
  const [useFreeSubdomain, setUseFreeSubdomain] = useState(false)
  const [plans, setPlans] = useState<PlanOption[]>([])
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null)
  const [deploying, setDeploying] = useState(false)
  const [deploySuccess, setDeploySuccess] = useState(false)
  const [deployUrl, setDeployUrl] = useState('')
  const [searchingDomain, setSearchingDomain] = useState(false)
  const [loadingPlans, setLoadingPlans] = useState(false)
  const { isAuthenticated } = useAuthStore()
  const { setDashboardTab } = useAppStore()

  // Fetch plans on mount
  useEffect(() => {
    async function fetchPlans() {
      setLoadingPlans(true)
      try {
        const res = await fetch('/api/billing/plans')
        const data = await res.json()
        if (data.plans) {
          const mapped = data.plans.map((p: Record<string, unknown>) => ({
            id: p.id as string,
            name: p.name as string,
            price: p.price as number,
            description: p.name === 'Starter'
              ? 'Perfect for side projects'
              : p.name === 'Pro'
                ? 'For growing teams and businesses'
                : 'For large-scale operations',
            features: Array.isArray(p.features) ? p.features as string[] : [],
            popular: p.name === 'Pro',
          }))
          setPlans(mapped)
          setSelectedPlan(mapped.find((p: PlanOption) => p.name === 'Starter')?.id || mapped[0]?.id || null)
        }
      } catch {
        // fallback plans
        const fallback = [
          { id: 'starter', name: 'Starter', price: 9, description: 'Perfect for side projects', features: ['1GB RAM', '1 vCPU', '10GB Storage', '1 Project', 'Free SSL'], popular: false },
          { id: 'pro', name: 'Pro', price: 29, description: 'For growing teams', features: ['4GB RAM', '2 vCPU', '50GB Storage', '5 Projects', 'Free SSL', 'Custom Domains'], popular: true },
          { id: 'business', name: 'Business', price: 79, description: 'For large-scale operations', features: ['16GB RAM', '4 vCPU', '200GB Storage', 'Unlimited Projects', 'Free SSL', 'Custom Domains', 'Priority Support'], popular: false },
        ]
        setPlans(fallback)
        setSelectedPlan('starter')
      }
      setLoadingPlans(false)
    }
    fetchPlans()
  }, [])

  // Search domains
  const handleDomainSearch = useCallback(async () => {
    if (!domainSearch.trim()) return
    setSearchingDomain(true)
    setDomainError(null)
    setDomainResults(null)
    setSelectedDomain(null)
    setSelectedDomainPrice(null)
    try {
      const res = await fetch('/api/domains/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domainSearch.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        // 503 (registrar unreachable), 429 (rate limited), 400 (bad input):
        // never render these as a result.
        setDomainError(availabilityErrorFromResponse(res.status, data))
      } else {
        setDomainResults(data as DomainResult)
        setUseFreeSubdomain(false)
      }
    } catch {
      setDomainError(AVAILABILITY_COPY.unknown.detail)
    }
    setSearchingDomain(false)
  }, [domainSearch])

  const chooseDomain = (domain: string, price: number) => {
    setSelectedDomain(domain)
    setSelectedDomainPrice(price)
    setUseFreeSubdomain(false)
  }

  /** Close the wizard and open the domain search with the chosen name. */
  const registerChosenDomain = () => {
    if (selectedDomain) {
      try {
        const url = new URL(window.location.href)
        url.searchParams.set('register', selectedDomain)
        window.history.replaceState({}, '', `${url.pathname}${url.search}`)
      } catch {
        /* no pre-fill; the Domains page still opens */
      }
    }
    onComplete()
    setDashboardTab('domains')
  }

  // Deploy
  //
  // The checkout buys HOSTING only. It no longer accepts type 'both' and will
  // not register a domain itself (that needs the registrant contact and goes
  // through the domain-order checkout), so a chosen domain is registered as a
  // separate order from the Domains page once the site exists.
  const handleDeploy = useCallback(async () => {
    if (!selectedPlan || !isAuthenticated) return
    setDeploying(true)
    try {
      const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId: selectedPlan,
          type: 'hosting',
          projectName,
          framework,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        // 400 (invalid plan / input), 402, 403 (email not verified), 409…
        // The server's message says what to fix.
        toast.error('Could not start your plan', {
          description:
            res.status === 429
              ? 'Too many attempts in a short time. Please wait a minute and try again.'
              : data.error || data.message || `Request failed (${res.status})`,
        })
        return
      }

      const redirect: string | undefined = (!data.demo && data.url) || data.redirectUrl || undefined
      if (redirect) {
        toast.success('Redirecting to payment…', {
          description: selectedDomain && !useFreeSubdomain
            ? `After payment, register ${selectedDomain} from the Domains page.`
            : undefined,
        })
        window.location.href = redirect
        return
      }

      if (data.status === 'pending') {
        // Manual / bank transfer: nothing is provisioned until an admin
        // confirms the money. Do not claim the site is live.
        setDeployOutcome('awaiting_payment')
        setDeployUrl(`${slug}.apsamo.com`)
        setDeploySuccess(true)
        toast.success('Order placed. Awaiting payment confirmation.')
        return
      }

      setDeployOutcome('live')
      setDeployUrl(data.project?.subdomain || `${slug}.apsamo.com`)
      setDeploySuccess(true)
      toast.success('Deployment started!')
    } catch {
      toast.error('Deployment failed. Please check your connection and try again.')
    } finally {
      setDeploying(false)
    }
  }, [selectedPlan, isAuthenticated, projectName, framework, selectedDomain, useFreeSubdomain])

  const primaryState = domainResults
    ? availabilityOf({
        status: domainResults.status,
        available: domainResults.available,
        premium: domainResults.premium,
        sellable: domainResults.sellable,
        price: domainResults.price,
      })
    : null

  // Progress
  const progress = (step / 5) * 100
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  const selectedPlanData = plans.find((p) => p.id === selectedPlan)
  const monthlyCost = selectedPlanData ? selectedPlanData.price : 0

  return (
    <div className="fixed inset-0 z-[100] bg-background/95 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-2xl animate-fade-in-up">
        {/* Progress Bar */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            {STEP_LABELS.map((label, i) => {
              const stepNum = i + 1
              const isCompleted = step > stepNum
              const isCurrent = step === stepNum
              return (
                <div key={label} className="flex flex-col items-center gap-1.5">
                  <div
                    className={`flex size-9 items-center justify-center rounded-full text-sm font-semibold transition-all duration-300 ${
                      isCompleted
                        ? 'bg-indigo-500 text-white'
                        : isCurrent
                          ? 'bg-indigo-500/10 text-indigo-600 border-2 border-indigo-500'
                          : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {isCompleted ? <Check className="size-4" /> : stepNum}
                  </div>
                  <span className={`text-[10px] font-medium hidden sm:block ${isCurrent ? 'text-indigo-600' : 'text-muted-foreground'}`}>
                    {label}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-indigo-500 to-indigo-400 rounded-full transition-all duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {/* Step Content */}
        <Card className="border-0 shadow-2xl">
          <CardContent className="p-6 sm:p-10 min-h-[400px] flex flex-col">
            {/* ─── Step 1: Welcome ─── */}
            {step === 1 && (
              <div className="flex-1 flex flex-col items-center justify-center text-center animate-fade-in-up">
                <div className="relative mb-6">
                  <div className="size-20 rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-500/30">
                    <Rocket className="size-10 text-white" />
                  </div>
                  <div className="absolute -top-2 -end-2 size-6 rounded-full bg-indigo-400 flex items-center justify-center animate-float">
                    <Sparkles className="size-3 text-white" />
                  </div>
                </div>
                <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-3">
                  Welcome to Apsamo Panel!
                </h1>
                <p className="text-muted-foreground text-lg max-w-md mb-8">
                  Let&apos;s get your first project deployed in under 2 minutes
                </p>
                <Button
                  size="lg"
                  className="bg-indigo-500 hover:bg-indigo-600 text-white px-10 h-12 text-base animate-pulse-glow"
                  onClick={() => setStep(2)}
                >
                  Get Started
                  <ArrowRight className="size-4 ms-2" />
                </Button>
                <button
                  className="mt-4 text-sm text-muted-foreground hover:text-foreground transition-colors"
                  onClick={onSkip}
                >
                  Skip for now
                </button>
              </div>
            )}

            {/* ─── Step 2: Create Your First Project ─── */}
            {step === 2 && (
              <div className="flex-1 flex flex-col animate-fade-in-up">
                <div className="text-center mb-8">
                  <h2 className="text-2xl font-bold mb-2">Create Your First Project</h2>
                  <p className="text-muted-foreground">Name your project and choose a framework</p>
                </div>

                <div className="mb-6">
                  <label className="text-sm font-medium mb-2 block">Project Name</label>
                  <Input
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    placeholder="my-first-app"
                    className="h-11"
                  />
                </div>

                <div className="mb-8">
                  <label className="text-sm font-medium mb-3 block">Framework</label>
                  <div className="grid grid-cols-2 gap-3">
                    {FRAMEWORKS.map((fw) => {
                      const isSelected = framework === fw.id
                      return (
                        <button
                          key={fw.id}
                          onClick={() => setFramework(fw.id)}
                          className={`flex items-start gap-3 p-4 rounded-xl border-2 text-start transition-all duration-200 hover:shadow-md ${
                            isSelected
                              ? 'border-indigo-500 bg-indigo-500/5 shadow-md shadow-indigo-500/10'
                              : 'border-border hover:border-indigo-500/30'
                          }`}
                        >
                          <div className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${isSelected ? 'bg-indigo-500/10' : 'bg-muted'}`}>
                            <fw.icon className={`size-5 ${isSelected ? 'text-indigo-600' : fw.color}`} />
                          </div>
                          <div>
                            <p className={`font-semibold text-sm ${isSelected ? 'text-indigo-600' : ''}`}>{fw.name}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">{fw.description}</p>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="mt-auto flex items-center justify-between">
                  <button
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    onClick={onSkip}
                  >
                    Skip for now
                  </button>
                  <div className="flex gap-3">
                    <Button variant="outline" onClick={() => setStep(1)}>
                      <ArrowLeft className="size-4 me-1" /> Back
                    </Button>
                    <Button
                      className="bg-indigo-500 hover:bg-indigo-600 text-white"
                      onClick={() => setStep(3)}
                      disabled={!projectName.trim()}
                    >
                      Continue <ArrowRight className="size-4 ms-1" />
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* ─── Step 3: Choose a Domain ─── */}
            {step === 3 && (
              <div className="flex-1 flex flex-col animate-fade-in-up">
                <div className="text-center mb-8">
                  <h2 className="text-2xl font-bold mb-2">Choose a Domain</h2>
                  <p className="text-muted-foreground">Search for a custom domain or use a free subdomain</p>
                  <p className="text-xs text-muted-foreground mt-2 max-w-md mx-auto">
                    A custom domain is ordered separately after your site is set up, so we can
                    collect the registrant details the registry requires.
                  </p>
                </div>

                <div className="mb-6">
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute start-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                      <Input
                        value={domainSearch}
                        onChange={(e) => setDomainSearch(e.target.value)}
                        aria-label="Domain name to search"
                        placeholder="e.g. myapp.com"
                        className="h-11 ps-10"
                        onKeyDown={(e) => e.key === 'Enter' && handleDomainSearch()}
                      />
                    </div>
                    <Button
                      className="bg-indigo-500 hover:bg-indigo-600 text-white"
                      onClick={handleDomainSearch}
                      disabled={searchingDomain || !domainSearch.trim()}
                    >
                      {searchingDomain ? <Loader2 className="size-4 animate-spin" /> : 'Search'}
                    </Button>
                  </div>
                </div>

                {/* Lookup failed: never shown as available or taken */}
                {domainError && !searchingDomain && (
                  <div
                    role="alert"
                    className="mb-4 flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm"
                  >
                    <AlertTriangle className="size-4 text-amber-600 shrink-0" aria-hidden="true" />
                    <span className="flex-1">{domainError}</span>
                    <Button variant="outline" size="sm" onClick={handleDomainSearch}>
                      <RefreshCw className="size-3.5 me-1" /> Try again
                    </Button>
                  </div>
                )}

                {/* Domain results */}
                {domainResults && primaryState && (
                  <ul className="mb-4 space-y-2 max-h-48 overflow-y-auto" aria-live="polite">
                    <DomainOption
                      domain={domainResults.domain}
                      state={primaryState}
                      price={domainResults.price}
                      selected={selectedDomain === domainResults.domain && !useFreeSubdomain}
                      onChoose={chooseDomain}
                    />
                    {domainResults.suggestions?.map((s) => (
                      <DomainOption
                        key={s.domain}
                        domain={s.domain}
                        state={availabilityOf({ status: s.status, available: s.available, price: s.price })}
                        price={s.price}
                        selected={selectedDomain === s.domain && !useFreeSubdomain}
                        onChoose={chooseDomain}
                      />
                    ))}
                  </ul>
                )}

                {/* Free subdomain option */}
                <button
                  onClick={() => { setUseFreeSubdomain(true); setSelectedDomain(null) }}
                  className={`w-full flex items-center gap-3 p-4 rounded-xl border-2 transition-all mb-4 ${
                    useFreeSubdomain
                      ? 'border-indigo-500 bg-indigo-500/5'
                      : 'border-border hover:border-indigo-500/30'
                  }`}
                >
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10">
                    <Globe className="size-5 text-indigo-500" />
                  </div>
                  <div className="text-start">
                    <p className="font-semibold text-sm">Use a free subdomain</p>
                    <p className="text-xs text-muted-foreground">
                      <span className="text-indigo-600 font-mono">{slug}.apsamo.com</span> — Free with any plan
                    </p>
                  </div>
                  <Badge variant="secondary" className="ms-auto bg-indigo-500/10 text-indigo-600 text-[10px]">FREE</Badge>
                </button>

                <div className="mt-auto flex items-center justify-between">
                  <button
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    onClick={onSkip}
                  >
                    Skip for now
                  </button>
                  <div className="flex gap-3">
                    <Button variant="outline" onClick={() => setStep(2)}>
                      <ArrowLeft className="size-4 me-1" /> Back
                    </Button>
                    <Button
                      className="bg-indigo-500 hover:bg-indigo-600 text-white"
                      onClick={() => setStep(4)}
                      disabled={!selectedDomain && !useFreeSubdomain}
                    >
                      Continue <ArrowRight className="size-4 ms-1" />
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* ─── Step 4: Select a Plan ─── */}
            {step === 4 && (
              <div className="flex-1 flex flex-col animate-fade-in-up">
                <div className="text-center mb-8">
                  <h2 className="text-2xl font-bold mb-2">Select a Plan</h2>
                  <p className="text-muted-foreground">Choose the plan that fits your needs</p>
                </div>

                {loadingPlans ? (
                  <div className="flex-1 flex items-center justify-center">
                    <Loader2 className="size-8 animate-spin text-indigo-500" />
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
                    {plans.map((plan) => {
                      const isSelected = selectedPlan === plan.id
                      return (
                        <button
                          key={plan.id}
                          onClick={() => setSelectedPlan(plan.id)}
                          className={`relative flex flex-col p-4 rounded-xl border-2 text-start transition-all duration-200 hover:shadow-md ${
                            isSelected
                              ? 'border-indigo-500 bg-indigo-500/5 shadow-md shadow-indigo-500/10'
                              : 'border-border hover:border-indigo-500/30'
                          }`}
                        >
                          {plan.popular && (
                            <Badge className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-indigo-500 text-white border-0 text-[10px] px-2 py-0">
                              POPULAR
                            </Badge>
                          )}
                          <p className="font-bold text-sm">{plan.name}</p>
                          <div className="mt-1 mb-3">
                            <span className="text-2xl font-extrabold">${plan.price}</span>
                            <span className="text-xs text-muted-foreground">/mo</span>
                          </div>
                          <p className="text-[11px] text-muted-foreground">{plan.description}</p>
                          {plan.features.length > 0 && (
                            <ul className="mt-3 space-y-1">
                              {plan.features.slice(0, 3).map((f) => (
                                <li key={f} className="flex items-center gap-1.5 text-[11px]">
                                  <Check className="size-3 text-indigo-500 shrink-0" />
                                  {f}
                                </li>
                              ))}
                            </ul>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}

                <div className="mt-auto flex items-center justify-between">
                  <button
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    onClick={onSkip}
                  >
                    Skip for now
                  </button>
                  <div className="flex gap-3">
                    <Button variant="outline" onClick={() => setStep(3)}>
                      <ArrowLeft className="size-4 me-1" /> Back
                    </Button>
                    <Button
                      className="bg-indigo-500 hover:bg-indigo-600 text-white"
                      onClick={() => setStep(5)}
                      disabled={!selectedPlan}
                    >
                      Continue <ArrowRight className="size-4 ms-1" />
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* ─── Step 5: Deploy! ─── */}
            {step === 5 && !deploySuccess && (
              <div className="flex-1 flex flex-col animate-fade-in-up">
                <div className="text-center mb-8">
                  <h2 className="text-2xl font-bold mb-2">Ready to Deploy!</h2>
                  <p className="text-muted-foreground">Review your choices and hit deploy</p>
                </div>

                <div className="space-y-3 mb-8 bg-muted/50 rounded-xl p-5">
                  <div className="flex items-center justify-between py-2 border-b border-border">
                    <span className="text-sm text-muted-foreground">Project</span>
                    <span className="font-semibold text-sm">{projectName}</span>
                  </div>
                  <div className="flex items-center justify-between py-2 border-b border-border">
                    <span className="text-sm text-muted-foreground">Framework</span>
                    <span className="font-semibold text-sm">{FRAMEWORKS.find((f) => f.id === framework)?.name}</span>
                  </div>
                  <div className="flex items-center justify-between py-2 border-b border-border">
                    <span className="text-sm text-muted-foreground">Domain</span>
                    <span className="font-semibold text-sm font-mono">
                      {useFreeSubdomain ? `${slug}.apsamo.com` : selectedDomain}
                    </span>
                  </div>
                  {!useFreeSubdomain && selectedDomain && (
                    <p className="text-xs text-muted-foreground -mt-1 pb-2 border-b border-border">
                      Until {selectedDomain} is registered your site runs on{' '}
                      <span className="font-mono">{slug}.apsamo.com</span>. You&apos;ll register the
                      domain next{selectedDomainPrice ? ` (${selectedDomainPrice.toFixed(2)}/yr, billed separately)` : ''}.
                    </p>
                  )}
                  <div className="flex items-center justify-between py-2 border-b border-border">
                    <span className="text-sm text-muted-foreground">Plan</span>
                    <span className="font-semibold text-sm">{selectedPlanData?.name || 'Starter'}</span>
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <span className="text-sm text-muted-foreground">Monthly Cost</span>
                    <span className="font-bold text-lg text-indigo-600">${monthlyCost}/mo</span>
                  </div>
                </div>

                <div className="mt-auto flex items-center justify-between">
                  <button
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    onClick={onSkip}
                  >
                    Skip for now
                  </button>
                  <div className="flex gap-3">
                    <Button variant="outline" onClick={() => setStep(4)}>
                      <ArrowLeft className="size-4 me-1" /> Back
                    </Button>
                    <Button
                      className="bg-indigo-500 hover:bg-indigo-600 text-white px-8"
                      onClick={handleDeploy}
                      disabled={deploying}
                    >
                      {deploying ? (
                        <>
                          <Loader2 className="size-4 animate-spin me-2" />
                          Deploying...
                        </>
                      ) : (
                        <>
                          <Rocket className="size-4 me-2" />
                          Deploy Now
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* ─── Step 5: Deploy Success ─── */}
            {step === 5 && deploySuccess && (
              <div className="flex-1 flex flex-col items-center justify-center text-center relative animate-fade-in-up">
                <ConfettiEffect />
                <div className="animate-success-bounce mb-6">
                  <div className="size-20 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-500/30">
                    <Check className="size-10 text-white" />
                  </div>
                </div>
                <h2 className="text-3xl font-extrabold tracking-tight mb-2">
                  {deployOutcome === 'live' ? 'Your project is on its way!' : 'Order placed'}
                </h2>
                <p className="text-muted-foreground mb-6 max-w-md">
                  {deployOutcome === 'live'
                    ? 'Your hosting is set up and the first deployment has started.'
                    : 'Your site will be set up as soon as your payment is confirmed. You can follow it under Billing.'}
                </p>
                <div className="flex items-center gap-2 bg-indigo-500/10 border border-indigo-500/20 rounded-lg px-4 py-3 mb-8">
                  <Globe className="size-4 text-indigo-500" />
                  <span className="font-mono font-semibold text-indigo-600 text-sm">
                    https://{deployUrl}
                  </span>
                  <ExternalLink className="size-3 text-indigo-500" />
                </div>
                <div className="flex flex-col sm:flex-row gap-3">
                  {selectedDomain && !useFreeSubdomain && (
                    <Button
                      size="lg"
                      className="bg-indigo-500 hover:bg-indigo-600 text-white px-8 h-12 text-base"
                      onClick={registerChosenDomain}
                    >
                      <Globe className="size-4 me-2" />
                      Register {selectedDomain}
                    </Button>
                  )}
                  <Button
                    size="lg"
                    variant={selectedDomain && !useFreeSubdomain ? 'outline' : 'default'}
                    className={selectedDomain && !useFreeSubdomain
                      ? 'px-8 h-12 text-base'
                      : 'bg-indigo-500 hover:bg-indigo-600 text-white px-10 h-12 text-base'}
                    onClick={onComplete}
                  >
                    Go to Dashboard
                    <ArrowRight className="size-4 ms-2" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
