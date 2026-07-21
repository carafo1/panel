'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from '@/components/ui/accordion'
import {
  ArrowRight, Check, Sparkles, LayoutGrid, Server, Globe, Code2,
  Shield, Users, CreditCard, Lock, Database, Bell, Mail, Webhook,
  KeyRound, FileText, BarChart3, Building2, Rocket, Layers, Cpu,
} from 'lucide-react'
import { PageHero, ScrollReveal, StaggerCard, useCountUp } from '../ui-helpers'
import { useAppStore } from '@/store/app-store'
import { useSiteContent, useServiceBySlug } from '../site-data-context'

const STATS = [
  { value: 6, suffix: 'mo', label: 'Boilerplate saved' },
  { value: 100, suffix: '%', label: 'Code ownership' },
  { value: 4, suffix: 'wks', label: 'Avg. time to launch' },
  { value: 50, suffix: 'k', label: 'Users supported' },
]

const MODULES = [
  {
    icon: KeyRound,
    title: 'Authentication',
    desc: 'Email + password, OAuth (Google, GitHub, Apple), 2FA, magic links, session management, and password reset — all production-ready.',
    tags: ['OAuth', '2FA', 'Magic links', 'Sessions'],
  },
  {
    icon: Building2,
    title: 'Multi-tenancy',
    desc: 'Row-level security, tenant isolation, per-tenant config, and custom domains. Add new tenants with zero schema migrations.',
    tags: ['RLS', 'Isolation', 'Custom domains'],
  },
  {
    icon: CreditCard,
    title: 'Subscription Billing',
    desc: 'Stripe-powered subscriptions, multiple tiers, usage-based billing, invoices, trials, coupons, and dunning — fully automated.',
    tags: ['Stripe', 'Invoicing', 'Trials', 'Dunning'],
  },
  {
    icon: Users,
    title: 'Teams & RBAC',
    desc: 'Team management, invitations, role-based access control, and granular permissions. Enterprise-ready org structures.',
    tags: ['RBAC', 'Invites', 'Permissions'],
  },
  {
    icon: BarChart3,
    title: 'Admin Dashboard',
    desc: 'Full admin console with user management, revenue analytics, audit logs, and feature flags — control everything from one place.',
    tags: ['Analytics', 'Audit logs', 'Feature flags'],
  },
  {
    icon: Mail,
    title: 'Onboarding & Email',
    desc: 'Welcome flows, transactional emails, email verification, and lifecycle automation. React Email templates included.',
    tags: ['React Email', 'Automation', 'Lifecycle'],
  },
  {
    icon: Webhook,
    title: 'Webhooks & Integrations',
    desc: 'Outbound webhooks, event system, and pre-built integrations with Slack, Discord, Zapier, and your custom endpoints.',
    tags: ['Webhooks', 'Slack', 'Zapier'],
  },
  {
    icon: Shield,
    title: 'Security & Compliance',
    desc: 'Audit logs, data residency options, GDPR tools, SSO/SAML on Enterprise. Built to pass SOC2 / HIPAA / ISO 27001.',
    tags: ['SSO', 'GDPR', 'SOC2', 'HIPAA'],
  },
]

const ARCHITECTURE_LAYERS = [
  {
    icon: LayoutGrid,
    layer: 'Presentation',
    desc: 'Next.js App Router, server components, streaming, optimistic UI. Polished onboarding + dashboards out of the box.',
    items: ['Next.js 16', 'Server Components', 'shadcn/ui', 'Optimistic UI'],
  },
  {
    icon: Server,
    layer: 'Application',
    desc: 'Type-safe API layer with tRPC / Zod validation. Background jobs, queues, and cron workers for async work.',
    items: ['tRPC', 'Zod validation', 'Job queues', 'Cron workers'],
  },
  {
    icon: Database,
    layer: 'Data',
    desc: 'Postgres with Prisma ORM. Row-level security for tenant isolation. Redis for caching and sessions.',
    items: ['PostgreSQL', 'Prisma', 'Row-level security', 'Redis'],
  },
  {
    icon: Cpu,
    layer: 'Infrastructure',
    desc: 'Containerized deploys on a global edge network. Observability, error tracking, and log aggregation baked in.',
    items: ['Docker', 'Edge network', 'Observability', 'Error tracking'],
  },
]

const INTEGRATIONS = [
  { name: 'Stripe', desc: 'Payments & subscriptions' },
  { name: 'Google OAuth', desc: 'Sign in with Google' },
  { name: 'GitHub OAuth', desc: 'Sign in with GitHub' },
  { name: 'Apple OAuth', desc: 'Sign in with Apple' },
  { name: 'Waafi', desc: 'East Africa payments' },
  { name: 'Resend', desc: 'Transactional email' },
  { name: 'Slack', desc: 'Notifications & alerts' },
  { name: 'Postgres', desc: 'Primary database' },
  { name: 'Redis', desc: 'Cache & sessions' },
  { name: 'Sentry', desc: 'Error tracking' },
  { name: 'PostHog', desc: 'Product analytics' },
  { name: 'Cloudflare', desc: 'CDN & WAF' },
]

const FALLBACK_PLANS = [
  {
    name: 'MVP',
    price: 99,
    period: '/mo',
    description: 'For founders validating their SaaS idea.',
    features: [
      'Up to 1,000 users',
      'Email + OAuth auth',
      'Single subscription plan',
      'Basic admin dashboard',
      '5 team members',
      'Email support',
    ],
  },
  {
    name: 'Scale',
    price: 199,
    period: '/mo',
    description: 'For SaaS products in active growth.',
    features: [
      'Up to 50,000 users',
      '2FA + magic links',
      'Multiple subscription tiers',
      'Full admin + audit logs',
      'Unlimited team members',
      'Custom integrations',
      'Priority support',
    ],
    popular: true,
  },
  {
    name: 'Enterprise',
    price: 499,
    period: '/mo',
    description: 'For mission-critical SaaS at scale.',
    features: [
      'Unlimited users',
      'SSO / SAML / SCIM',
      'Custom billing & contracts',
      'Dedicated infrastructure',
      'SLA + 24/7 support',
      'Custom compliance (SOC2, HIPAA)',
      'Dedicated success manager',
    ],
  },
]

const FALLBACK_FAQS = [
  {
    q: 'Do I own the SaaS codebase?',
    a: 'Yes. You own 100% of the code, infrastructure, and IP. We deliver everything in your private GitHub repo and hand over all credentials.',
  },
  {
    q: 'Can I start with just the MVP and upgrade later?',
    a: 'Of course. The MVP plan gives you a fully working SaaS in weeks. When you outgrow it, upgrading to Scale or Enterprise is a 1-click plan change — no migration needed.',
  },
  {
    q: 'Which payment methods are supported?',
    a: 'Stripe (cards, Apple/Google Pay, Stripe Checkout), plus local methods like Waafi for East Africa. We can integrate additional gateways on request.',
  },
  {
    q: 'Do you handle compliance (SOC2, HIPAA)?',
    a: 'The Enterprise plan includes compliance scaffolding: audit logs, RBAC, data residency. We partner with compliance auditors for the formal certification process if needed.',
  },
]

interface SaasSystemPageProps {
  onGetStarted: () => void
}

export function SaasSystemPage({ onGetStarted }: SaasSystemPageProps) {
  const { setPublicPage } = useAppStore()
  const { getContent } = useSiteContent()
  const service = useServiceBySlug('saas-system')
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
        badge={getContent('svc.saas-system.hero.badge')}
        title={getContent('svc.saas-system.hero.title')}
        subtitle={getContent('svc.saas-system.hero.subtitle')}
      />

      {/* Stats bar */}
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

      {/* Modules grid */}
      <section className="py-24 bg-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-14">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">What&apos;s Included</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight"><span className="text-gradient-brand">{getContent('svc.saas-system.modules.title')}</span></h2>
              <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">Eight production-ready modules that would take a solo founder six months to build. We ship them on day one.</p>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {MODULES.map((m, i) => {
              const Icon = m.icon
              return (
                <StaggerCard key={m.title} index={i}>
                  <Card className="group relative overflow-hidden border hover:border-indigo-500/40 hover:shadow-glow-indigo transition-all duration-500 h-full bg-card/80 backdrop-blur-sm">
                    <div className="absolute -top-16 -right-16 size-40 rounded-full bg-indigo-500/10 blur-3xl group-hover:bg-indigo-500/20 transition-all duration-500" />
                    <CardContent className="p-6 sm:p-7 relative">
                      <div className="flex items-start gap-4 mb-4">
                        <div className="flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-glow-indigo group-hover:scale-110 transition-transform duration-500 shrink-0">
                          <Icon className="size-5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="text-lg font-bold">{m.title}</h3>
                          <p className="text-sm text-muted-foreground leading-relaxed mt-1">{m.desc}</p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 mt-4">
                        {m.tags.map((tag) => (
                          <span key={tag} className="inline-flex items-center gap-1 rounded-lg bg-indigo-500/10 px-2.5 py-1 text-xs font-medium text-indigo-600 dark:text-indigo-300">
                            <Check className="size-3" />
                            {tag}
                          </span>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                </StaggerCard>
              )
            })}
          </div>
        </div>
      </section>

      {/* Architecture layers */}
      <section className="py-24 bg-muted/30">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-14">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">Architecture</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight"><span className="text-gradient-brand">{getContent('svc.saas-system.arch.title')}</span></h2>
              <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">Four clean layers, each with a single responsibility. Types flow end-to-end — from database to UI — eliminating entire classes of bugs.</p>
            </div>
          </ScrollReveal>
          <div className="space-y-4 max-w-4xl mx-auto">
            {ARCHITECTURE_LAYERS.map((layer, i) => {
              const Icon = layer.icon
              return (
                <StaggerCard key={layer.layer} index={i}>
                  <Card className="group relative overflow-hidden border hover:border-indigo-500/40 hover:shadow-glow-indigo transition-all duration-500 bg-card/80 backdrop-blur-sm">
                    <div className="absolute -top-12 -right-12 size-32 rounded-full bg-indigo-500/10 blur-3xl group-hover:bg-indigo-500/20 transition-all duration-500" />
                    <CardContent className="p-6 relative flex flex-col md:flex-row md:items-center gap-5">
                      <div className="flex items-center gap-4 md:w-56 shrink-0">
                        <div className="flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-glow-indigo">
                          <Icon className="size-5" />
                        </div>
                        <div>
                          <div className="text-xs font-bold text-indigo-600 dark:text-indigo-400">LAYER {i + 1}</div>
                          <h3 className="text-lg font-bold">{layer.layer}</h3>
                        </div>
                      </div>
                      <p className="text-sm text-muted-foreground leading-relaxed flex-1">{layer.desc}</p>
                      <div className="flex flex-wrap gap-1.5 md:w-64">
                        {layer.items.map((item) => (
                          <span key={item} className="inline-flex items-center rounded-md bg-indigo-500/10 px-2 py-0.5 text-xs font-medium text-indigo-600 dark:text-indigo-300">
                            {item}
                          </span>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                </StaggerCard>
              )
            })}
          </div>
        </div>
      </section>

      {/* Integrations */}
      <section className="py-24 bg-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-14">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">Integrations</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight"><span className="text-gradient-brand">{getContent('svc.saas-system.integrations.title')}</span></h2>
              <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">Battle-tested integrations shipped ready-to-use. No weeks of API wrangling — just plug in your keys and go.</p>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {INTEGRATIONS.map((int, i) => (
              <StaggerCard key={int.name} index={i}>
                <Card className="group border hover:border-indigo-500/40 hover:shadow-glow-indigo transition-all duration-500 h-full bg-card/80 backdrop-blur-sm">
                  <CardContent className="p-4 flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500/90 to-indigo-700 text-white shadow-glow-indigo group-hover:scale-110 transition-transform duration-500 shrink-0">
                      <Layers className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-bold truncate">{int.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{int.desc}</p>
                    </div>
                  </CardContent>
                </Card>
              </StaggerCard>
            ))}
          </div>
        </div>
      </section>

      {/* Why APSAMO SaaS */}
      <section className="py-24 bg-muted/30">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <ScrollReveal>
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">Why Apsamo Technology</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4"><span className="text-gradient-brand">{getContent('svc.saas-system.boilerplate.title')}</span></h2>
              <p className="text-muted-foreground leading-relaxed mb-6">
                Auth, billing, teams, audit logs, onboarding flows — all the unsexy infrastructure that takes a solo founder half a year to build. We ship it day one, tested and production-hardened. You focus on your product; we handle the plumbing.
              </p>
              <ul className="space-y-3">
                {[
                  'Launch a working SaaS in 4 weeks, not 6 months',
                  'Own 100% of the code, infra, and IP',
                  'Upgrade plans in one click — no migrations',
                  'Compliance-ready from day one (SOC2 / HIPAA)',
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <div className="flex size-6 items-center justify-center rounded-md bg-indigo-500/15 shrink-0 mt-0.5">
                      <Check className="size-3.5 text-indigo-600 dark:text-indigo-400" />
                    </div>
                    <span className="text-sm font-medium">{item}</span>
                  </li>
                ))}
              </ul>
            </ScrollReveal>
            <ScrollReveal delay={150}>
              <Card className="relative overflow-hidden border-indigo-500/30 shadow-glow-indigo bg-card/80 backdrop-blur-sm">
                <div className="absolute -top-20 -right-20 size-56 rounded-full bg-indigo-500/15 blur-3xl" />
                <CardContent className="p-6 sm:p-8 relative">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-glow-indigo">
                      <Bell className="size-5" />
                    </div>
                    <div>
                      <h3 className="text-lg font-bold">What you get on day one</h3>
                      <p className="text-xs text-muted-foreground">A complete, working SaaS skeleton</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { icon: Lock, label: 'Auth & sessions' },
                      { icon: Building2, label: 'Multi-tenant DB' },
                      { icon: CreditCard, label: 'Stripe billing' },
                      { icon: Users, label: 'Teams & RBAC' },
                      { icon: BarChart3, label: 'Admin dashboard' },
                      { icon: FileText, label: 'Audit logs' },
                      { icon: Mail, label: 'Email automation' },
                      { icon: Webhook, label: 'Webhooks' },
                    ].map((item) => {
                      const Icon = item.icon
                      return (
                        <div key={item.label} className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2">
                          <Icon className="size-4 text-indigo-500 shrink-0" />
                          <span className="text-xs font-medium">{item.label}</span>
                        </div>
                      )
                    })}
                  </div>
                </CardContent>
              </Card>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="py-24 bg-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-14">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">Pricing</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight"><span className="text-gradient-brand">{getContent('svc.saas-system.pricing.title')}</span></h2>
              <p className="mt-3 text-muted-foreground">Start with the MVP, upgrade when you scale. One click, no migration.</p>
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
      <section className="py-24 bg-muted/30">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-10">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">FAQ</Badge>
              <h2 className="text-3xl font-extrabold tracking-tight">{getContent('svc.saas-system.faq.title')}</h2>
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
            <h2 className="text-3xl sm:text-5xl font-extrabold tracking-tight mb-4"><span className="text-gradient-brand">{getContent('svc.saas-system.cta.title')}</span></h2>
            <p className="text-zinc-300 text-lg mb-8 max-w-xl mx-auto">Skip the boilerplate. Ship the product. We&apos;ll handle auth, billing, teams, and everything in between.</p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button size="lg" className="btn-shimmer bg-indigo-500 hover:bg-indigo-600 text-white px-10 h-12 border-0 shadow-glow-indigo hover:scale-105 transition-all" onClick={onGetStarted}>
                <Rocket className="size-4 mr-2" />
                {getContent('svc.saas-system.cta.button')}
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
