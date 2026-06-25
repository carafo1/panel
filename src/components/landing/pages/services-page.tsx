'use client'

import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ArrowRight, Check } from 'lucide-react'
import { SERVICES } from '../services-data'
import { PageHero, ScrollReveal, StaggerCard } from '../ui-helpers'
import { useAppStore } from '@/store/app-store'

export function ServicesPage() {
  const { setPublicPage } = useAppStore()

  return (
    <>
      <PageHero
        badge="Our Services"
        title={<>Everything you need to <span className="text-gradient-brand">build &amp; grow</span> online</>}
        subtitle="Four integrated services that take you from idea to global scale — all on one platform."
      />

      <section className="py-24 bg-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {SERVICES.map((service, i) => {
              const Icon = service.icon
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
                          {service.features.slice(0, 3).map((feat) => (
                            <li key={feat} className="flex items-start gap-2 text-sm">
                              <Check className="size-4 text-indigo-500 shrink-0 mt-0.5" />
                              <span className="text-muted-foreground">{feat}</span>
                            </li>
                          ))}
                        </ul>
                        <span className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 dark:text-indigo-400 group-hover:gap-2 transition-all">
                          Learn more <ArrowRight className="size-4" />
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

      <section className="py-20 bg-muted/30">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 text-center">
          <ScrollReveal>
            <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">Why APSAMO</Badge>
            <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">One platform, zero integration headaches</h2>
            <p className="text-lg text-muted-foreground mb-8">Every APSAMO service is designed to work together. Buy a domain, get hosting, deploy your app, and scale — all from a single dashboard.</p>
          </ScrollReveal>
        </div>
      </section>
    </>
  )
}
