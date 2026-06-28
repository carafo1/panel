'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from '@/components/ui/accordion'
import { ArrowRight, Check, Sparkles } from 'lucide-react'
import { getServiceBySlug } from '../services-data'
import { PageHero, ScrollReveal, StaggerCard } from '../ui-helpers'
import { DomainSearchWidget } from '../domain-search-widget'
import { useAppStore } from '@/store/app-store'

interface ServiceDetailPageProps {
  slug?: string
  onGetStarted: () => void
}

export function ServiceDetailPage({ slug, onGetStarted }: ServiceDetailPageProps) {
  const { setPublicPage } = useAppStore()
  const service = getServiceBySlug(slug)

  if (!service) {
    return (
      <div className="py-32 text-center">
        <h1 className="text-2xl font-bold mb-4">Service not found</h1>
        <Button onClick={() => setPublicPage({ page: 'services' })}>Back to Services</Button>
      </div>
    )
  }

  const Icon = service.icon

  return (
    <>
      <PageHero
        badge={service.name}
        title={<>{service.tagline.split(' ').slice(0, -2).join(' ')} <span className="text-gradient-brand">{service.tagline.split(' ').slice(-2).join(' ')}</span></>}
        subtitle={service.description}
      />

      {/* Domain search (only for domain-registration) */}
      {service.slug === 'domain-registration' && (
        <section className="py-16 bg-background dot-grid">
          <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
            <DomainSearchWidget
              onGetStarted={onGetStarted}
              variant="section"
              title="Check Domain Availability"
              subtitle="Real-time search across 100+ TLDs with live Dynadot pricing"
            />
          </div>
        </section>
      )}

      {/* Highlights */}
      <section className="py-20 bg-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-12">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">Highlights</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight">Why choose our <span className="text-gradient-brand">{service.name}</span>?</h2>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {service.highlights.map((h, i) => {
              const HIcon = h.icon
              return (
                <StaggerCard key={h.title} index={i}>
                  <Card className="h-full border hover:border-indigo-500/30 hover:shadow-modern-lg transition-all duration-500 bg-card/80 backdrop-blur-sm">
                    <CardContent className="p-6">
                      <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-glow-indigo">
                        <HIcon className="size-5" />
                      </div>
                      <h3 className="font-bold mb-1.5">{h.title}</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">{h.description}</p>
                    </CardContent>
                  </Card>
                </StaggerCard>
              )
            })}
          </div>
        </div>
      </section>

      {/* Features list */}
      <section className="py-20 bg-muted/30">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-12">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">Features</Badge>
              <h2 className="text-3xl font-extrabold tracking-tight">Everything included</h2>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {service.features.map((feat, i) => (
              <StaggerCard key={feat} index={i}>
                <div className="flex items-start gap-3 rounded-xl border bg-card p-4">
                  <div className="flex size-8 items-center justify-center rounded-lg bg-indigo-500/10 shrink-0">
                    <Check className="size-4 text-indigo-600 dark:text-indigo-400" />
                  </div>
                  <span className="text-sm font-medium pt-1">{feat}</span>
                </div>
              </StaggerCard>
            ))}
          </div>
        </div>
      </section>

      {/* Plans */}
      <section className="py-20 bg-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-12">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">Pricing</Badge>
              <h2 className="text-3xl font-extrabold tracking-tight">Plans for every stage</h2>
              <p className="mt-3 text-muted-foreground">Start small, scale infinitely. No hidden fees.</p>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {service.plans.map((plan, i) => (
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
      {service.faqs.length > 0 && (
        <section className="py-20 bg-muted/30">
          <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
            <ScrollReveal>
              <div className="text-center mb-10">
                <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">FAQ</Badge>
                <h2 className="text-3xl font-extrabold tracking-tight">Frequently asked questions</h2>
              </div>
            </ScrollReveal>
            <Accordion type="single" collapsible className="w-full">
              {service.faqs.map((faq, i) => (
                <AccordionItem key={i} value={`item-${i}`}>
                  <AccordionTrigger className="text-left">{faq.q}</AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">{faq.a}</AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </section>
      )}

      {/* CTA */}
      <section className="relative overflow-hidden aurora-bg text-white grain-overlay" style={{ backgroundColor: '#1E1A47' }}>
        <div className="aurora-blob aurora-blob-1" style={{ top: '-10%', right: '10%', width: '450px', height: '450px', background: 'radial-gradient(circle, #706FD3 0%, transparent 70%)' }} />
        <div className="relative z-10 mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 text-center py-20">
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">Ready to get started with {service.name}?</h2>
          <p className="text-zinc-300 mb-8">Join thousands of developers building on Apsamo Technology.</p>
          <Button size="lg" className="btn-shimmer bg-indigo-500 hover:bg-indigo-600 text-white px-10 h-12 border-0 shadow-glow-indigo hover:scale-105 transition-all" onClick={onGetStarted}>
            <Sparkles className="size-4 mr-2" />
            Get Started Free
            <ArrowRight className="size-4 ml-2" />
          </Button>
        </div>
      </section>
    </>
  )
}
