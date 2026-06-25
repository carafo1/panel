'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Check } from 'lucide-react'
import { SERVICES } from '../services-data'
import { PageHero, ScrollReveal, StaggerCard } from '../ui-helpers'

interface PricingPageProps {
  onGetStarted: () => void
}

export function PricingPage({ onGetStarted }: PricingPageProps) {
  return (
    <>
      <PageHero
        badge="Pricing"
        title={<>Transparent pricing for <span className="text-gradient-brand">every service</span></>}
        subtitle="Pay only for what you use. No hidden fees, no surprises. Upgrade, downgrade, or cancel anytime."
      />

      {SERVICES.map((service) => {
        const Icon = service.icon
        return (
          <section key={service.slug} className="py-16 bg-background even:bg-muted/30">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
              <ScrollReveal>
                <div className="flex items-center gap-3 mb-8">
                  <div className={`flex size-11 items-center justify-center rounded-xl bg-gradient-to-br ${service.accent} text-white shadow-glow-indigo`}>
                    <Icon className="size-5" />
                  </div>
                  <div>
                    <h2 className="text-2xl font-extrabold tracking-tight">{service.name}</h2>
                    <p className="text-sm text-muted-foreground">{service.tagline}</p>
                  </div>
                </div>
              </ScrollReveal>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {service.plans.map((plan, i) => (
                  <StaggerCard key={plan.name} index={i}>
                    <Card className={`relative flex flex-col h-full transition-all duration-500 bg-card/80 backdrop-blur-sm ${plan.popular ? 'border-indigo-500 shadow-glow-indigo scale-[1.02] shimmer-border' : 'hover:border-indigo-500/30 hover:shadow-modern-lg'}`}>
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
        )
      })}

      <section className="py-16 bg-background">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 text-center">
          <ScrollReveal>
            <h2 className="text-2xl font-extrabold mb-4">Need a custom plan?</h2>
            <p className="text-muted-foreground mb-6">For high-volume or enterprise needs, talk to our team about a tailored solution.</p>
            <Button variant="outline" className="border-indigo-500/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10">
              Contact Sales
            </Button>
          </ScrollReveal>
        </div>
      </section>
    </>
  )
}
