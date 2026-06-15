'use client'

import { useState } from 'react'
import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'
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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface LandingPageProps {
  onGetStarted: () => void
  onLogin: () => void
}

/* ─── animation helpers ─── */
function FadeIn({
  children,
  delay = 0,
  direction = 'up',
  className = '',
}: {
  children: React.ReactNode
  delay?: number
  direction?: 'up' | 'down' | 'left' | 'right'
  className?: string
}) {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-60px' })

  const dirs = {
    up: { y: 40, x: 0 },
    down: { y: -40, x: 0 },
    left: { y: 0, x: 40 },
    right: { y: 0, x: -40 },
  }

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, ...dirs[direction] }}
      animate={isInView ? { opacity: 1, y: 0, x: 0 } : {}}
      transition={{ duration: 0.6, delay, ease: 'easeOut' }}
      className={className}
    >
      {children}
    </motion.div>
  )
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
  { value: '10,000+', label: 'Deployments' },
  { value: '5,000+', label: 'Domains Registered' },
  { value: '99.9%', label: 'Uptime' },
  { value: '50+', label: 'Countries' },
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

/* ─── main component ─── */
export default function LandingPage({ onGetStarted, onLogin }: LandingPageProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

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
                className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Features
              </a>
              <a
                href="#pricing"
                className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Pricing
              </a>
              <a
                href="#"
                className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Docs
              </a>
            </div>

            {/* Desktop CTA */}
            <div className="hidden md:flex items-center gap-3">
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
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="md:hidden border-t py-4 space-y-3"
            >
              <a href="#features" className="block text-sm font-medium text-muted-foreground hover:text-foreground px-2 py-1">
                Features
              </a>
              <a href="#pricing" className="block text-sm font-medium text-muted-foreground hover:text-foreground px-2 py-1">
                Pricing
              </a>
              <a href="#" className="block text-sm font-medium text-muted-foreground hover:text-foreground px-2 py-1">
                Docs
              </a>
              <div className="flex gap-3 pt-2 px-2">
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
            </motion.div>
          )}
        </div>
      </nav>

      <main className="flex-1">
        {/* ─── HERO ─── */}
        <section className="relative overflow-hidden bg-[#0a0a0a] text-white">
          {/* Animated gradient orbs */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <div
              className="absolute -top-40 -left-40 w-[500px] h-[500px] rounded-full opacity-20 blur-[120px] animate-pulse"
              style={{
                background:
                  'radial-gradient(circle, #10b981 0%, transparent 70%)',
              }}
            />
            <div
              className="absolute top-20 right-[-10%] w-[400px] h-[400px] rounded-full opacity-15 blur-[100px] animate-pulse"
              style={{
                background:
                  'radial-gradient(circle, #059669 0%, transparent 70%)',
                animationDelay: '1s',
              }}
            />
            <div
              className="absolute bottom-0 left-1/3 w-[600px] h-[300px] rounded-full opacity-10 blur-[140px] animate-pulse"
              style={{
                background:
                  'radial-gradient(circle, #34d399 0%, transparent 70%)',
                animationDelay: '2s',
              }}
            />
          </div>

          <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-24 sm:py-32 lg:py-40 text-center">
            <FadeIn>
              <Badge
                variant="secondary"
                className="mb-6 bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20 text-sm px-4 py-1"
              >
                🚀 Now with automatic SSL &amp; DNS
              </Badge>
            </FadeIn>

            <FadeIn delay={0.1}>
              <h1 className="text-4xl sm:text-5xl lg:text-7xl font-extrabold tracking-tight leading-[1.1] mb-6">
                Deploy in Seconds,{' '}
                <span className="bg-gradient-to-r from-emerald-400 to-emerald-600 bg-clip-text text-transparent">
                  Scale Without Limits
                </span>
              </h1>
            </FadeIn>

            <FadeIn delay={0.2}>
              <p className="mx-auto max-w-2xl text-lg sm:text-xl text-zinc-400 mb-10 leading-relaxed">
                The all-in-one platform for hosting, domains, and deployments. Buy a domain, get
                hosting, and launch your site — automatically.
              </p>
            </FadeIn>

            <FadeIn delay={0.3}>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                <Button
                  size="lg"
                  className="bg-emerald-500 hover:bg-emerald-600 text-white px-8 h-12 text-base"
                  onClick={onGetStarted}
                >
                  Start Deploying
                  <ArrowRight className="size-4 ml-1" />
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  className="border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-white px-8 h-12 text-base"
                >
                  <Play className="size-4 mr-1" />
                  Watch Demo
                </Button>
              </div>
            </FadeIn>
          </div>
        </section>

        {/* ─── STATS BAR ─── */}
        <section className="border-b bg-muted/30">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
              {stats.map((stat, i) => (
                <FadeIn key={stat.label} delay={i * 0.1}>
                  <div className="space-y-1">
                    <p className="text-3xl sm:text-4xl font-bold text-emerald-500">
                      {stat.value}
                    </p>
                    <p className="text-sm text-muted-foreground">{stat.label}</p>
                  </div>
                </FadeIn>
              ))}
            </div>
          </div>
        </section>

        {/* ─── FEATURES ─── */}
        <section id="features" className="py-20 sm:py-28">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <FadeIn>
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
            </FadeIn>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {features.map((feature, i) => (
                <FadeIn key={feature.title} delay={i * 0.08}>
                  <Card className="group relative overflow-hidden border hover:border-emerald-500/50 hover:shadow-lg hover:shadow-emerald-500/5 transition-all duration-300 h-full">
                    <CardHeader>
                      <div className="mb-2 flex size-11 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500 group-hover:bg-emerald-500/20 transition-colors">
                        <feature.icon className="size-5" />
                      </div>
                      <CardTitle className="text-lg">{feature.title}</CardTitle>
                      <CardDescription className="text-sm">
                        {feature.description}
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </FadeIn>
              ))}
            </div>
          </div>
        </section>

        {/* ─── HOW IT WORKS ─── */}
        <section className="py-20 sm:py-28 bg-muted/30">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <FadeIn>
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
            </FadeIn>

            <div className="relative grid grid-cols-1 md:grid-cols-3 gap-8 lg:gap-12">
              {/* Connecting line (desktop) */}
              <div className="hidden md:block absolute top-[52px] left-[calc(16.67%+24px)] right-[calc(16.67%+24px)] h-px bg-gradient-to-r from-emerald-500/50 via-emerald-500/30 to-emerald-500/50" />

              {steps.map((step, i) => (
                <FadeIn key={step.step} delay={i * 0.15}>
                  <div className="flex flex-col items-center text-center">
                    <div className="relative z-10 flex size-[52px] items-center justify-center rounded-full bg-emerald-500 text-white font-bold text-lg shadow-lg shadow-emerald-500/25 mb-6">
                      {step.step}
                    </div>
                    <h3 className="text-xl font-semibold mb-2">{step.title}</h3>
                    <p className="text-muted-foreground max-w-xs">{step.description}</p>
                  </div>
                </FadeIn>
              ))}
            </div>
          </div>
        </section>

        {/* ─── PRICING ─── */}
        <section id="pricing" className="py-20 sm:py-28">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <FadeIn>
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
            </FadeIn>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8 max-w-5xl mx-auto">
              {pricingPlans.map((plan, i) => (
                <FadeIn key={plan.name} delay={i * 0.1}>
                  <Card
                    className={`relative flex flex-col h-full transition-all duration-300 hover:shadow-lg ${
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
                </FadeIn>
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
            <FadeIn>
              <h2 className="text-3xl sm:text-5xl font-extrabold tracking-tight mb-4">
                Ready to Deploy?
              </h2>
            </FadeIn>
            <FadeIn delay={0.1}>
              <p className="text-zinc-400 text-lg mb-8 max-w-lg mx-auto">
                Start building and deploying today. No credit card required.
              </p>
            </FadeIn>
            <FadeIn delay={0.2}>
              <Button
                size="lg"
                className="bg-emerald-500 hover:bg-emerald-600 text-white px-10 h-12 text-base"
                onClick={onGetStarted}
              >
                Get Started Free
                <ArrowRight className="size-4 ml-1" />
              </Button>
            </FadeIn>
          </div>
        </section>
      </main>

      {/* ─── FOOTER ─── */}
      <footer className="border-t bg-muted/30 mt-auto">
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
      </footer>
    </div>
  )
}
