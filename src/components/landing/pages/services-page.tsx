'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ArrowRight, Check, Sparkles, Layers, Globe, Server, Code2 } from 'lucide-react'
import { PageHero, ScrollReveal, StaggerCard } from '../ui-helpers'
import { useAppStore } from '@/store/app-store'
import { useSiteContent, resolveIcon } from '../site-data-context'

const INTEGRATION_STEPS = [
  { icon: Code2, title: 'Build', desc: 'We craft your web app with Next.js & TypeScript.' },
  { icon: Globe, title: 'Register', desc: 'Secure your domain with real-time TLD search.' },
  { icon: Server, title: 'Host', desc: 'Deploy to the global edge network in seconds.' },
  { icon: Layers, title: 'Scale', desc: 'Add SaaS features, billing & teams as you grow.' },
]

const WHY = [
  'One dashboard for every service',
  'No integration glue to maintain',
  'Single invoice, single support team',
  'Built-in observability across the stack',
]

export function ServicesPage() {
  const { setPublicPage } = useAppStore()
  const { services, getContent } = useSiteContent()

  return (
    <>
      <PageHero
        badge={getContent('services.hero.badge')}
        title={<span className="text-gradient-brand">{getContent('services.hero.title')}</span>}
        subtitle={getContent('services.hero.subtitle')}
      />

      <section className="py-24 bg-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {services.map((service, i) => {
              const Icon = resolveIcon(service.iconName)
              return (
                <StaggerCard key={service.slug} index={i}>
                  <a
                    href={`#/services/${service.slug}`}
                    onClick={() => setPublicPage({ page: 'service-detail', slug: service.slug })}
                    className="group block h-full"
                  >
                    <Card className="group relative overflow-hidden border hover:border-indigo-500/50 hover:shadow-glow-indigo transition-all duration-500 h-full bg-card/80 backdrop-blur-sm">
                      <div className={`absolute -top-20 -right-20 size-56 rounded-full bg-gradient-to-br ${service.accent} opacity-10 blur-3xl group-hover:opacity-25 transition-opacity duration-700`} />
                      <CardContent className="p-8 relative">
                        <div className="flex items-start gap-4 mb-5">
                          <div className={`relative flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br ${service.accent} text-white shadow-glow-indigo group-hover:scale-110 group-hover:rotate-3 transition-all duration-500 shrink-0`}>
                            <Icon className="size-7" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="text-xl font-bold">{service.name}</h3>
                            <p className="text-sm text-indigo-600 dark:text-indigo-400 font-medium mt-0.5">{service.tagline}</p>
                          </div>
                        </div>
                        <p className="text-sm text-muted-foreground leading-relaxed mb-5">{service.description}</p>
                        <ul className="space-y-2 mb-6">
                          {service.features.slice(0, 4).map((feat) => (
                            <li key={feat} className="flex items-start gap-2 text-sm">
                              <Check className="size-4 text-indigo-500 shrink-0 mt-0.5" />
                              <span className="text-muted-foreground">{feat}</span>
                            </li>
                          ))}
                        </ul>
                        <span className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 dark:text-indigo-400 group-hover:gap-2 transition-all">
                          Explore {service.name} <ArrowRight className="size-4" />
                        </span>
                      </CardContent>
                    </Card>
                  </a>
                </StaggerCard>
              )
            })}
          </div>
        </div>
      </section>

      {/* Integrated workflow */}
      <section className="py-24 bg-muted/30">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-14">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">{getContent('services.workflow.badge')}</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight"><span className="text-gradient-brand">{getContent('services.workflow.title')}</span></h2>
              <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">{getContent('services.workflow.subtitle')}</p>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            {INTEGRATION_STEPS.map((step, i) => {
              const Icon = step.icon
              return (
                <StaggerCard key={step.title} index={i}>
                  <Card className="relative border hover:border-indigo-500/40 hover:shadow-glow-indigo transition-all duration-500 h-full bg-card/80 backdrop-blur-sm text-center">
                    <CardContent className="p-6">
                      <div className="relative z-10 mx-auto mb-4 inline-block">
                        <div className="absolute inset-0 rounded-2xl animate-pulse-glow" />
                        <div className="relative flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-400 to-indigo-700 text-white shadow-glow-indigo">
                          <Icon className="size-6" />
                        </div>
                      </div>
                      <div className="text-xs font-bold text-indigo-600 dark:text-indigo-400 mb-1">STEP {i + 1}</div>
                      <h3 className="font-bold mb-1.5">{step.title}</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">{step.desc}</p>
                    </CardContent>
                  </Card>
                </StaggerCard>
              )
            })}
          </div>
        </div>
      </section>

      {/* Why APSAMO */}
      <section className="py-24 bg-background">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
              <div>
                <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">{getContent('services.why.badge')}</Badge>
                <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4"><span className="text-gradient-brand">{getContent('services.why.title')}</span></h2>
                <p className="text-lg text-muted-foreground mb-6">{getContent('services.why.desc')}</p>
                <Button onClick={() => setPublicPage({ page: 'pricing' })} className="bg-indigo-500 hover:bg-indigo-600 text-white border-0 shadow-glow-indigo">
                  {getContent('services.why.button')} <ArrowRight className="size-4 ml-1" />
                </Button>
              </div>
              <div className="space-y-3">
                {WHY.map((item, i) => (
                  <ScrollReveal key={item} delay={i * 80}>
                    <div className="flex items-start gap-3 rounded-xl border bg-card/80 backdrop-blur-sm p-4 hover:border-indigo-500/30 transition-colors">
                      <div className="flex size-7 items-center justify-center rounded-lg bg-indigo-500/15 shrink-0 mt-0.5">
                        <Check className="size-4 text-indigo-600 dark:text-indigo-400" />
                      </div>
                      <span className="text-sm font-medium pt-1">{item}</span>
                    </div>
                  </ScrollReveal>
                ))}
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* CTA */}
      <section className="relative overflow-hidden aurora-bg text-white grain-overlay" style={{ backgroundColor: '#1E1A47' }}>
        <div className="aurora-blob aurora-blob-1" style={{ top: '-10%', right: '10%', width: '450px', height: '450px', background: 'radial-gradient(circle, #706FD3 0%, transparent 70%)' }} />
        <div className="relative z-10 mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 text-center py-20">
          <ScrollReveal>
            <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4"><span className="text-gradient-brand">{getContent('services.cta.title')}</span></h2>
            <p className="text-zinc-300 mb-8 max-w-xl mx-auto">{getContent('services.cta.subtitle')}</p>
            <a href="#/contact" onClick={() => setPublicPage({ page: 'contact' })} className="inline-flex items-center gap-2 h-12 px-8 rounded-md glass text-white hover:bg-white/10 transition-all">
              <Sparkles className="size-4 text-indigo-300" />
              {getContent('services.cta.button')}
              <ArrowRight className="size-4 ml-1" />
            </a>
          </ScrollReveal>
        </div>
      </section>
    </>
  )
}
