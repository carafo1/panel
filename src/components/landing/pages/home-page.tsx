'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Sparkles, ArrowRight, Play, Check, Zap, Shield, Globe2,
  GitBranch, Activity, Users, Server, Code2, Rocket,
} from 'lucide-react'
import {
  useCountUp, useSpotlight, ScrollReveal, StaggerCard,
} from '../ui-helpers'
import { DomainSearchWidget } from '../domain-search-widget'
import { useAppStore } from '@/store/app-store'
import { useSiteContent, resolveIcon } from '../site-data-context'

const STATS = [
  { value: 10000, suffix: '+', label: 'Developers' },
  { value: 99.9, suffix: '%', label: 'Uptime SLA' },
  { value: 50000, suffix: '+', label: 'Sites Hosted' },
  { value: 24, suffix: '/7', label: 'Support' },
]

const BENTO_FEATURES = [
  { icon: Zap, title: 'Instant Deploys', desc: 'Push to git, go live in seconds with automatic build pipelines.' },
  { icon: Shield, title: 'Auto SSL & DNS', desc: 'Free SSL certificates and automatic DNS for every domain.' },
  { icon: Globe2, title: 'Global CDN', desc: 'Edge network delivers your content from 300+ locations worldwide.' },
  { icon: Activity, title: 'Real-time Logs', desc: 'Stream live build, runtime, and access logs as they happen.' },
  { icon: Users, title: 'Team Collaboration', desc: 'Invite teammates, manage roles, and deploy together.' },
  { icon: GitBranch, title: 'Custom Domains', desc: 'Connect any domain with automatic HTTPS and DNS config.' },
]

const HOW_IT_WORKS = [
  { step: 1, title: 'Connect', desc: 'Link your GitHub repo or upload your code. We support every framework.' },
  { step: 2, title: 'Deploy', desc: 'Automatic builds, instant rollbacks, and zero-downtime deploys.' },
  { step: 3, title: 'Scale', desc: 'Auto-scaling infrastructure grows with your traffic automatically.' },
]

const TESTIMONIALS = [
  { name: 'Sarah Chen', role: 'CTO, Lumen Labs', initials: 'SC', quote: 'Apsamo Technology cut our deployment time from hours to seconds. The domain integration alone saved us a full-time role.' },
  { name: 'Marcus Webb', role: 'Founder, Pulse', initials: 'MW', quote: 'From MVP to 100k users without touching infrastructure. The SaaS toolkit is genuinely enterprise-grade.' },
  { name: 'Aisha Patel', role: 'Lead Dev, Nimbus', initials: 'AP', quote: 'The best developer experience I have used in a decade. Real-time logs and instant rollbacks are a game changer.' },
]

const PRICING_PREVIEW = [
  { name: 'Starter', price: 9, period: '/mo', desc: 'Perfect for personal projects & hobbies', features: ['1 project', '1 GB storage', 'Custom domain', 'SSL certificate', 'Community support'], popular: false },
  { name: 'Pro', price: 29, period: '/mo', desc: 'For growing apps & small teams', features: ['10 projects', '50 GB storage', 'Unlimited domains', 'Auto-scaling', 'Priority support', 'Team collaboration'], popular: true },
  { name: 'Business', price: 79, period: '/mo', desc: 'For production workloads at scale', features: ['Unlimited projects', '500 GB storage', 'Dedicated resources', '99.99% SLA', '24/7 phone support', 'SSO & audit logs'], popular: false },
]

interface HomePageProps {
  onGetStarted: () => void
}

export function HomePage({ onGetStarted }: HomePageProps) {
  const { setPublicPage } = useAppStore()
  const { services, getContent } = useSiteContent()
  // Pricing preview comes from the live "Web Hosting" service (real Plan prices
  // via the CMS live overlay), falling back to the static preview only until the
  // service data loads — so the home page can never show a price that differs
  // from checkout.
  const hostingService = services.find((s) => /host/i.test(s.slug) || /host/i.test(s.name))
  const pricingPreview =
    hostingService && hostingService.plans.length > 0
      ? hostingService.plans.map((p) => ({
          name: p.name,
          price: p.price,
          period: p.period,
          desc: p.description,
          features: p.features,
          popular: p.popular,
        }))
      : PRICING_PREVIEW
  const techStack = getContent('home.techStack.items')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const stat0 = useCountUp(STATS[0].value, 2000)
  const stat1 = useCountUp(STATS[1].value, 2000)
  const stat2 = useCountUp(STATS[2].value, 2000)
  const stat3 = useCountUp(STATS[3].value, 2000)
  const statRefs = [stat0, stat1, stat2, stat3]

  const spotlightRef1 = useSpotlight<HTMLDivElement>()
  const spotlightRef2 = useSpotlight<HTMLDivElement>()
  const spotlightRef3 = useSpotlight<HTMLDivElement>()
  const spotlightRef4 = useSpotlight<HTMLDivElement>()
  const serviceRefs = [spotlightRef1, spotlightRef2, spotlightRef3, spotlightRef4]

  return (
    <>
      {/* HERO */}
      <section className="relative overflow-hidden aurora-bg text-white grain-overlay" style={{ backgroundColor: '#1E1A47' }}>
        <div className="aurora-blob aurora-blob-1" style={{ top: '-15%', left: '0%', width: '560px', height: '560px', background: 'radial-gradient(circle, #706FD3 0%, transparent 70%)' }} />
        <div className="aurora-blob aurora-blob-2" style={{ top: '5%', right: '-5%', width: '480px', height: '480px', background: 'radial-gradient(circle, #8888FF 0%, transparent 70%)' }} />
        <div className="aurora-blob aurora-blob-1" style={{ bottom: '-20%', left: '30%', width: '600px', height: '400px', background: 'radial-gradient(circle, #5D5CB8 0%, transparent 70%)', animationDelay: '4s' }} />
        <div className="absolute inset-0 dot-grid opacity-30 pointer-events-none" />

        <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-28 sm:py-36 lg:py-44 text-center">
          <div className="animate-fade-in-up">
            <span className="inline-flex items-center gap-2 mb-6 rounded-full glass px-4 py-1.5 text-sm text-indigo-200">
              <Sparkles className="size-3.5 text-indigo-300" />
              {getContent('home.hero.badge')}
            </span>
          </div>

          <h1 className="text-5xl sm:text-6xl lg:text-8xl font-extrabold tracking-tight leading-[1.02] mb-6 animate-fade-in-up" style={{ animationDelay: '0.15s' }}>
            {getContent('home.hero.title')}
          </h1>

          <p className="mx-auto max-w-2xl text-lg sm:text-xl text-zinc-300 mb-10 leading-relaxed animate-fade-in-up" style={{ animationDelay: '0.3s' }}>
            {getContent('home.hero.subtitle')}
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 animate-fade-in-up" style={{ animationDelay: '0.45s' }}>
            <Button size="lg" className="btn-shimmer relative bg-indigo-500 hover:bg-indigo-600 text-white px-8 h-12 text-base shadow-glow-indigo hover:shadow-glow-indigo-lg transition-all duration-300 hover:scale-105 border-0" onClick={onGetStarted}>
              {getContent('home.hero.ctaPrimary')}
              <ArrowRight className="size-4 ml-1" />
            </Button>
            <button onClick={() => setPublicPage({ page: 'services' })} className="group inline-flex items-center justify-center gap-2 h-12 px-8 text-base rounded-md glass text-white hover:bg-white/10 transition-all duration-300">
              <Play className="size-4 text-indigo-300" />
              {getContent('home.hero.ctaSecondary')}
            </button>
          </div>

          <div className="mt-14 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-zinc-400 animate-fade-in-up" style={{ animationDelay: '0.6s' }}>
            <span className="inline-flex items-center gap-2"><Check className="size-4 text-indigo-400" /> {getContent('home.hero.check1')}</span>
            <span className="inline-flex items-center gap-2"><Check className="size-4 text-indigo-400" /> {getContent('home.hero.check2')}</span>
            <span className="inline-flex items-center gap-2"><Check className="size-4 text-indigo-400" /> {getContent('home.hero.check3')}</span>
          </div>

          {/* Domain search widget */}
          <div className="mt-16 max-w-3xl mx-auto animate-fade-in-up" style={{ animationDelay: '0.75s' }}>
            <DomainSearchWidget
              onGetStarted={onGetStarted}
              variant="hero"
              title={getContent('widget.domain.title')}
              subtitle={getContent('widget.domain.subtitle')}
            />
          </div>
        </div>
      </section>

      {/* TECH STACK MARQUEE */}
      <section className="border-b bg-background py-10">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 mb-6 text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground font-medium">{getContent('home.techStack.label')}</p>
        </div>
        <div className="marquee">
          <div className="marquee-track gap-8 px-4">
            {[...techStack, ...techStack].map((tech, i) => (
              <span key={i} className="text-lg font-semibold text-muted-foreground/70 whitespace-nowrap">{tech}</span>
            ))}
          </div>
        </div>
      </section>

      {/* STATS */}
      <section className="py-20 bg-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
            {STATS.map((stat, i) => (
              <div key={stat.label} className="rounded-2xl glass-light dark:glass p-6 shadow-modern">
                <p ref={statRefs[i].ref} className="text-3xl sm:text-4xl font-extrabold text-gradient-brand">{statRefs[i].value}{stat.suffix}</p>
                <p className="text-sm text-muted-foreground mt-1">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* SERVICES */}
      <section className="py-24 bg-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-16">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">{getContent('home.services.badge')}</Badge>
              <h2 className="text-3xl sm:text-5xl font-extrabold tracking-tight"><span className="text-gradient-brand">{getContent('home.services.title')}</span></h2>
              <p className="mt-4 text-lg text-muted-foreground max-w-2xl mx-auto">{getContent('home.services.subtitle')}</p>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {services.map((service, i) => {
              const Icon = resolveIcon(service.iconName)
              return (
                <StaggerCard key={service.slug} index={i}>
                  <div ref={serviceRefs[i].ref} onMouseMove={serviceRefs[i].onMouseMove} className="spotlight h-full">
                    <a href={`#/services/${service.slug}`} onClick={() => setPublicPage({ page: 'service-detail', slug: service.slug })} className="group block h-full">
                      <Card className="group relative overflow-hidden border hover:border-indigo-500/50 hover:shadow-glow-indigo transition-all duration-500 h-full cursor-pointer bg-card/80 backdrop-blur-sm">
                        <div className={`absolute -top-20 -right-20 size-48 rounded-full bg-gradient-to-br ${service.accent} opacity-10 blur-3xl group-hover:opacity-25 transition-opacity duration-700`} />
                        <CardContent className="p-6 sm:p-8 relative">
                          <div className={`relative flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br ${service.accent} text-white shadow-glow-indigo group-hover:scale-110 group-hover:rotate-3 transition-all duration-500 shrink-0 mb-5`}>
                            <Icon className="size-7" />
                          </div>
                          <h3 className="text-xl font-bold mb-2">{service.name}</h3>
                          <p className="text-sm text-muted-foreground leading-relaxed mb-4">{service.tagline}</p>
                          <span className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 dark:text-indigo-400 group-hover:gap-2 transition-all">
                            Learn more <ArrowRight className="size-4" />
                          </span>
                        </CardContent>
                      </Card>
                    </a>
                  </div>
                </StaggerCard>
              )
            })}
          </div>
        </div>
      </section>

      {/* BENTO FEATURES */}
      <section className="py-24 bg-muted/30">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-16">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">{getContent('home.features.badge')}</Badge>
              <h2 className="text-3xl sm:text-5xl font-extrabold tracking-tight"><span className="text-gradient-brand">{getContent('home.features.title')}</span></h2>
              <p className="mt-4 text-lg text-muted-foreground max-w-2xl mx-auto">{getContent('home.features.subtitle')}</p>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {BENTO_FEATURES.map((feature, i) => {
              const Icon = feature.icon
              return (
                <StaggerCard key={feature.title} index={i} className={i === 0 ? 'md:col-span-2 md:row-span-1' : ''}>
                  <Card className="group relative overflow-hidden border hover:border-indigo-500/40 hover:shadow-glow-indigo transition-all duration-500 h-full bg-card/80 backdrop-blur-sm">
                    <div className="absolute -top-12 -right-12 size-32 rounded-full bg-indigo-500/10 blur-3xl group-hover:bg-indigo-500/20 transition-all duration-500" />
                    <CardContent className="p-6 relative">
                      <div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-glow-indigo group-hover:scale-110 group-hover:-rotate-6 transition-all duration-500">
                        <Icon className="size-5" />
                      </div>
                      <h3 className="text-lg font-bold mb-1.5">{feature.title}</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">{feature.desc}</p>
                    </CardContent>
                  </Card>
                </StaggerCard>
              )
            })}
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="py-24 bg-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-16">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">{getContent('home.howItWorks.badge')}</Badge>
              <h2 className="text-3xl sm:text-5xl font-extrabold tracking-tight"><span className="text-gradient-brand">{getContent('home.howItWorks.title')}</span></h2>
              <p className="mt-4 text-lg text-muted-foreground max-w-2xl mx-auto">{getContent('home.howItWorks.subtitle')}</p>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {HOW_IT_WORKS.map((step, i) => (
              <StaggerCard key={step.step} index={i}>
                <div className="text-center">
                  <div className="relative z-10 mb-6 inline-block">
                    <div className="absolute inset-0 rounded-full animate-pulse-glow" />
                    <div className="relative flex size-[52px] items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-400 to-indigo-700 text-white font-bold text-lg shadow-glow-indigo">
                      {step.step}
                    </div>
                  </div>
                  <h3 className="text-xl font-bold mb-2">{step.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed max-w-xs mx-auto">{step.desc}</p>
                </div>
              </StaggerCard>
            ))}
          </div>
        </div>
      </section>

      {/* TESTIMONIALS */}
      <section className="py-24 bg-muted/30">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-16">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">{getContent('home.testimonials.badge')}</Badge>
              <h2 className="text-3xl sm:text-5xl font-extrabold tracking-tight"><span className="text-gradient-brand">{getContent('home.testimonials.title')}</span></h2>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {TESTIMONIALS.map((t, i) => (
              <StaggerCard key={t.name} index={i}>
                <Card className="relative border hover:border-indigo-500/30 hover:shadow-modern-lg transition-all duration-500 h-full bg-card/80 backdrop-blur-sm">
                  <CardContent className="p-6">
                    <div className="flex gap-0.5 mb-4">
                      {[...Array(5)].map((_, idx) => (
                        <Sparkles key={idx} className="size-4 text-indigo-500" />
                      ))}
                    </div>
                    <p className="text-sm leading-relaxed text-foreground mb-6">&ldquo;{t.quote}&rdquo;</p>
                    <div className="flex items-center gap-3">
                      <div className="flex size-10 items-center justify-center rounded-full bg-gradient-to-br from-indigo-400 to-indigo-700 text-white font-semibold text-sm shadow-glow-indigo">{t.initials}</div>
                      <div>
                        <p className="font-semibold text-sm">{t.name}</p>
                        <p className="text-xs text-muted-foreground">{t.role}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </StaggerCard>
            ))}
          </div>
        </div>
      </section>

      {/* PRICING PREVIEW */}
      <section className="py-24 bg-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-16">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">{getContent('home.pricing.badge')}</Badge>
              <h2 className="text-3xl sm:text-5xl font-extrabold tracking-tight"><span className="text-gradient-brand">{getContent('home.pricing.title')}</span></h2>
              <p className="mt-4 text-lg text-muted-foreground">{getContent('home.pricing.subtitle')}</p>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {pricingPreview.map((plan, i) => (
              <StaggerCard key={plan.name} index={i}>
                <Card className={`relative flex flex-col h-full transition-all duration-500 bg-card/80 backdrop-blur-sm ${plan.popular ? 'border-indigo-500 shadow-glow-indigo scale-[1.03] shimmer-border' : 'hover:border-indigo-500/30 hover:shadow-modern-lg'}`}>
                  {plan.popular && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <Badge className="bg-gradient-to-r from-indigo-400 to-indigo-600 text-white border-0 px-4 py-0.5 shadow-glow-indigo">POPULAR</Badge>
                    </div>
                  )}
                  <CardContent className="p-6 flex flex-col flex-1">
                    <h3 className="text-lg font-bold mb-1">{plan.name}</h3>
                    <p className="text-xs text-muted-foreground mb-4">{plan.desc}</p>
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
          <div className="text-center mt-10">
            <button onClick={() => setPublicPage({ page: 'pricing' })} className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:gap-2 transition-all">
              View all pricing <ArrowRight className="size-4" />
            </button>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative overflow-hidden aurora-bg text-white grain-overlay" style={{ backgroundColor: '#1E1A47' }}>
        <div className="aurora-blob aurora-blob-1" style={{ top: '-10%', right: '10%', width: '500px', height: '500px', background: 'radial-gradient(circle, #706FD3 0%, transparent 70%)' }} />
        <div className="aurora-blob aurora-blob-2" style={{ bottom: '-20%', left: '5%', width: '450px', height: '450px', background: 'radial-gradient(circle, #8888FF 0%, transparent 70%)' }} />
        <div className="absolute inset-0 dot-grid opacity-20 pointer-events-none" />
        <div className="relative z-10 mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 text-center py-24">
          <ScrollReveal>
            <div className="relative rounded-3xl glass p-8 sm:p-16 shadow-glow-indigo-lg">
              <h2 className="text-3xl sm:text-5xl font-extrabold tracking-tight mb-4"><span className="text-gradient-brand">{getContent('home.cta.title')}</span></h2>
              <p className="text-zinc-300 text-lg mb-8 max-w-lg mx-auto">{getContent('home.cta.subtitle')}</p>
              <Button size="lg" className="btn-shimmer relative bg-indigo-500 hover:bg-indigo-600 text-white px-10 h-12 text-base shadow-glow-indigo hover:shadow-glow-indigo-lg hover:scale-105 transition-all duration-300 border-0" onClick={onGetStarted}>
                <Rocket className="size-4 mr-2" />
                {getContent('home.cta.button')}
              </Button>
            </div>
          </ScrollReveal>
        </div>
      </section>
    </>
  )
}
