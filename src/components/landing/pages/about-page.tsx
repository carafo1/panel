'use client'

import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Target, Heart, Zap, Users, Rocket, Shield } from 'lucide-react'
import { PageHero, ScrollReveal, StaggerCard } from '../ui-helpers'
import { useSiteContent } from '../site-data-context'

const VALUES = [
  { icon: Target, title: 'Craftsmanship', desc: 'We sweat every detail — from pixel-perfect UI to sub-100ms API responses. Quality is non-negotiable.' },
  { icon: Heart, title: 'Developer-first', desc: 'Every decision starts with: "Would I want to use this?" We build the tools we wished existed.' },
  { icon: Zap, title: 'Speed', desc: 'Fast to deploy, fast to load, fast to scale. Performance is a feature, and we obsess over it.' },
  { icon: Shield, title: 'Reliability', desc: '99.9% uptime isn\'t a goal — it\'s the baseline. Your apps deserve infrastructure that never sleeps.' },
  { icon: Users, title: 'Community', desc: 'Open by default. We contribute to the tools we use and listen closely to the developers we serve.' },
  { icon: Rocket, title: 'Ambition', desc: 'We\'re building the platform we wish we had a decade ago — and the one we\'ll need a decade from now.' },
]

const STATS = [
  { value: '2024', label: 'Founded' },
  { value: '40+', label: 'Team members' },
  { value: '12', label: 'Countries' },
  { value: '50K+', label: 'Active users' },
]

export function AboutPage() {
  const { getContent } = useSiteContent()
  return (
    <>
      <PageHero
        badge={getContent('about.hero.badge')}
        title={<span className="text-gradient-brand">{getContent('about.hero.title')}</span>}
        subtitle={getContent('about.hero.subtitle')}
      />

      {/* Story */}
      <section className="py-20 bg-background">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="prose prose-lg max-w-none">
              <h2 className="text-2xl font-extrabold mb-4">{getContent('about.story.title')}</h2>
              <p className="text-muted-foreground leading-relaxed mb-4">
                {getContent('about.story.p1')}
              </p>
              <p className="text-muted-foreground leading-relaxed mb-4">
                {getContent('about.story.p2')}
              </p>
              <p className="text-muted-foreground leading-relaxed">
                {getContent('about.story.p3')}
              </p>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* Stats */}
      <section className="py-16 bg-muted/30">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
            {STATS.map((stat, i) => (
              <StaggerCard key={stat.label} index={i}>
                <div>
                  <p className="text-3xl sm:text-4xl font-extrabold text-gradient-brand">{stat.value}</p>
                  <p className="text-sm text-muted-foreground mt-1">{stat.label}</p>
                </div>
              </StaggerCard>
            ))}
          </div>
        </div>
      </section>

      {/* Values */}
      <section className="py-20 bg-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-12">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">{getContent('about.values.badge')}</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight"><span className="text-gradient-brand">{getContent('about.values.title')}</span></h2>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {VALUES.map((value, i) => {
              const Icon = value.icon
              return (
                <StaggerCard key={value.title} index={i}>
                  <Card className="h-full border hover:border-indigo-500/30 hover:shadow-modern-lg transition-all duration-500 bg-card/80 backdrop-blur-sm">
                    <CardContent className="p-6">
                      <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-glow-indigo">
                        <Icon className="size-5" />
                      </div>
                      <h3 className="font-bold mb-1.5">{value.title}</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">{value.desc}</p>
                    </CardContent>
                  </Card>
                </StaggerCard>
              )
            })}
          </div>
        </div>
      </section>

      {/* Mission */}
      <section className="relative overflow-hidden aurora-bg text-white grain-overlay" style={{ backgroundColor: '#1E1A47' }}>
        <div className="aurora-blob aurora-blob-1" style={{ top: '-10%', right: '5%', width: '500px', height: '500px', background: 'radial-gradient(circle, #706FD3 0%, transparent 70%)' }} />
        <div className="relative z-10 mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 text-center py-20">
          <ScrollReveal>
            <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4"><span className="text-gradient-brand">{getContent('about.mission.title')}</span></h2>
            <p className="text-xl text-zinc-300 leading-relaxed">
              {getContent('about.mission.text')}
            </p>
          </ScrollReveal>
        </div>
      </section>
    </>
  )
}
