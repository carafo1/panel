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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useAuthStore } from '@/store/auth-store'
import { toast } from 'sonner'

/* ── Types ── */
interface FrameworkOption {
  id: string
  name: string
  icon: React.ElementType
  description: string
  color: string
}

interface DomainResult {
  domain: string
  available: boolean
  price: number | null
  message: string
  suggestions?: Array<{ domain: string; available: boolean; price: number }>
}

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
  { id: 'react', name: 'React', icon: Hexagon, description: 'Client-side SPA with React', color: 'text-sky-500' },
  { id: 'nodejs', name: 'Node.js', icon: FileCode, description: 'Backend API server', color: 'text-green-600' },
  { id: 'static', name: 'Static', icon: Layout, description: 'HTML/CSS/JS static site', color: 'text-orange-500' },
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
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null)
  const [useFreeSubdomain, setUseFreeSubdomain] = useState(false)
  const [plans, setPlans] = useState<PlanOption[]>([])
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null)
  const [deploying, setDeploying] = useState(false)
  const [deploySuccess, setDeploySuccess] = useState(false)
  const [deployUrl, setDeployUrl] = useState('')
  const [searchingDomain, setSearchingDomain] = useState(false)
  const [loadingPlans, setLoadingPlans] = useState(false)
  const { user, token } = useAuthStore()

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
    try {
      const res = await fetch('/api/domains/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domainSearch.trim() }),
      })
      const data = await res.json()
      setDomainResults(data)
      setUseFreeSubdomain(false)
      setSelectedDomain(null)
    } catch {
      toast.error('Failed to search domains')
    }
    setSearchingDomain(false)
  }, [domainSearch])

  // Deploy
  const handleDeploy = useCallback(async () => {
    if (!selectedPlan || !token) return
    setDeploying(true)
    try {
      const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      const type = selectedDomain && !useFreeSubdomain ? 'both' : 'hosting'
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          planId: selectedPlan,
          type,
          projectName,
          framework,
          domainName: selectedDomain && !useFreeSubdomain ? selectedDomain : undefined,
        }),
      })
      const data = await res.json()
      if (res.ok) {
        const url = data.project?.subdomain || `${slug}.deployhub.io`
        setDeployUrl(url)
        setDeploySuccess(true)
        toast.success('Deployment successful!')
      } else {
        toast.error(data.error || 'Deployment failed')
      }
    } catch {
      toast.error('Deployment failed. Please try again.')
    }
    setDeploying(false)
  }, [selectedPlan, token, projectName, framework, selectedDomain, useFreeSubdomain])

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
                        ? 'bg-emerald-500 text-white'
                        : isCurrent
                          ? 'bg-emerald-500/10 text-emerald-600 border-2 border-emerald-500'
                          : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {isCompleted ? <Check className="size-4" /> : stepNum}
                  </div>
                  <span className={`text-[10px] font-medium hidden sm:block ${isCurrent ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                    {label}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full transition-all duration-500 ease-out"
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
                  <div className="size-20 rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center shadow-lg shadow-emerald-500/30">
                    <Rocket className="size-10 text-white" />
                  </div>
                  <div className="absolute -top-2 -right-2 size-6 rounded-full bg-emerald-400 flex items-center justify-center animate-float">
                    <Sparkles className="size-3 text-white" />
                  </div>
                </div>
                <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-3">
                  Welcome to DeployHub!
                </h1>
                <p className="text-muted-foreground text-lg max-w-md mb-8">
                  Let&apos;s get your first project deployed in under 2 minutes
                </p>
                <Button
                  size="lg"
                  className="bg-emerald-500 hover:bg-emerald-600 text-white px-10 h-12 text-base animate-pulse-glow"
                  onClick={() => setStep(2)}
                >
                  Get Started
                  <ArrowRight className="size-4 ml-2" />
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
                          className={`flex items-start gap-3 p-4 rounded-xl border-2 text-left transition-all duration-200 hover:shadow-md ${
                            isSelected
                              ? 'border-emerald-500 bg-emerald-500/5 shadow-md shadow-emerald-500/10'
                              : 'border-border hover:border-emerald-500/30'
                          }`}
                        >
                          <div className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${isSelected ? 'bg-emerald-500/10' : 'bg-muted'}`}>
                            <fw.icon className={`size-5 ${isSelected ? 'text-emerald-600' : fw.color}`} />
                          </div>
                          <div>
                            <p className={`font-semibold text-sm ${isSelected ? 'text-emerald-600' : ''}`}>{fw.name}</p>
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
                      <ArrowLeft className="size-4 mr-1" /> Back
                    </Button>
                    <Button
                      className="bg-emerald-500 hover:bg-emerald-600 text-white"
                      onClick={() => setStep(3)}
                      disabled={!projectName.trim()}
                    >
                      Continue <ArrowRight className="size-4 ml-1" />
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
                </div>

                <div className="mb-6">
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                      <Input
                        value={domainSearch}
                        onChange={(e) => setDomainSearch(e.target.value)}
                        placeholder="e.g. myapp.com"
                        className="h-11 pl-10"
                        onKeyDown={(e) => e.key === 'Enter' && handleDomainSearch()}
                      />
                    </div>
                    <Button
                      className="bg-emerald-500 hover:bg-emerald-600 text-white"
                      onClick={handleDomainSearch}
                      disabled={searchingDomain}
                    >
                      {searchingDomain ? <Loader2 className="size-4 animate-spin" /> : 'Search'}
                    </Button>
                  </div>
                </div>

                {/* Domain results */}
                {domainResults && (
                  <div className="mb-4 space-y-2 max-h-48 overflow-y-auto">
                    {domainResults.available && (
                      <button
                        onClick={() => { setSelectedDomain(domainResults.domain); setUseFreeSubdomain(false) }}
                        className={`w-full flex items-center justify-between p-3 rounded-lg border-2 transition-all ${
                          selectedDomain === domainResults.domain && !useFreeSubdomain
                            ? 'border-emerald-500 bg-emerald-500/5'
                            : 'border-border hover:border-emerald-500/30'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <Check className="size-4 text-emerald-500" />
                          <span className="font-medium text-sm">{domainResults.domain}</span>
                          <Badge variant="secondary" className="text-[10px] bg-emerald-500/10 text-emerald-600">Available</Badge>
                        </div>
                        <span className="font-semibold text-emerald-600">${domainResults.price}/yr</span>
                      </button>
                    )}
                    {domainResults.suggestions?.map((s) => (
                      <button
                        key={s.domain}
                        onClick={() => { setSelectedDomain(s.domain); setUseFreeSubdomain(false) }}
                        className={`w-full flex items-center justify-between p-3 rounded-lg border-2 transition-all ${
                          selectedDomain === s.domain && !useFreeSubdomain
                            ? 'border-emerald-500 bg-emerald-500/5'
                            : 'border-border hover:border-emerald-500/30'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <Globe className="size-4 text-muted-foreground" />
                          <span className="font-medium text-sm">{s.domain}</span>
                        </div>
                        <span className="font-semibold text-emerald-600">${s.price}/yr</span>
                      </button>
                    ))}
                  </div>
                )}

                {/* Free subdomain option */}
                <button
                  onClick={() => { setUseFreeSubdomain(true); setSelectedDomain(null) }}
                  className={`w-full flex items-center gap-3 p-4 rounded-xl border-2 transition-all mb-4 ${
                    useFreeSubdomain
                      ? 'border-emerald-500 bg-emerald-500/5'
                      : 'border-border hover:border-emerald-500/30'
                  }`}
                >
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10">
                    <Globe className="size-5 text-emerald-500" />
                  </div>
                  <div className="text-left">
                    <p className="font-semibold text-sm">Use a free subdomain</p>
                    <p className="text-xs text-muted-foreground">
                      <span className="text-emerald-600 font-mono">{slug}.deployhub.io</span> — Free with any plan
                    </p>
                  </div>
                  <Badge variant="secondary" className="ml-auto bg-emerald-500/10 text-emerald-600 text-[10px]">FREE</Badge>
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
                      <ArrowLeft className="size-4 mr-1" /> Back
                    </Button>
                    <Button
                      className="bg-emerald-500 hover:bg-emerald-600 text-white"
                      onClick={() => setStep(4)}
                      disabled={!selectedDomain && !useFreeSubdomain}
                    >
                      Continue <ArrowRight className="size-4 ml-1" />
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
                    <Loader2 className="size-8 animate-spin text-emerald-500" />
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
                    {plans.map((plan) => {
                      const isSelected = selectedPlan === plan.id
                      return (
                        <button
                          key={plan.id}
                          onClick={() => setSelectedPlan(plan.id)}
                          className={`relative flex flex-col p-4 rounded-xl border-2 text-left transition-all duration-200 hover:shadow-md ${
                            isSelected
                              ? 'border-emerald-500 bg-emerald-500/5 shadow-md shadow-emerald-500/10'
                              : 'border-border hover:border-emerald-500/30'
                          }`}
                        >
                          {plan.popular && (
                            <Badge className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-emerald-500 text-white border-0 text-[10px] px-2 py-0">
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
                                  <Check className="size-3 text-emerald-500 shrink-0" />
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
                      <ArrowLeft className="size-4 mr-1" /> Back
                    </Button>
                    <Button
                      className="bg-emerald-500 hover:bg-emerald-600 text-white"
                      onClick={() => setStep(5)}
                      disabled={!selectedPlan}
                    >
                      Continue <ArrowRight className="size-4 ml-1" />
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
                      {useFreeSubdomain ? `${slug}.deployhub.io` : selectedDomain}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-2 border-b border-border">
                    <span className="text-sm text-muted-foreground">Plan</span>
                    <span className="font-semibold text-sm">{selectedPlanData?.name || 'Starter'}</span>
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <span className="text-sm text-muted-foreground">Monthly Cost</span>
                    <span className="font-bold text-lg text-emerald-600">${monthlyCost}/mo</span>
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
                      <ArrowLeft className="size-4 mr-1" /> Back
                    </Button>
                    <Button
                      className="bg-emerald-500 hover:bg-emerald-600 text-white px-8"
                      onClick={handleDeploy}
                      disabled={deploying}
                    >
                      {deploying ? (
                        <>
                          <Loader2 className="size-4 animate-spin mr-2" />
                          Deploying...
                        </>
                      ) : (
                        <>
                          <Rocket className="size-4 mr-2" />
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
                  <div className="size-20 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center shadow-lg shadow-emerald-500/30">
                    <Check className="size-10 text-white" />
                  </div>
                </div>
                <h2 className="text-3xl font-extrabold tracking-tight mb-2">
                  Your project is live!
                </h2>
                <p className="text-muted-foreground mb-6">
                  Congratulations! Your project has been deployed successfully.
                </p>
                <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-4 py-3 mb-8">
                  <Globe className="size-4 text-emerald-500" />
                  <span className="font-mono font-semibold text-emerald-600 text-sm">
                    https://{deployUrl}
                  </span>
                  <ExternalLink className="size-3 text-emerald-500" />
                </div>
                <Button
                  size="lg"
                  className="bg-emerald-500 hover:bg-emerald-600 text-white px-10 h-12 text-base"
                  onClick={onComplete}
                >
                  Go to Dashboard
                  <ArrowRight className="size-4 ml-2" />
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
