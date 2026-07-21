'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from '@/components/ui/accordion'
import {
  ArrowRight, Check, Sparkles, Server, Globe, GitBranch, Zap,
  Shield, Activity, RotateCcw, Lock, HardDrive, Network, Gauge,
  Cloud, RefreshCw, Cpu, Layers, ArrowDown,
} from 'lucide-react'
import { PageHero, ScrollReveal, StaggerCard, useCountUp } from '../ui-helpers'
import { useAppStore } from '@/store/app-store'
import { useSiteContent, useServiceBySlug } from '../site-data-context'

const STATS = [
  { value: 99.97, suffix: '%', label: '12-month uptime' },
  { value: 280, suffix: '+', label: 'Edge locations' },
  { value: 30, suffix: 's', label: 'Avg. deploy time' },
  { value: 50, suffix: 'ms', label: 'Global TTFB' },
]

const DEPLOY_FLOW = [
  { icon: GitBranch, title: 'Push to Git', desc: 'Connect your GitHub repo. Every push to main triggers a build.', color: 'from-indigo-400 to-indigo-500' },
  { icon: Cpu, title: 'Auto Build', desc: 'We detect your framework, install deps, and build in an isolated container.', color: 'from-indigo-500 to-indigo-600' },
  { icon: Cloud, title: 'Deploy', desc: 'Zero-downtime rolling deploy to the edge. Your new version is live in seconds.', color: 'from-indigo-600 to-indigo-700' },
  { icon: Gauge, title: 'Scale', desc: 'Autoscaling handles traffic spikes automatically. Pay only for what you use.', color: 'from-indigo-500 to-indigo-700' },
]

const FEATURES = [
  { icon: Lock, title: 'Automatic SSL', desc: 'Free Let\u2019s Encrypt certificates, auto-renewed and auto-installed. Never think about HTTPS again.' },
  { icon: Globe, title: 'Global CDN', desc: 'Static assets served from 280+ edge locations. Sub-50ms TTFB anywhere on earth.' },
  { icon: RotateCcw, title: 'Instant Rollbacks', desc: 'Every deploy is immutable and versioned. Bad push? Roll back in one click, zero downtime.' },
  { icon: Activity, title: 'Real-time Logs', desc: 'Stream build, runtime, and access logs live. Filter, search, and export on demand.' },
  { icon: Network, title: 'Custom Domains', desc: 'Unlimited custom domains per project. DNS and SSL configured automatically.' },
  { icon: HardDrive, title: 'Managed Postgres', desc: 'Add a database with one click. Daily backups, point-in-time recovery, read replicas.' },
  { icon: Zap, title: 'Cron & Workers', desc: 'Schedule background jobs and run long-lived workers alongside your web service.' },
  { icon: Shield, title: 'DDoS Protection', desc: 'Enterprise-grade DDoS mitigation and WAF included on every plan, at no extra cost.' },
]

const REGIONS = [
  { city: 'Mogadishu', region: 'East Africa' },
  { city: 'Nairobi', region: 'East Africa' },
  { city: 'Cape Town', region: 'Africa' },
  { city: 'Dubai', region: 'Middle East' },
  { city: 'Frankfurt', region: 'Europe' },
  { city: 'London', region: 'Europe' },
  { city: 'New York', region: 'N. America' },
  { city: 'San Francisco', region: 'N. America' },
  { city: 'Singapore', region: 'Asia' },
  { city: 'Tokyo', region: 'Asia' },
  { city: 'Sydney', region: 'Oceania' },
  { city: 'São Paulo', region: 'S. America' },
]

const BENCHMARKS = [
  { label: 'Cold start', us: '180ms', them: '2.4s', win: true },
  { label: 'Deploy time', us: '30s', them: '8m', win: true },
  { label: 'TTFB (p95)', us: '48ms', them: '320ms', win: true },
  { label: 'Rollback', us: '1 click', them: 'manual', win: true },
]

const FALLBACK_PLANS = [
  {
    name: 'Hobby',
    price: 9,
    period: '/mo',
    description: 'Personal projects and side hustles.',
    features: [
      '1 project',
      '1 GB RAM / 1 vCPU',
      '10 GB SSD storage',
      '100 GB bandwidth',
      'Automatic SSL',
      'Community support',
    ],
  },
  {
    name: 'Pro',
    price: 29,
    period: '/mo',
    description: 'Production apps that need to scale.',
    features: [
      '10 projects',
      '4 GB RAM / 2 vCPU',
      '50 GB SSD storage',
      '500 GB bandwidth',
      'Custom domains',
      'Cron jobs & workers',
      'Priority support',
    ],
    popular: true,
  },
  {
    name: 'Business',
    price: 99,
    period: '/mo',
    description: 'Mission-critical workloads.',
    features: [
      'Unlimited projects',
      '16 GB RAM / 8 vCPU',
      '250 GB SSD storage',
      '2 TB bandwidth',
      'Team collaboration',
      'Dedicated IPs',
      '24/7 priority support',
      '99.9% uptime SLA',
    ],
  },
]

const FALLBACK_FAQS = [
  {
    q: 'Can I host any Dockerized app?',
    a: 'Yes. If it has a Dockerfile (or we auto-detect Node, Python, Go, Ruby, PHP), we can host it. Bring your compose file or use our templates.',
  },
  {
    q: 'Do you support custom domains?',
    a: 'Yes — every plan supports unlimited custom domains. We auto-provision SSL and configure DNS records for you.',
  },
  {
    q: 'What is your uptime SLA?',
    a: 'Business and Enterprise plans include a 99.9% uptime SLA with service credits if we miss it. Historical uptime is 99.97% over the last 12 months.',
  },
  {
    q: 'Can I scale vertically and horizontally?',
    a: 'Yes. Adjust RAM/CPU per project at any time, and enable autoscaling for stateless web services to handle traffic spikes.',
  },
]

interface HostingPageProps {
  onGetStarted: () => void
}

export function HostingPage({ onGetStarted }: HostingPageProps) {
  const { setPublicPage } = useAppStore()
  const { getContent } = useSiteContent()
  const service = useServiceBySlug('web-hosting')
  const plans = service?.plans?.length ? service.plans : FALLBACK_PLANS
  const faqs = service?.faqs?.length ? service.faqs : FALLBACK_FAQS
  const stat0 = useCountUp<HTMLParagraphElement>(STATS[0].value, 1800)
  const stat1 = useCountUp<HTMLParagraphElement>(STATS[1].value, 1800)
  const stat2 = useCountUp<HTMLParagraphElement>(STATS[2].value, 1800)
  const stat3 = useCountUp<HTMLParagraphElement>(STATS[3].value, 1800)
  const statRefs = [stat0, stat1, stat2, stat3]

  return (
    <>
      <PageHero
        badge={getContent('svc.web-hosting.hero.badge')}
        title={getContent('svc.web-hosting.hero.title')}
        subtitle={getContent('svc.web-hosting.hero.subtitle')}
      />

      {/* Infra stats */}
      <section className="border-b bg-background py-12">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {STATS.map((s, i) => (
              <ScrollReveal key={s.label} delay={i * 80}>
                <div className="rounded-2xl glass-light dark:glass p-5 text-center shadow-modern">
                  <p ref={statRefs[i].ref} className="text-3xl sm:text-4xl font-extrabold text-gradient-brand">
                    {statRefs[i].value}{s.suffix}
                  </p>
                  <p className="text-xs sm:text-sm text-muted-foreground mt-1">{s.label}</p>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      {/* Deploy flow */}
      <section className="py-24 bg-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-16">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">Deploy Flow</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight"><span className="text-gradient-brand">{getContent('svc.web-hosting.deploy.title')}</span></h2>
              <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">No SSH, no YAML, no DevOps hire required. Connect your repo and watch it ship.</p>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 relative">
            {DEPLOY_FLOW.map((step, i) => {
              const Icon = step.icon
              return (
                <StaggerCard key={step.title} index={i}>
                  <div className="relative">
                    {i < DEPLOY_FLOW.length - 1 && (
                      <div className="hidden md:block absolute top-8 left-[60%] w-full">
                        <ArrowRight className="size-5 text-indigo-400/60" />
                      </div>
                    )}
                    <Card className="relative z-10 border hover:border-indigo-500/40 hover:shadow-glow-indigo transition-all duration-500 h-full bg-card/80 backdrop-blur-sm text-center">
                      <CardContent className="p-6">
                        <div className={`mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br ${step.color} text-white shadow-glow-indigo`}>
                          <Icon className="size-7" />
                        </div>
                        <div className="text-xs font-bold text-indigo-600 dark:text-indigo-400 mb-1">STEP {i + 1}</div>
                        <h3 className="text-lg font-bold mb-1.5">{step.title}</h3>
                        <p className="text-sm text-muted-foreground leading-relaxed">{step.desc}</p>
                      </CardContent>
                    </Card>
                  </div>
                </StaggerCard>
              )
            })}
          </div>
        </div>
      </section>

      {/* Features grid */}
      <section className="py-24 bg-muted/30">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-14">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">Features</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight"><span className="text-gradient-brand">{getContent('svc.web-hosting.features.title')}</span></h2>
              <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">Every plan ships with the full feature set. You only pay for compute and bandwidth.</p>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {FEATURES.map((f, i) => {
              const Icon = f.icon
              return (
                <StaggerCard key={f.title} index={i}>
                  <Card className="group relative overflow-hidden border hover:border-indigo-500/40 hover:shadow-glow-indigo transition-all duration-500 h-full bg-card/80 backdrop-blur-sm">
                    <div className="absolute -top-12 -right-12 size-28 rounded-full bg-indigo-500/10 blur-3xl group-hover:bg-indigo-500/20 transition-all duration-500" />
                    <CardContent className="p-6 relative">
                      <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-glow-indigo group-hover:scale-110 transition-transform duration-500">
                        <Icon className="size-5" />
                      </div>
                      <h3 className="font-bold mb-1.5">{f.title}</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
                    </CardContent>
                  </Card>
                </StaggerCard>
              )
            })}
          </div>
        </div>
      </section>

      {/* Edge network + benchmarks */}
      <section className="py-24 bg-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <ScrollReveal>
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">Global Network</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4"><span className="text-gradient-brand">{getContent('svc.web-hosting.edge.title')}</span></h2>
              <p className="text-muted-foreground leading-relaxed mb-6">
                Your content is replicated across a global anycast network. Whichever region your users hit, the nearest edge node responds — typically in under 50ms.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {REGIONS.map((r) => (
                  <div key={r.city} className="flex items-center gap-2 rounded-lg border bg-card/60 px-3 py-2">
                    <Globe className="size-3.5 text-indigo-500 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold truncate">{r.city}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{r.region}</p>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollReveal>
            <ScrollReveal delay={150}>
              <Card className="relative overflow-hidden border-indigo-500/30 shadow-glow-indigo bg-card/80 backdrop-blur-sm">
                <div className="absolute -top-20 -right-20 size-56 rounded-full bg-indigo-500/15 blur-3xl" />
                <CardContent className="p-6 sm:p-8 relative">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-glow-indigo">
                      <Gauge className="size-5" />
                    </div>
                    <div>
                      <h3 className="text-lg font-bold">Apsamo Technology vs. The Rest</h3>
                      <p className="text-xs text-muted-foreground">Real benchmarks, same workload</p>
                    </div>
                  </div>
                  <div className="space-y-3">
                    {BENCHMARKS.map((b) => (
                      <div key={b.label} className="grid grid-cols-3 items-center gap-2 rounded-xl bg-muted/40 p-3">
                        <span className="text-sm font-medium">{b.label}</span>
                        <div className="text-center">
                          <div className="inline-flex items-center gap-1 rounded-md bg-indigo-500/15 px-2 py-0.5 text-sm font-bold text-indigo-600 dark:text-indigo-300">
                            <Check className="size-3" /> {b.us}
                          </div>
                          <p className="text-[10px] text-muted-foreground mt-0.5">Apsamo Technology</p>
                        </div>
                        <div className="text-center">
                          <div className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-sm font-medium text-muted-foreground">
                            {b.them}
                          </div>
                          <p className="text-[10px] text-muted-foreground mt-0.5">Others</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="py-24 bg-muted/30">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-14">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">Pricing</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight"><span className="text-gradient-brand">{getContent('svc.web-hosting.pricing.title')}</span></h2>
              <p className="mt-3 text-muted-foreground">Start on Hobby, upgrade in one click. No downtime, no migration.</p>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {plans.map((plan, i) => (
              <StaggerCard key={plan.name} index={i}>
                <Card className={`relative flex flex-col h-full transition-all duration-500 bg-card/80 backdrop-blur-sm ${plan.popular ? 'border-indigo-500 shadow-glow-indigo scale-[1.03] shimmer-border' : 'hover:border-indigo-500/30 hover:shadow-modern-lg'}`}>
                  {plan.popular && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <Badge className="bg-gradient-to-r from-indigo-400 to-indigo-600 text-white border-0 px-4 py-0.5 shadow-glow-indigo">POPULAR</Badge>
                    </div>
                  )}
                  <CardContent className="p-6 flex flex-col flex-1">
                    <h3 className="text-lg font-bold mb-1">{plan.name}</h3>
                    <p className="text-xs text-muted-foreground mb-4">{plan.description}</p>
                    <div className="flex items-baseline gap-1 mb-6">
                      <span className="text-4xl font-extrabold">${plan.price}</span>
                      <span className="text-sm text-muted-foreground">{plan.period}</span>
                    </div>
                    <ul className="space-y-2.5 mb-6 flex-1">
                      {plan.features.map((feat) => (
                        <li key={feat} className="flex items-start gap-2 text-sm">
                          <Check className="size-4 text-indigo-500 shrink-0 mt-0.5" />
                          <span className="text-muted-foreground">{feat}</span>
                        </li>
                      ))}
                    </ul>
                    <Button onClick={onGetStarted} className={plan.popular ? 'btn-shimmer w-full bg-indigo-500 hover:bg-indigo-600 text-white border-0 shadow-glow-indigo' : 'w-full'} variant={plan.popular ? 'default' : 'outline'}>
                      Get Started
                    </Button>
                  </CardContent>
                </Card>
              </StaggerCard>
            ))}
          </div>
        </div>
      </section>

      {/* FAQs */}
      <section className="py-24 bg-background">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-10">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">FAQ</Badge>
              <h2 className="text-3xl font-extrabold tracking-tight">{getContent('svc.web-hosting.faq.title')}</h2>
            </div>
          </ScrollReveal>
          <Accordion type="single" collapsible className="w-full">
            {faqs.map((faq, i) => (
              <AccordionItem key={i} value={`item-${i}`}>
                <AccordionTrigger className="text-left">{faq.q}</AccordionTrigger>
                <AccordionContent className="text-muted-foreground">{faq.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {/* CTA */}
      <section className="relative overflow-hidden aurora-bg text-white grain-overlay" style={{ backgroundColor: '#1E1A47' }}>
        <div className="aurora-blob aurora-blob-1" style={{ top: '-10%', right: '10%', width: '450px', height: '450px', background: 'radial-gradient(circle, #706FD3 0%, transparent 70%)' }} />
        <div className="aurora-blob aurora-blob-2" style={{ bottom: '-15%', left: '5%', width: '420px', height: '420px', background: 'radial-gradient(circle, #8888FF 0%, transparent 70%)' }} />
        <div className="relative z-10 mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 text-center py-24">
          <ScrollReveal>
            <h2 className="text-3xl sm:text-5xl font-extrabold tracking-tight mb-4"><span className="text-gradient-brand">{getContent('svc.web-hosting.cta.title')}</span></h2>
            <p className="text-zinc-300 text-lg mb-8 max-w-xl mx-auto">Connect a repo, pick a plan, and go live in under five minutes. No credit card to start.</p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button size="lg" className="btn-shimmer bg-indigo-500 hover:bg-indigo-600 text-white px-10 h-12 border-0 shadow-glow-indigo hover:scale-105 transition-all" onClick={onGetStarted}>
                <Server className="size-4 mr-2" />
                {getContent('svc.web-hosting.cta.button')}
                <ArrowRight className="size-4 ml-2" />
              </Button>
              <button onClick={() => setPublicPage({ page: 'services' })} className="inline-flex items-center justify-center gap-2 h-12 px-8 rounded-md glass text-white hover:bg-white/10 transition-all">
                <Layers className="size-4 text-indigo-300" />
                View All Services
              </button>
            </div>
          </ScrollReveal>
        </div>
      </section>
    </>
  )
}
