'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Globe,
  Zap,
  Shield,
  Lock,
  RefreshCw,
  BarChart3,
  ArrowRight,
  Check,
  Play,
  Menu,
  X,
  Star,
  Quote,
} from 'lucide-react'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface LandingPageProps {
  onGetStarted: () => void
  onLogin: () => void
}

/* ─── Counter animation hook ─── */
function useCountUp(end: number, duration = 2000, suffix = '') {
  const [count, setCount] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const hasAnimated = useRef(false)

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasAnimated.current) {
          hasAnimated.current = true
          const startTime = performance.now()
          const animate = (currentTime: number) => {
            const elapsed = currentTime - startTime
            const progress = Math.min(elapsed / duration, 1)
            // Ease out cubic
            const eased = 1 - Math.pow(1 - progress, 3)
            setCount(Math.round(eased * end))
            if (progress < 1) {
              requestAnimationFrame(animate)
            }
          }
          requestAnimationFrame(animate)
        }
      },
      { threshold: 0.3 }
    )
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [end, duration])

  return { count: count + suffix, ref }
}

/* ─── data ─── */
const features = [
  {
    icon: Zap,
    title: 'Instant Provisioning',
    description: 'Servers provisioned in under 30 seconds',
  },
  {
    icon: Globe,
    title: 'Domain Registration',
    description: 'Search, buy, and connect domains automatically',
  },
  {
    icon: Lock,
    title: 'Auto SSL',
    description: 'Free SSL certificates for every domain',
  },
  {
    icon: RefreshCw,
    title: 'Auto Deploy',
    description: 'Push to GitHub, deploy automatically',
  },
  {
    icon: BarChart3,
    title: 'Real-time Monitoring',
    description: 'Live logs, metrics, and alerts',
  },
  {
    icon: Shield,
    title: 'DDoS Protection',
    description: 'Enterprise-grade security included',
  },
]

const stats = [
  { value: 10000, suffix: '+', label: 'Deployments' },
  { value: 5000, suffix: '+', label: 'Domains Registered' },
  { value: 99, suffix: '.9%', label: 'Uptime' },
  { value: 50, suffix: '+', label: 'Countries' },
]

const steps = [
  {
    step: 1,
    title: 'Choose Your Plan',
    description: 'Select a hosting plan that fits your needs',
  },
  {
    step: 2,
    title: 'Connect Your Domain',
    description: 'Buy a new domain or connect an existing one',
  },
  {
    step: 3,
    title: 'Deploy & Go Live',
    description: 'Push your code and watch it go live instantly',
  },
]

const testimonials = [
  {
    quote: 'DeployHub made deploying our SaaS app dead simple. We went from code to live in under a minute.',
    name: 'Sarah Chen',
    role: 'CTO at TechFlow',
    initials: 'SC',
    stars: 5,
  },
  {
    quote: 'The domain automation is incredible. No more manual DNS configuration!',
    name: 'Marcus Johnson',
    role: 'Founder at DevStudio',
    initials: 'MJ',
    stars: 5,
  },
  {
    quote: 'We migrated 50+ sites to DeployHub and haven\'t looked back. The team features are outstanding.',
    name: 'Elena Rodriguez',
    role: 'Lead Dev at ScaleUp',
    initials: 'ER',
    stars: 5,
  },
]

const pricingPlans = [
  {
    name: 'Starter',
    price: 9,
    description: 'Perfect for side projects',
    features: ['1GB RAM', '1 vCPU', '10GB Storage', '1 Project', 'Free SSL'],
    popular: false,
  },
  {
    name: 'Pro',
    price: 29,
    description: 'For growing teams and businesses',
    features: [
      '4GB RAM',
      '2 vCPU',
      '50GB Storage',
      '5 Projects',
      'Free SSL',
      'Custom Domains',
    ],
    popular: true,
  },
  {
    name: 'Business',
    price: 79,
    description: 'For large-scale operations',
    features: [
      '16GB RAM',
      '4 vCPU',
      '200GB Storage',
      'Unlimited Projects',
      'Free SSL',
      'Custom Domains',
      'Priority Support',
    ],
    popular: false,
  },
]

const footerLinks = {
  Product: ['Features', 'Pricing', 'Changelog', 'Roadmap'],
  Resources: ['Documentation', 'API Reference', 'Guides', 'Blog'],
  Company: ['About', 'Careers', 'Press', 'Contact'],
  Legal: ['Privacy', 'Terms', 'Security', 'GDPR'],
}

/* ─── StaggerCard wrapper ─── */
function StaggerCard({ children, index, className = '' }: { children: React.ReactNode; index: number; className?: string }) {
  return (
    <div
      className={`animate-stagger-in ${className}`}
      style={{ animationDelay: `${index * 0.1}s` }}
    >
      {children}
    </div>
  )
}

/* ─── Scroll Reveal wrapper ─── */
function ScrollReveal({ children, className = '', delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { threshold: 0.15 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      className={`scroll-reveal ${visible ? 'visible' : ''} ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  )
}

/* ─── main component ─── */
export default function LandingPage({ onGetStarted, onLogin }: LandingPageProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  // Stat counter hooks
  const stat0 = useCountUp(stats[0].value, 2000, stats[0].suffix)
  const stat1 = useCountUp(stats[1].value, 2000, stats[1].suffix)
  const stat2 = useCountUp(stats[2].value, 2000, stats[2].suffix)
  const stat3 = useCountUp(stats[3].value, 2000, stats[3].suffix)
  const statRefs = [stat0, stat1, stat2, stat3]

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground overflow-x-hidden">
      {/* ─── NAVBAR ─── */}
      <nav className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            {/* Logo */}
            <div className="flex items-center gap-2">
              <Globe className="size-7 text-emerald-500" />
              <span className="text-xl font-bold tracking-tight">DeployHub</span>
            </div>

            {/* Desktop Nav */}
            <div className="hidden md:flex items-center gap-8">
              <a
                href="#features"
                className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors relative after:absolute after:bottom-[-4px] after:left-0 after:w-0 after:h-[2px] after:bg-emerald-500 after:transition-all after:duration-300 hover:after:w-full"
              >
                Features
              </a>
              <a
                href="#pricing"
                className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors relative after:absolute after:bottom-[-4px] after:left-0 after:w-0 after:h-[2px] after:bg-emerald-500 after:transition-all after:duration-300 hover:after:w-full"
              >
                Pricing
              </a>
              <a
                href="#"
                className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors relative after:absolute after:bottom-[-4px] after:left-0 after:w-0 after:h-[2px] after:bg-emerald-500 after:transition-all after:duration-300 hover:after:w-full"
              >
                Docs
              </a>
            </div>

            {/* Desktop CTA */}
            <div className="hidden md:flex items-center gap-3">
              <ThemeToggle />
              <Button variant="ghost" size="sm" onClick={onLogin}>
                Login
              </Button>
              <Button
                size="sm"
                className="bg-emerald-500 hover:bg-emerald-600 text-white"
                onClick={onGetStarted}
              >
                Get Started
              </Button>
            </div>

            {/* Mobile menu toggle */}
            <button
              className="md:hidden p-2 text-muted-foreground hover:text-foreground"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label="Toggle menu"
            >
              {mobileMenuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>

          {/* Mobile Menu */}
          {mobileMenuOpen && (
            <div
              className="md:hidden border-t py-4 space-y-3 animate-fade-in-up"
            >
              <a href="#features" onClick={() => setMobileMenuOpen(false)} className="block text-sm font-medium text-muted-foreground hover:text-foreground px-2 py-1">
                Features
              </a>
              <a href="#pricing" onClick={() => setMobileMenuOpen(false)} className="block text-sm font-medium text-muted-foreground hover:text-foreground px-2 py-1">
                Pricing
              </a>
              <a href="#" onClick={() => setMobileMenuOpen(false)} className="block text-sm font-medium text-muted-foreground hover:text-foreground px-2 py-1">
                Docs
              </a>
              <div className="flex gap-3 pt-2 px-2 items-center">
                <ThemeToggle />
                <Button variant="ghost" size="sm" onClick={onLogin} className="flex-1">
                  Login
                </Button>
                <Button
                  size="sm"
                  className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white"
                  onClick={onGetStarted}
                >
                  Get Started
                </Button>
              </div>
            </div>
          )}
        </div>
      </nav>

      <main className="flex-1">
        {/* ─── HERO ─── */}
        <section className="relative overflow-hidden bg-[#0a0a0a] text-white">
          {/* Animated gradient orbs */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <div
              className="absolute -top-40 -left-40 w-[500px] h-[500px] rounded-full opacity-20 blur-[120px] animate-float"
              style={{
                background:
                  'radial-gradient(circle, #10b981 0%, transparent 70%)',
              }}
            />
            <div
              className="absolute top-20 right-[-10%] w-[400px] h-[400px] rounded-full opacity-15 blur-[100px] animate-float"
              style={{
                background:
                  'radial-gradient(circle, #059669 0%, transparent 70%)',
                animationDelay: '2s',
              }}
            />
            <div
              className="absolute bottom-0 left-1/3 w-[600px] h-[300px] rounded-full opacity-10 blur-[140px] animate-float"
              style={{
                background:
                  'radial-gradient(circle, #34d399 0%, transparent 70%)',
                animationDelay: '4s',
              }}
            />
          </div>

          {/* Grid pattern background */}
          <div className="absolute inset-0 animate-grid-bg opacity-60" />

          {/* Rotating gradient overlay */}
          <div
            className="absolute inset-0 animate-gradient opacity-[0.07]"
            style={{
              background: 'linear-gradient(45deg, #10b981, #059669, #34d399, #10b981)',
              backgroundSize: '400% 400%',
            }}
          />

          <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-24 sm:py-32 lg:py-40 text-center">
            <div className="animate-fade-in-up">
              <Badge
                variant="secondary"
                className="mb-6 bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20 text-sm px-4 py-1"
              >
                🚀 Now with automatic SSL &amp; DNS
              </Badge>
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-7xl font-extrabold tracking-tight leading-[1.1] mb-6 animate-fade-in-up" style={{ animationDelay: '0.15s' }}>
              Deploy in Seconds,{' '}
              <span className="bg-gradient-to-r from-emerald-400 to-emerald-600 bg-clip-text text-transparent">
                Scale Without Limits
              </span>
            </h1>

            <p className="mx-auto max-w-2xl text-lg sm:text-xl text-zinc-400 mb-10 leading-relaxed animate-fade-in-up" style={{ animationDelay: '0.3s' }}>
              The all-in-one platform for hosting, domains, and deployments. Buy a domain, get
              hosting, and launch your site — automatically.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 animate-fade-in-up" style={{ animationDelay: '0.45s' }}>
              <div className="relative group/cta">
                {/* Pulsing glow behind CTA button */}
                <div className="absolute -inset-1 rounded-lg animate-pulse-glow opacity-70 group-hover/cta:opacity-100 transition-opacity" />
                <Button
                  size="lg"
                  className="relative bg-emerald-500 hover:bg-emerald-600 text-white px-8 h-12 text-base shadow-lg shadow-emerald-500/25 hover:shadow-emerald-500/40 transition-all duration-300 hover:scale-105"
                  onClick={onGetStarted}
                >
                  Start Deploying
                  <ArrowRight className="size-4 ml-1 transition-transform group-hover/cta:translate-x-1" />
                </Button>
              </div>
              <Button
                variant="outline"
                size="lg"
                className="border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-white px-8 h-12 text-base"
              >
                <Play className="size-4 mr-1" />
                Watch Demo
              </Button>
            </div>
          </div>
        </section>

        {/* ─── STATS BAR ─── */}
        <section className="border-b bg-muted/30">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
            <ScrollReveal>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
                {stats.map((stat, i) => (
                  <div key={stat.label} ref={statRefs[i].ref} className="space-y-1">
                    <p className="text-3xl sm:text-4xl font-bold text-emerald-500">
                      {statRefs[i].count}
                    </p>
                    <p className="text-sm text-muted-foreground">{stat.label}</p>
                  </div>
                ))}
              </div>
            </ScrollReveal>
          </div>
        </section>

        {/* ─── FEATURES ─── */}
        <section id="features" className="py-20 sm:py-28">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <ScrollReveal>
              <div className="text-center mb-16">
                <Badge variant="secondary" className="mb-4">
                  Features
                </Badge>
                <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
                  Everything you need to{' '}
                  <span className="text-emerald-500">ship faster</span>
                </h2>
                <p className="mt-4 text-muted-foreground max-w-xl mx-auto text-lg">
                  From domains to deployments, we handle it all so you can focus on building.
                </p>
              </div>
            </ScrollReveal>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {features.map((feature, i) => (
                <StaggerCard key={feature.title} index={i}>
                  <Card className="group relative overflow-hidden border hover:border-emerald-500/50 hover:shadow-lg hover:shadow-emerald-500/10 transition-all duration-300 h-full hover:scale-[1.02]">
                    {/* Hover emerald glow */}
                    <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" style={{ boxShadow: '0 0 30px rgba(16, 185, 129, 0.1)' }} />
                    <CardHeader>
                      <div className="mb-2 flex size-11 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500 group-hover:bg-emerald-500/20 group-hover:scale-110 transition-all duration-300">
                        <feature.icon className="size-5" />
                      </div>
                      <CardTitle className="text-lg">{feature.title}</CardTitle>
                      <CardDescription className="text-sm">
                        {feature.description}
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </StaggerCard>
              ))}
            </div>
          </div>
        </section>

        {/* ─── HOW IT WORKS ─── */}
        <section className="py-20 sm:py-28 bg-muted/30">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <ScrollReveal>
              <div className="text-center mb-16">
                <Badge variant="secondary" className="mb-4">
                  How It Works
                </Badge>
                <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
                  Go live in <span className="text-emerald-500">three simple steps</span>
                </h2>
                <p className="mt-4 text-muted-foreground max-w-xl mx-auto text-lg">
                  No complex setups. No tedious configurations. Just deploy.
                </p>
              </div>
            </ScrollReveal>

            <div className="relative grid grid-cols-1 md:grid-cols-3 gap-8 lg:gap-12">
              {/* Connecting dotted lines (desktop) */}
              <div className="hidden md:block absolute top-[52px] left-[calc(16.67%+24px)] right-[calc(16.67%+24px)] h-0 border-t-2 border-dashed border-emerald-500/30" />

              {steps.map((step, i) => (
                <StaggerCard key={step.step} index={i} className="flex flex-col items-center text-center">
                  {/* Pulsing step number */}
                  <div className="relative z-10 mb-6">
                    <div className="absolute inset-0 rounded-full animate-pulse-glow" />
                    <div className="relative flex size-[52px] items-center justify-center rounded-full bg-emerald-500 text-white font-bold text-lg shadow-lg shadow-emerald-500/25">
                      {step.step}
                    </div>
                  </div>
                  <h3 className="text-xl font-semibold mb-2">{step.title}</h3>
                  <p className="text-muted-foreground max-w-xs">{step.description}</p>
                </StaggerCard>
              ))}
            </div>
          </div>
        </section>

        {/* ─── TESTIMONIALS ─── */}
        <section className="py-20 sm:py-28">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <ScrollReveal>
              <div className="text-center mb-16">
                <Badge variant="secondary" className="mb-4">
                  Testimonials
                </Badge>
                <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
                  Loved by <span className="text-emerald-500">developers worldwide</span>
                </h2>
                <p className="mt-4 text-muted-foreground max-w-xl mx-auto text-lg">
                  See what our users are saying about DeployHub.
                </p>
              </div>
            </ScrollReveal>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {testimonials.map((testimonial, i) => (
                <StaggerCard key={testimonial.name} index={i}>
                  <Card className="relative border hover:border-emerald-500/30 transition-all duration-300 hover:shadow-lg hover:shadow-emerald-500/5 h-full">
                    <CardContent className="p-6">
                      {/* Quote icon */}
                      <Quote className="size-8 text-emerald-500/20 mb-4" />

                      {/* Stars */}
                      <div className="flex gap-0.5 mb-4">
                        {Array.from({ length: testimonial.stars }).map((_, si) => (
                          <Star key={si} className="size-4 fill-amber-400 text-amber-400" />
                        ))}
                      </div>

                      {/* Quote text */}
                      <p className="text-sm leading-relaxed text-foreground mb-6">
                        &ldquo;{testimonial.quote}&rdquo;
                      </p>

                      {/* Author */}
                      <div className="flex items-center gap-3">
                        <div className="flex size-10 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 font-semibold text-sm">
                          {testimonial.initials}
                        </div>
                        <div>
                          <p className="font-semibold text-sm">{testimonial.name}</p>
                          <p className="text-xs text-muted-foreground">{testimonial.role}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </StaggerCard>
              ))}
            </div>
          </div>
        </section>

        {/* ─── PRICING ─── */}
        <section id="pricing" className="py-20 sm:py-28 bg-muted/30">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <ScrollReveal>
              <div className="text-center mb-16">
                <Badge variant="secondary" className="mb-4">
                  Pricing
                </Badge>
                <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
                  Simple, transparent{' '}
                  <span className="text-emerald-500">pricing</span>
                </h2>
                <p className="mt-4 text-muted-foreground max-w-xl mx-auto text-lg">
                  No hidden fees. No surprises. Pick a plan and start deploying.
                </p>
              </div>
            </ScrollReveal>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8 max-w-5xl mx-auto">
              {pricingPlans.map((plan, i) => (
                <StaggerCard key={plan.name} index={i}>
                  <Card
                    className={`relative flex flex-col h-full transition-all duration-300 hover:shadow-lg hover:scale-[1.02] ${
                      plan.popular
                        ? 'border-emerald-500 shadow-lg shadow-emerald-500/10 scale-[1.02]'
                        : 'hover:border-emerald-500/30'
                    }`}
                  >
                    {plan.popular && (
                      <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                        <Badge className="bg-emerald-500 text-white border-0 px-4 py-0.5 shadow-md shadow-emerald-500/25">
                          POPULAR
                        </Badge>
                      </div>
                    )}
                    <CardHeader className="pb-0">
                      <CardTitle className="text-xl">{plan.name}</CardTitle>
                      <CardDescription>{plan.description}</CardDescription>
                    </CardHeader>
                    <CardContent className="flex-1 flex flex-col">
                      <div className="mb-6">
                        <span className="text-4xl font-extrabold">${plan.price}</span>
                        <span className="text-muted-foreground ml-1">/mo</span>
                      </div>
                      <ul className="space-y-3 mb-8 flex-1">
                        {plan.features.map((feature) => (
                          <li key={feature} className="flex items-center gap-2 text-sm">
                            <Check className="size-4 text-emerald-500 shrink-0" />
                            {feature}
                          </li>
                        ))}
                      </ul>
                      <Button
                        className={`w-full ${
                          plan.popular
                            ? 'bg-emerald-500 hover:bg-emerald-600 text-white'
                            : ''
                        }`}
                        variant={plan.popular ? 'default' : 'outline'}
                        onClick={onGetStarted}
                      >
                        Get Started
                      </Button>
                    </CardContent>
                  </Card>
                </StaggerCard>
              ))}
            </div>
          </div>
        </section>

        {/* ─── CTA ─── */}
        <section className="relative overflow-hidden bg-[#0a0a0a] text-white py-20 sm:py-28">
          {/* Background glow */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            <div
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[400px] rounded-full opacity-20 blur-[160px]"
              style={{
                background:
                  'radial-gradient(circle, #10b981 0%, transparent 70%)',
              }}
            />
          </div>

          <div className="relative mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 text-center">
            <ScrollReveal>
              {/* Animated gradient border card */}
              <div className="relative rounded-2xl p-[2px] animate-gradient-border" style={{ background: 'linear-gradient(90deg, #10b981, #059669, #34d399, #10b981)', backgroundSize: '300% 300%' }}>
                <div className="rounded-2xl bg-[#0a0a0a] px-8 py-14 sm:px-16 sm:py-16">
                  <h2 className="text-3xl sm:text-5xl font-extrabold tracking-tight mb-4">
                    Ready to Deploy?
                  </h2>
                  <p className="text-zinc-400 text-lg mb-8 max-w-lg mx-auto">
                    Start building and deploying today. No credit card required.
                  </p>
                  <div className="relative inline-block">
                    <div className="absolute inset-0 rounded-md animate-pulse-glow" />
                    <Button
                      size="lg"
                      className="relative bg-emerald-500 hover:bg-emerald-600 text-white px-10 h-12 text-base"
                      onClick={onGetStarted}
                    >
                      Get Started Free
                      <ArrowRight className="size-4 ml-1" />
                    </Button>
                  </div>
                </div>
              </div>
            </ScrollReveal>
          </div>
        </section>
      </main>

      {/* ─── FOOTER ─── */}
      <footer className="mt-auto" style={{ borderTop: '1px solid transparent', borderImage: 'linear-gradient(to right, transparent, #10b981, transparent) 1' }}>
        <div className="bg-muted/30">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-8">
              {/* Brand */}
              <div className="col-span-2 md:col-span-1">
                <div className="flex items-center gap-2 mb-3">
                  <Globe className="size-5 text-emerald-500" />
                  <span className="font-bold text-lg">DeployHub</span>
                </div>
                <p className="text-sm text-muted-foreground max-w-[200px]">
                  The modern deployment platform for teams of all sizes.
                </p>
              </div>

              {/* Link groups */}
              {Object.entries(footerLinks).map(([heading, links]) => (
                <div key={heading}>
                  <h4 className="font-semibold text-sm mb-3">{heading}</h4>
                  <ul className="space-y-2">
                    {links.map((link) => (
                      <li key={link}>
                        <a
                          href="#"
                          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {link}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <div className="mt-12 pt-8 border-t text-center">
              <p className="text-sm text-muted-foreground">
                © 2024 DeployHub. All rights reserved.
              </p>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}
