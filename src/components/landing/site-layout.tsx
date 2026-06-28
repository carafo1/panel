'use client'

import { useState, useEffect } from 'react'
import { Menu, X, ChevronDown, ArrowRight } from 'lucide-react'
import { Logo } from '@/components/ui/logo'
import { Button } from '@/components/ui/button'
import { ScrollProgress } from './ui-helpers'
import { cn } from '@/lib/utils'
import { useAppStore, type PublicPageState } from '@/store/app-store'
import { useSiteContent, resolveIcon } from './site-data-context'

/** Top-level nav entries (Services gets a dropdown). */
const NAV_LINKS: { labelKey: string; href: string; page: PublicPageState['page'] }[] = [
  { labelKey: 'nav.home', href: '#/', page: 'home' },
  { labelKey: 'nav.services', href: '#/services', page: 'services' },
  { labelKey: 'nav.pricing', href: '#/pricing', page: 'pricing' },
  { labelKey: 'nav.about', href: '#/about', page: 'about' },
  { labelKey: 'nav.contact', href: '#/contact', page: 'contact' },
]

interface SiteLayoutProps {
  children: React.ReactNode
  onGetStarted: () => void
}

export function SiteLayout({ children, onGetStarted }: SiteLayoutProps) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [servicesOpen, setServicesOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const publicPage = useAppStore((s) => s.publicPage)
  const setPublicPage = useAppStore((s) => s.setPublicPage)
  const { services, getContent } = useSiteContent()

  // Derive the dropdown service links from CMS data (with sensible fallbacks
  // derived from each service's tagline).
  const SERVICE_LINKS = services.map((svc) => ({
    label: svc.name,
    href: `#/services/${svc.slug}`,
    slug: svc.slug,
    desc: svc.tagline,
    icon: resolveIcon(svc.iconName),
  }))

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const currentPage = publicPage.page === 'service-detail' ? 'services' : publicPage.page
  const activeServiceSlug = publicPage.page === 'service-detail' ? publicPage.slug : undefined

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <ScrollProgress />
      {/* Navbar */}
      <header className={cn(
        'sticky top-0 z-50 w-full transition-all duration-300',
        scrolled ? 'bg-background/80 backdrop-blur-xl border-b border-border/60' : 'bg-background/60 backdrop-blur-md'
      )}>
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <a href="#/" onClick={() => setPublicPage({ page: 'home' })} className="flex items-center transition-opacity hover:opacity-80">
              <Logo />
            </a>

            {/* Desktop nav */}
            <nav className="hidden md:flex items-center gap-1">
              {NAV_LINKS.map((link) => {
                const isActive = currentPage === link.page
                if (link.page === 'services') {
                  return (
                    <div
                      key={link.page}
                      className="relative group"
                      onMouseEnter={() => setServicesOpen(true)}
                      onMouseLeave={() => setServicesOpen(false)}
                    >
                      <a
                        href={link.href}
                        onClick={() => setPublicPage({ page: 'services' })}
                        className={cn(
                          'relative inline-flex items-center gap-1 px-3 py-2 text-sm font-medium rounded-md transition-colors',
                          isActive
                            ? 'text-indigo-600 dark:text-indigo-400'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                        aria-haspopup="true"
                        aria-expanded={servicesOpen}
                      >
                        {getContent(link.labelKey)}
                        <ChevronDown className={cn('size-3.5 transition-transform duration-200', servicesOpen && 'rotate-180')} />
                        {isActive && (
                          <span className="absolute bottom-1 left-1/2 -translate-x-1/2 h-0.5 w-6 rounded-full bg-indigo-500" />
                        )}
                      </a>

                      {/* Dropdown panel */}
                      <div
                        className={cn(
                          'absolute left-1/2 top-full -translate-x-1/2 pt-2 w-[320px] transition-all duration-200',
                          servicesOpen
                            ? 'opacity-100 visible translate-y-0'
                            : 'opacity-0 invisible -translate-y-1 pointer-events-none'
                        )}
                      >
                        <div className="overflow-hidden rounded-xl border border-border/60 bg-background/95 backdrop-blur-xl shadow-glow-indigo p-2">
                          <a
                            href="#/services"
                            onClick={() => { setPublicPage({ page: 'services' }); setServicesOpen(false) }}
                            className="flex items-center justify-between rounded-lg px-3 py-2 text-sm font-semibold text-foreground hover:bg-indigo-500/10 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                          >
                            {getContent('nav.allServices')}
                            <ArrowRight className="size-3.5" />
                          </a>
                          <div className="my-1 h-px bg-border/60" />
                          {SERVICE_LINKS.map((svc) => {
                            const Icon = svc.icon
                            const svcActive = activeServiceSlug === svc.slug
                            return (
                              <a
                                key={svc.slug}
                                href={svc.href}
                                onClick={() => { setPublicPage({ page: 'service-detail', slug: svc.slug }); setServicesOpen(false) }}
                                className={cn(
                                  'group/svc flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors',
                                  svcActive
                                    ? 'bg-indigo-500/15'
                                    : 'hover:bg-indigo-500/10'
                                )}
                              >
                                <div className={cn(
                                  'flex size-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-glow-indigo transition-transform duration-300 group-hover/svc:scale-110',
                                  svcActive && 'ring-2 ring-indigo-400/50'
                                )}>
                                  <Icon className="size-4" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className={cn(
                                    'flex items-center gap-1.5 text-sm font-semibold',
                                    svcActive ? 'text-indigo-600 dark:text-indigo-400' : 'text-foreground'
                                  )}>
                                    {svc.label}
                                  </div>
                                  <p className="text-xs text-muted-foreground leading-snug mt-0.5">{svc.desc}</p>
                                </div>
                              </a>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  )
                }

                return (
                  <a
                    key={link.page}
                    href={link.href}
                    onClick={() => setPublicPage({ page: link.page } as PublicPageState)}
                    className={cn(
                      'relative px-3 py-2 text-sm font-medium rounded-md transition-colors',
                      isActive
                        ? 'text-indigo-600 dark:text-indigo-400'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {getContent(link.labelKey)}
                    {isActive && (
                      <span className="absolute bottom-1 left-1/2 -translate-x-1/2 h-0.5 w-6 rounded-full bg-indigo-500" />
                    )}
                  </a>
                )
              })}
            </nav>

            <div className="hidden md:flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onGetStarted} className="text-muted-foreground hover:text-foreground">
                {getContent('nav.signin')}
              </Button>
              <Button
                size="sm"
                onClick={onGetStarted}
                className="btn-shimmer bg-indigo-500 hover:bg-indigo-600 text-white border-0 shadow-glow-indigo"
              >
                {getContent('nav.getStarted')}
              </Button>
            </div>

            {/* Mobile toggle */}
            <button
              className="md:hidden inline-flex items-center justify-center size-10 rounded-md text-foreground hover:bg-accent"
              onClick={() => setMobileOpen((v) => !v)}
              aria-label="Toggle menu"
              aria-expanded={mobileOpen}
            >
              {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </div>

        {/* Mobile nav */}
        {mobileOpen && (
          <div className="md:hidden border-t border-border/60 bg-background/95 backdrop-blur-xl max-h-[calc(100vh-4rem)] overflow-y-auto">
            <nav className="mx-auto max-w-7xl px-4 py-3 flex flex-col gap-1">
              {NAV_LINKS.map((link) => {
                const isActive = currentPage === link.page
                if (link.page === 'services') {
                  return (
                    <div key={link.page}>
                      <button
                        onClick={() => setServicesOpen((v) => !v)}
                        className={cn(
                          'w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-md transition-colors',
                          isActive
                            ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                            : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                        )}
                        aria-expanded={servicesOpen}
                      >
                        <span>{getContent(link.labelKey)}</span>
                        <ChevronDown className={cn('size-4 transition-transform duration-200', servicesOpen && 'rotate-180')} />
                      </button>
                      {servicesOpen && (
                        <div className="ml-2 mt-1 mb-2 border-l border-border/60 pl-3 flex flex-col gap-0.5">
                          <a
                            href="#/services"
                            onClick={() => { setPublicPage({ page: 'services' }); setMobileOpen(false) }}
                            className="px-3 py-2 text-sm font-semibold rounded-md text-foreground hover:bg-indigo-500/10 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                          >
                            {getContent('nav.allServices')}
                          </a>
                          {SERVICE_LINKS.map((svc) => {
                            const Icon = svc.icon
                            const svcActive = activeServiceSlug === svc.slug
                            return (
                              <a
                                key={svc.slug}
                                href={svc.href}
                                onClick={() => { setPublicPage({ page: 'service-detail', slug: svc.slug }); setMobileOpen(false) }}
                                className={cn(
                                  'flex items-center gap-2.5 px-3 py-2 text-sm rounded-md transition-colors',
                                  svcActive
                                    ? 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 font-medium'
                                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                                )}
                              >
                                <Icon className="size-4 text-indigo-500 shrink-0" />
                                {svc.label}
                              </a>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                }
                return (
                  <a
                    key={link.page}
                    href={link.href}
                    onClick={() => { setPublicPage({ page: link.page } as PublicPageState); setMobileOpen(false) }}
                    className={cn(
                      'px-3 py-2.5 text-sm font-medium rounded-md transition-colors',
                      isActive
                        ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                    )}
                  >
                    {getContent(link.labelKey)}
                  </a>
                )
              })}
              <div className="flex gap-2 mt-2">
                <Button variant="outline" size="sm" className="flex-1" onClick={() => { onGetStarted(); setMobileOpen(false) }}>
                  {getContent('nav.signin')}
                </Button>
                <Button size="sm" className="flex-1 bg-indigo-500 hover:bg-indigo-600 text-white border-0" onClick={() => { onGetStarted(); setMobileOpen(false) }}>
                  {getContent('nav.getStarted')}
                </Button>
              </div>
            </nav>
          </div>
        )}
      </header>

      {/* Main content */}
      <main className="flex-1">{children}</main>

      {/* Footer */}
      <footer className="mt-auto" style={{ backgroundColor: '#1E1A47' }}>
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-14">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-8">
            <div className="col-span-2">
              <div className="flex items-center gap-2">
                <div className="flex size-9 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/15">
                  <svg viewBox="0 0 48 48" fill="none" className="size-6">
                    <path d="M24 6 L40 40 L8 40 Z" fill="white" />
                    <path d="M14 40 Q24 18 34 40" stroke="#8888FF" strokeWidth="4" strokeLinecap="round" fill="none" />
                  </svg>
                </div>
                <div className="leading-none">
                  <span className="text-lg font-extrabold text-white">Apsamo Technology</span>
                  <span className="block text-[10px] font-medium uppercase tracking-[0.18em] text-indigo-300/80 mt-0.5">Technology</span>
                </div>
              </div>
              <p className="mt-4 text-sm text-zinc-400 max-w-xs leading-relaxed">
                {getContent('footer.tagline')}
              </p>
            </div>

            {[
              {
                titleKey: 'footer.col.product',
                links: [
                  { label: 'Web Development', href: '#/services/web-development' },
                  { label: 'Web Hosting', href: '#/services/web-hosting' },
                  { label: 'Domain Registration', href: '#/services/domain-registration' },
                  { label: 'SaaS System', href: '#/services/saas-system' },
                  { label: 'All Services', href: '#/services' },
                ],
              },
              {
                titleKey: 'footer.col.company',
                links: [
                  { label: 'About', href: '#/about' },
                  { label: 'Contact', href: '#/contact' },
                  { label: 'Pricing', href: '#/pricing' },
                  { label: 'Home', href: '#/' },
                ],
              },
              {
                titleKey: 'footer.col.resources',
                links: [
                  { label: 'Documentation', href: '#/about' },
                  { label: 'Blog', href: '#/about' },
                  { label: 'Status', href: '#/home' },
                  { label: 'Support', href: '#/contact' },
                ],
              },
            ].map((col) => (
              <div key={col.titleKey}>
                <h4 className="text-sm font-semibold text-white mb-3">{getContent(col.titleKey)}</h4>
                <ul className="space-y-2">
                  {col.links.map((link) => (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        className="text-sm text-zinc-400 hover:text-indigo-300 transition-colors"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-12 pt-8 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-xs text-zinc-500">{getContent('footer.copyright')}</p>
            <div className="flex items-center gap-4 text-xs text-zinc-500">
              <a href="#/" className="hover:text-indigo-300 transition-colors">Privacy</a>
              <a href="#/" className="hover:text-indigo-300 transition-colors">Terms</a>
              <a href="#/" className="hover:text-indigo-300 transition-colors">Security</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}
