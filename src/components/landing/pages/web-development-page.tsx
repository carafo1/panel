'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from '@/components/ui/accordion'
import {
  ArrowRight, Check, Sparkles, Code2, LayoutGrid, Globe, Server,
  Zap, Shield, GitBranch, Boxes, Database, Cpu, Cloud, Palette,
  Rocket, PenTool, Terminal, Layers,
} from 'lucide-react'
import { PageHero, ScrollReveal, StaggerCard } from '../ui-helpers'
import { useAppStore } from '@/store/app-store'

const STATS = [
  { value: '500+', label: 'Projects shipped' },
  { value: '14d', label: 'Avg. delivery' },
  { value: '100%', label: 'Code ownership' },
  { value: 'Lighthouse', label: '95+ avg score' },
]

const TECH_CATEGORIES = [
  {
    icon: Palette,
    title: 'Frontend',
    desc: 'Pixel-perfect, accessible interfaces.',
    items: ['Next.js 16', 'React 19', 'TypeScript', 'Tailwind CSS', 'shadcn/ui', 'Framer Motion'],
  },
  {
    icon: Server,
    title: 'Backend',
    desc: 'Robust APIs and serverless logic.',
    items: ['Node.js', 'tRPC', 'Prisma ORM', 'PostgreSQL', 'Redis', 'Edge functions'],
  },
  {
    icon: Boxes,
    title: 'Infrastructure',
    desc: 'Scalable, observable deployments.',
    items: ['Docker', 'AWS', 'Cloudflare', 'GitHub Actions', 'Vercel', 'Terraform'],
  },
  {
    icon: Database,
    title: 'Data & Realtime',
    desc: 'Persistent and live data layers.',
    items: ['Postgres', 'Prisma', 'Socket.io', 'WebSockets', 'SSE', 'Queues'],
  },
]

const PROCESS = [
  {
    icon: PenTool,
    step: '01',
    title: 'Discovery & Design',
    desc: 'We map your goals, define the scope, and craft a UI/UX that matches your brand — wireframes, flows, and a clickable prototype before a single line of code.',
  },
  {
    icon: LayoutGrid,
    step: '02',
    title: 'Architecture',
    desc: 'We design the data model, API contracts, and system architecture. Type-safe schemas shared across frontend, backend, and database from day one.',
  },
  {
    icon: Code2,
    step: '03',
    title: 'Build & Iterate',
    desc: 'Sprint-based development with weekly demos. You see real progress every week, with the ability to steer direction as the product takes shape.',
  },
  {
    icon: Shield,
    step: '04',
    title: 'Test & Harden',
    desc: 'Automated tests, performance audits, accessibility checks, and security reviews. We ship code that survives contact with real users.',
  },
  {
    icon: Rocket,
    step: '05',
    title: 'Launch & Scale',
    desc: 'Zero-downtime deploy, monitoring, and observability baked in. We hand over the keys — code, infra, and docs — and stay on call during support.',
  },
]

const CAPABILITIES = [
  { icon: Globe, title: 'SEO & Core Web Vitals', desc: 'Server-rendered, structured data, sub-1s LCP. Built to rank from launch.' },
  { icon: Zap, title: 'Real-time Features', desc: 'Live dashboards, collaboration, chat, and notifications via WebSockets.' },
  { icon: Shield, title: 'Auth & Security', desc: 'OAuth, 2FA, magic links, RBAC. Security-first by default, not an afterthought.' },
  { icon: GitBranch, title: 'CI/CD Pipelines', desc: 'Every push triggers tests, builds, and safe deploys with instant rollbacks.' },
  { icon: Layers, title: 'Headless CMS', desc: 'Sanity, Contentful, or a custom admin — your editors get a friendly cockpit.' },
  { icon: Cpu, title: 'AI Integration', desc: 'LLM features, vector search, and RAG pipelines wired into your product.' },
]

const PLANS = [
  {
    name: 'Starter',
    price: 49,
    period: '/project',
    description: 'Landing pages and small MVPs.',
    features: [
      'Up to 5 pages',
      'Responsive design',
      'Basic SEO setup',
      'Contact form integration',
      '2 rounds of revisions',
      '14-day delivery',
    ],
  },
  {
    name: 'Growth',
    price: 199,
    period: '/project',
    description: 'Full marketing site or interactive web app.',
    features: [
      'Up to 15 pages',
      'CMS integration',
      'Custom animations',
      'Analytics & A/B testing',
      'Unlimited revisions',
      '30-day delivery',
      '90-day support',
    ],
    popular: true,
  },
  {
    name: 'Enterprise',
    price: 299,
    period: '/project',
    description: 'Complex apps with custom integrations.',
    features: [
      'Unlimited pages',
      'Custom backend & APIs',
      'Third-party integrations',
      'Performance optimization',
      'Dedicated project manager',
      '60-day delivery',
      '1-year priority support',
    ],
  },
]

const FAQS = [
  {
    q: 'What technologies do you use?',
    a: 'We primarily build with Next.js 16, TypeScript, Tailwind CSS, Prisma, and Postgres. For real-time features we use Socket.io. We can also work with your existing stack if needed.',
  },
  {
    q: 'Do you provide the source code?',
    a: 'Absolutely. You own 100% of the source code, IP, and infrastructure. We deliver everything via your own private GitHub repository.',
  },
  {
    q: 'How long does a typical project take?',
    a: 'Marketing sites ship in 2–3 weeks. Full web apps typically take 4–8 weeks depending on complexity. We give you a fixed timeline before kickoff.',
  },
  {
    q: 'What about ongoing maintenance?',
    a: 'Every plan includes a support window. After that, you can subscribe to our managed hosting plan for continuous updates, monitoring, and bug fixes.',
  },
]

const CODE_LINES = [
  { n: 1, t: "// app/api/domains/route.ts", c: "text-muted-foreground" },
  { n: 2, t: "import { db } from '@/lib/db'", c: "text-indigo-400" },
  { n: 3, t: "import { NextResponse } from 'next/server'", c: "text-indigo-400" },
  { n: 4, t: "", c: "" },
  { n: 5, t: "export async function GET() {", c: "text-pink-400" },
  { n: 6, t: "  const domains = await db.domain.findMany({", c: "" },
  { n: 7, t: "    where: { status: 'active' },", c: "" },
  { n: 8, t: "    include: { dns: true },", c: "" },
  { n: 9, t: "    orderBy: { createdAt: 'desc' },", c: "" },
  { n: 10, t: "  })", c: "" },
  { n: 11, t: "  return NextResponse.json(domains)", c: "" },
  { n: 12, t: "}", c: "text-pink-400" },
]

interface WebDevelopmentPageProps {
  onGetStarted: () => void
}

export function WebDevelopmentPage({ onGetStarted }: WebDevelopmentPageProps) {
  const { setPublicPage } = useAppStore()

  return (
    <>
      <PageHero
        badge="Web Development"
        title={<>Custom web apps engineered for <span className="text-gradient-brand">performance &amp; scale</span></>}
        subtitle="From MVP to enterprise — APSAMO builds production-grade web applications with Next.js, TypeScript, and modern infrastructure. Pixel-perfect UI, robust APIs, and observability baked in from day one."
      />

      {/* Stats bar */}
      <section className="border-b bg-background py-12">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {STATS.map((s, i) => (
              <ScrollReveal key={s.label} delay={i * 80}>
                <div className="text-center">
                  <p className="text-3xl sm:text-4xl font-extrabold text-gradient-brand">{s.value}</p>
                  <p className="text-xs sm:text-sm text-muted-foreground mt-1">{s.label}</p>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      {/* Tech stack grid */}
      <section className="py-24 bg-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-14">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">Tech Stack</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight">A modern, <span className="text-gradient-brand">battle-tested</span> stack</h2>
              <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">No legacy baggage. Every tool is chosen for developer velocity, type-safety, and long-term maintainability.</p>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {TECH_CATEGORIES.map((cat, i) => {
              const Icon = cat.icon
              return (
                <StaggerCard key={cat.title} index={i}>
                  <Card className="group relative overflow-hidden border hover:border-indigo-500/40 hover:shadow-glow-indigo transition-all duration-500 h-full bg-card/80 backdrop-blur-sm">
                    <div className="absolute -top-16 -right-16 size-40 rounded-full bg-indigo-500/10 blur-3xl group-hover:bg-indigo-500/20 transition-all duration-500" />
                    <CardContent className="p-6 sm:p-8 relative">
                      <div className="flex items-center gap-4 mb-4">
                        <div className="flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-glow-indigo group-hover:scale-110 transition-transform duration-500">
                          <Icon className="size-5" />
                        </div>
                        <div>
                          <h3 className="text-lg font-bold">{cat.title}</h3>
                          <p className="text-sm text-muted-foreground">{cat.desc}</p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 mt-4">
                        {cat.items.map((item) => (
                          <span key={item} className="inline-flex items-center gap-1 rounded-lg bg-indigo-500/10 px-2.5 py-1 text-xs font-medium text-indigo-600 dark:text-indigo-300">
                            <Check className="size-3" />
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

      {/* Code quality showcase */}
      <section className="py-24 bg-muted/30">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <ScrollReveal>
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">Code Quality</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">Type-safe, <span className="text-gradient-brand">end to end</span></h2>
              <p className="text-muted-foreground leading-relaxed mb-6">
                Shared TypeScript schemas flow from your database, through your API, and into your UI. Entire classes of runtime bugs simply disappear. Refactoring becomes safe. Onboarding new engineers takes days, not weeks.
              </p>
              <ul className="space-y-3">
                {[
                  'Strict TypeScript across the entire codebase',
                  'Prisma generates types from your real schema',
                  'tRPC / Zod for runtime-validated API contracts',
                  'ESLint + Prettier enforced in CI',
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
              <div className="relative">
                <div className="absolute -inset-4 bg-gradient-to-br from-indigo-500/20 to-indigo-700/10 rounded-3xl blur-2xl" />
                <Card className="relative overflow-hidden border-indigo-500/30 shadow-glow-indigo bg-[#0d0b1f]">
                  <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3 bg-white/5">
                    <div className="flex gap-1.5">
                      <span className="size-3 rounded-full bg-red-400/80" />
                      <span className="size-3 rounded-full bg-amber-400/80" />
                      <span className="size-3 rounded-full bg-green-400/80" />
                    </div>
                    <div className="ml-2 flex items-center gap-1.5 text-xs text-zinc-400">
                      <Terminal className="size-3.5" />
                      route.ts
                    </div>
                  </div>
                  <CardContent className="p-5 font-mono text-[13px] leading-relaxed">
                    {CODE_LINES.map((line) => (
                      <div key={line.n} className="flex gap-4">
                        <span className="select-none text-zinc-600 w-6 text-right">{line.n}</span>
                        <span className={line.c || 'text-zinc-300'}>{line.t || '\u00A0'}</span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* Development process timeline */}
      <section className="py-24 bg-background">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-14">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">Our Process</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight">From idea to launch in <span className="text-gradient-brand">five steps</span></h2>
            </div>
          </ScrollReveal>
          <div className="relative">
            {/* vertical line */}
            <div className="absolute left-6 sm:left-8 top-2 bottom-2 w-px bg-gradient-to-b from-indigo-400 via-indigo-500/40 to-transparent" aria-hidden />
            <div className="space-y-8">
              {PROCESS.map((p, i) => {
                const Icon = p.icon
                return (
                  <StaggerCard key={p.step} index={i}>
                    <div className="relative flex gap-5 sm:gap-6">
                      <div className="relative z-10 flex size-12 sm:size-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-400 to-indigo-700 text-white shadow-glow-indigo">
                        <Icon className="size-5 sm:size-6" />
                      </div>
                      <div className="flex-1 pt-1">
                        <div className="flex items-center gap-3 mb-1">
                          <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400">{p.step}</span>
                          <span className="text-xs text-muted-foreground">—</span>
                        </div>
                        <h3 className="text-lg font-bold mb-1.5">{p.title}</h3>
                        <p className="text-sm text-muted-foreground leading-relaxed">{p.desc}</p>
                      </div>
                    </div>
                  </StaggerCard>
                )
              })}
            </div>
          </div>
        </div>
      </section>

      {/* Capabilities bento */}
      <section className="py-24 bg-muted/30">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-14">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">Capabilities</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight">Built for <span className="text-gradient-brand">real products</span></h2>
              <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">Not just pretty pages — the full range of capabilities your product needs to succeed.</p>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {CAPABILITIES.map((cap, i) => {
              const Icon = cap.icon
              return (
                <StaggerCard key={cap.title} index={i}>
                  <Card className="group relative overflow-hidden border hover:border-indigo-500/40 hover:shadow-glow-indigo transition-all duration-500 h-full bg-card/80 backdrop-blur-sm">
                    <div className="absolute -top-12 -right-12 size-32 rounded-full bg-indigo-500/10 blur-3xl group-hover:bg-indigo-500/20 transition-all duration-500" />
                    <CardContent className="p-6 relative">
                      <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-glow-indigo group-hover:scale-110 group-hover:-rotate-6 transition-all duration-500">
                        <Icon className="size-5" />
                      </div>
                      <h3 className="text-lg font-bold mb-1.5">{cap.title}</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">{cap.desc}</p>
                    </CardContent>
                  </Card>
                </StaggerCard>
              )
            })}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="py-24 bg-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-14">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">Pricing</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight">Plans for every <span className="text-gradient-brand">stage</span></h2>
              <p className="mt-3 text-muted-foreground">Fixed scope, fixed price, fixed timeline. No surprises.</p>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {PLANS.map((plan, i) => (
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
              <h2 className="text-3xl font-extrabold tracking-tight">Frequently asked questions</h2>
            </div>
          </ScrollReveal>
          <Accordion type="single" collapsible className="w-full">
            {FAQS.map((faq, i) => (
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
            <h2 className="text-3xl sm:text-5xl font-extrabold tracking-tight mb-4">Let&apos;s build something <span className="text-gradient-brand">remarkable</span></h2>
            <p className="text-zinc-300 text-lg mb-8 max-w-xl mx-auto">Tell us about your idea. We&apos;ll reply within 24 hours with a plan, a timeline, and a fixed quote.</p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button size="lg" className="btn-shimmer bg-indigo-500 hover:bg-indigo-600 text-white px-10 h-12 border-0 shadow-glow-indigo hover:scale-105 transition-all" onClick={onGetStarted}>
                <Sparkles className="size-4 mr-2" />
                Start Your Project
                <ArrowRight className="size-4 ml-2" />
              </Button>
              <button onClick={() => setPublicPage({ page: 'services' })} className="inline-flex items-center justify-center gap-2 h-12 px-8 rounded-md glass text-white hover:bg-white/10 transition-all">
                <Cloud className="size-4 text-indigo-300" />
                View All Services
              </button>
            </div>
          </ScrollReveal>
        </div>
      </section>
    </>
  )
}
