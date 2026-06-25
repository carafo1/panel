'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from '@/components/ui/accordion'
import {
  ArrowRight, Check, Sparkles, Globe, Shield, RefreshCw, Mail,
  Lock, Zap, Network, Search, Tag, ArrowLeftRight, Bell, Server,
  Layers, ShoppingBag,
} from 'lucide-react'
import { PageHero, ScrollReveal, StaggerCard } from '../ui-helpers'
import { DomainSearchWidget } from '../domain-search-widget'
import { useAppStore } from '@/store/app-store'

const TLD_TABLE = [
  { tld: '.com', price: 12.99, popular: true, category: 'Business', desc: 'The classic. Recognised worldwide.' },
  { tld: '.net', price: 14.99, category: 'Business', desc: 'Trusted for tech & networks.' },
  { tld: '.org', price: 12.99, category: 'Organisation', desc: 'For nonprofits & communities.' },
  { tld: '.io', price: 39.99, popular: true, category: 'Tech', desc: 'Developer-favourite for startups.' },
  { tld: '.dev', price: 14.99, category: 'Tech', desc: 'HTTPS-required, built for devs.' },
  { tld: '.app', price: 16.99, category: 'Tech', desc: 'For mobile & web apps.' },
  { tld: '.co', price: 29.99, category: 'Business', desc: 'Short, punchy alternative.' },
  { tld: '.ai', price: 92.1, popular: true, category: 'Premium', desc: 'For AI startups & ML products.' },
  { tld: '.xyz', price: 3.99, category: 'Generic', desc: 'Affordable & flexible.' },
  { tld: '.tech', price: 6.99, category: 'Tech', desc: 'For tech brands & blogs.' },
  { tld: '.store', price: 8.99, category: 'Commerce', desc: 'For e-commerce shops.' },
  { tld: '.design', price: 39.99, category: 'Creative', desc: 'For designers & studios.' },
]

const FEATURES = [
  { icon: Shield, title: 'Free WHOIS Privacy', desc: 'Your personal info never appears in public WHOIS records — free for the life of the domain.' },
  { icon: Network, title: 'Automatic DNS', desc: 'Full DNS management with a friendly UI. Or let us auto-configure everything for APSAMO-hosted sites.' },
  { icon: ArrowLeftRight, title: 'One-Click Transfers', desc: 'Bring domains from any registrar. We handle the auth code, the unlock, and the whole transfer flow.' },
  { icon: Bell, title: 'Expiry Alerts & Auto-Renew', desc: 'Multiple alerts before expiry plus optional auto-renewal. Never lose a domain to a missed email.' },
  { icon: Mail, title: 'Email & URL Forwarding', desc: 'Forward me@yourdomain.com to any inbox, or redirect your domain to any URL — included free.' },
  { icon: Lock, title: 'DNSSEC & Security', desc: 'Free DNSSEC, transfer locks, and two-factor auth on your account. Security is not an upsell.' },
]

const LIFECYCLE = [
  { icon: Search, title: 'Search', desc: 'Check real-time availability across 100+ TLDs with live Dynadot pricing.' },
  { icon: ShoppingBag, title: 'Register', desc: 'Checkout in seconds. WHOIS privacy, DNS, and forwarding included free.' },
  { icon: Server, title: 'Connect', desc: 'Link your domain to an APSAMO-hosted site — DNS & SSL configure automatically.' },
  { icon: RefreshCw, title: 'Renew', desc: 'Auto-renewal keeps your domain yours. Get alerts before every renewal.' },
]

const PLANS = [
  {
    name: '.com',
    price: 12.99,
    period: '/year',
    description: 'The classic. Perfect for businesses of any size.',
    features: [
      'Free WHOIS privacy',
      'Automatic DNS',
      'Email forwarding',
      'URL forwarding',
      'Auto-renewal available',
    ],
    popular: true,
  },
  {
    name: '.io / .dev',
    price: 39.99,
    period: '/year',
    description: 'Developer-favourite TLDs for tech products.',
    features: [
      'Free WHOIS privacy',
      'Automatic DNS',
      'Email forwarding',
      'URL forwarding',
      'Auto-renewal available',
    ],
  },
  {
    name: '.ai',
    price: 92.1,
    period: '/year',
    description: 'Premium TLD for AI startups & ML products.',
    features: [
      'Free WHOIS privacy',
      'Automatic DNS',
      'Email forwarding',
      'URL forwarding',
      'Auto-renewal available',
      '2-year minimum registration',
    ],
  },
]

const FAQS = [
  {
    q: 'How much does a domain cost?',
    a: 'Pricing varies by TLD. .com starts at $12.99/year, .io at $39.99/year, .ai at $92.10/year. Use the search above to get live pricing for any domain.',
  },
  {
    q: 'Is WHOIS privacy really free?',
    a: 'Yes — every domain registered through APSAMO includes free WHOIS privacy for life. Your personal info never appears in public WHOIS records.',
  },
  {
    q: 'Can I transfer domains from another registrar?',
    a: 'Yes. Just provide the EPP/auth code from your current registrar and unlock the domain. We handle the rest — most transfers complete in 5–7 days.',
  },
  {
    q: 'What happens if my domain expires?',
    a: 'We send you multiple expiry alerts and offer auto-renewal. If a domain does expire, there is a grace period during which you can still renew it without losing ownership.',
  },
]

interface DomainPageProps {
  onGetStarted: () => void
}

export function DomainPage({ onGetStarted }: DomainPageProps) {
  const { setPublicPage } = useAppStore()

  return (
    <>
      <PageHero
        badge="Domain Registration"
        title={<>Find &amp; register the perfect <span className="text-gradient-brand">domain</span></>}
        subtitle="Search 100+ TLDs with real-time availability and transparent Dynadot-powered pricing. Free WHOIS privacy, automatic DNS, and one-click transfers — APSAMO is your one-stop domain shop."
      />

      {/* Domain search widget */}
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

      {/* TLD pricing table */}
      <section className="py-24 bg-background">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-14">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">TLD Pricing</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight">Transparent pricing for <span className="text-gradient-brand">every TLD</span></h2>
              <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">Live Dynadot wholesale + a small markup. What you see is what you pay — no hidden fees at checkout.</p>
            </div>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <Card className="overflow-hidden border-indigo-500/20 bg-card/80 backdrop-blur-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      <th className="text-left font-semibold p-4">TLD</th>
                      <th className="text-left font-semibold p-4 hidden sm:table-cell">Category</th>
                      <th className="text-left font-semibold p-4 hidden md:table-cell">Description</th>
                      <th className="text-right font-semibold p-4">Price / year</th>
                    </tr>
                  </thead>
                  <tbody>
                    {TLD_TABLE.map((row, i) => (
                      <tr
                        key={row.tld}
                        className={`border-b last:border-0 hover:bg-indigo-500/5 transition-colors ${i % 2 === 1 ? 'bg-muted/20' : ''}`}
                      >
                        <td className="p-4">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-base">{row.tld}</span>
                            {row.popular && (
                              <Badge className="bg-gradient-to-r from-indigo-400 to-indigo-600 text-white border-0 text-[10px] px-1.5 py-0">HOT</Badge>
                            )}
                          </div>
                        </td>
                        <td className="p-4 hidden sm:table-cell">
                          <span className="inline-flex items-center rounded-md bg-indigo-500/10 px-2 py-0.5 text-xs font-medium text-indigo-600 dark:text-indigo-300">
                            {row.category}
                          </span>
                        </td>
                        <td className="p-4 hidden md:table-cell text-muted-foreground">{row.desc}</td>
                        <td className="p-4 text-right">
                          <span className="font-bold text-base text-gradient-brand">${row.price.toFixed(2)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </ScrollReveal>
          <p className="text-center text-xs text-muted-foreground mt-4">
            <Tag className="inline size-3 mr-1" />
            Prices shown in USD. Renewal pricing may differ for premium TLDs. Search above for live quotes.
          </p>
        </div>
      </section>

      {/* Features grid */}
      <section className="py-24 bg-muted/30">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-14">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">Included Free</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight">Every domain comes <span className="text-gradient-brand">fully loaded</span></h2>
              <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">No upsells, no surprise add-ons. These ship with every single domain registration.</p>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
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

      {/* Lifecycle */}
      <section className="py-24 bg-background">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-14">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">How It Works</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight">From search to live in <span className="text-gradient-brand">four steps</span></h2>
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            {LIFECYCLE.map((step, i) => {
              const Icon = step.icon
              return (
                <StaggerCard key={step.title} index={i}>
                  <Card className="relative border hover:border-indigo-500/40 hover:shadow-glow-indigo transition-all duration-500 h-full bg-card/80 backdrop-blur-sm text-center">
                    <CardContent className="p-6">
                      <div className="relative z-10 mx-auto mb-4 inline-block">
                        <div className="absolute inset-0 rounded-2xl animate-pulse-glow" />
                        <div className="relative flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-400 to-indigo-700 text-white font-bold text-lg shadow-glow-indigo">
                          {i + 1}
                        </div>
                      </div>
                      <div className="mb-3 flex justify-center">
                        <Icon className="size-5 text-indigo-600 dark:text-indigo-400" />
                      </div>
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

      {/* Pricing plans */}
      <section className="py-24 bg-muted/30">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <ScrollReveal>
            <div className="text-center mb-14">
              <Badge variant="outline" className="mb-4 border-indigo-500/30 text-indigo-600 dark:text-indigo-400">Popular TLDs</Badge>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight">Pick the right <span className="text-gradient-brand">extension</span></h2>
              <p className="mt-3 text-muted-foreground">All prices include WHOIS privacy, DNS, and forwarding.</p>
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
                      Register Now
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
            <h2 className="text-3xl sm:text-5xl font-extrabold tracking-tight mb-4">Claim your <span className="text-gradient-brand">domain</span> today</h2>
            <p className="text-zinc-300 text-lg mb-8 max-w-xl mx-auto">Search, register, and connect in minutes. Free WHOIS privacy on every domain, forever.</p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button size="lg" className="btn-shimmer bg-indigo-500 hover:bg-indigo-600 text-white px-10 h-12 border-0 shadow-glow-indigo hover:scale-105 transition-all" onClick={onGetStarted}>
                <Globe className="size-4 mr-2" />
                Search Domains
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
