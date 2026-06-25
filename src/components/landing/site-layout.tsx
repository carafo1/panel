'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Menu, X, Sparkles } from 'lucide-react'
import { Logo } from '@/components/ui/logo'
import { Button } from '@/components/ui/button'
import { ScrollProgress } from './ui-helpers'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/app-store'

const NAV_LINKS = [
  { label: 'Home', href: '#/', page: 'home' },
  { label: 'Services', href: '#/services', page: 'services' },
  { label: 'Pricing', href: '#/pricing', page: 'pricing' },
  { label: 'About', href: '#/about', page: 'about' },
  { label: 'Contact', href: '#/contact', page: 'contact' },
]

interface SiteLayoutProps {
  children: React.ReactNode
  onGetStarted: () => void
}

export function SiteLayout({ children, onGetStarted }: SiteLayoutProps) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const publicPage = useAppStore((s) => s.publicPage)
  const setPublicPage = useAppStore((s) => s.setPublicPage)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const currentPage = publicPage.page === 'service-detail' ? 'services' : publicPage.page

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
              {NAV_LINKS.map((link) => (
                <a
                  key={link.page}
                  href={link.href}
                  className={cn(
                    'relative px-3 py-2 text-sm font-medium rounded-md transition-colors',
                    currentPage === link.page
                      ? 'text-indigo-600 dark:text-indigo-400'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {link.label}
                  {currentPage === link.page && (
                    <span className="absolute bottom-1 left-1/2 -translate-x-1/2 h-0.5 w-6 rounded-full bg-indigo-500" />
                  )}
                </a>
              ))}
            </nav>

            <div className="hidden md:flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onGetStarted} className="text-muted-foreground hover:text-foreground">
                Sign In
              </Button>
              <Button
                size="sm"
                onClick={onGetStarted}
                className="btn-shimmer bg-indigo-500 hover:bg-indigo-600 text-white border-0 shadow-glow-indigo"
              >
                Get Started
              </Button>
            </div>

            {/* Mobile toggle */}
            <button
              className="md:hidden inline-flex items-center justify-center size-10 rounded-md text-foreground hover:bg-accent"
              onClick={() => setMobileOpen((v) => !v)}
              aria-label="Toggle menu"
            >
              {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </div>

        {/* Mobile nav */}
        {mobileOpen && (
          <div className="md:hidden border-t border-border/60 bg-background/95 backdrop-blur-xl">
            <nav className="mx-auto max-w-7xl px-4 py-3 flex flex-col gap-1">
              {NAV_LINKS.map((link) => (
                <a
                  key={link.page}
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    'px-3 py-2.5 text-sm font-medium rounded-md transition-colors',
                    currentPage === link.page
                      ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  )}
                >
                  {link.label}
                </a>
              ))}
              <div className="flex gap-2 mt-2">
                <Button variant="outline" size="sm" className="flex-1" onClick={() => { onGetStarted(); setMobileOpen(false) }}>
                  Sign In
                </Button>
                <Button size="sm" className="flex-1 bg-indigo-500 hover:bg-indigo-600 text-white border-0" onClick={() => { onGetStarted(); setMobileOpen(false) }}>
                  Get Started
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
                  <span className="text-lg font-extrabold text-white">APSAMO</span>
                  <span className="block text-[10px] font-medium uppercase tracking-[0.18em] text-indigo-300/80 mt-0.5">Technology</span>
                </div>
              </div>
              <p className="mt-4 text-sm text-zinc-400 max-w-xs leading-relaxed">
                Build, host, and scale your entire online presence — web development, hosting, domains, and SaaS in one platform.
              </p>
            </div>

            {[
              { title: 'Product', links: ['Web Development', 'Web Hosting', 'Domain Registration', 'SaaS System'] },
              { title: 'Company', links: ['About', 'Contact', 'Pricing', 'Careers'] },
              { title: 'Resources', links: ['Documentation', 'Blog', 'Status', 'Support'] },
            ].map((col) => (
              <div key={col.title}>
                <h4 className="text-sm font-semibold text-white mb-3">{col.title}</h4>
                <ul className="space-y-2">
                  {col.links.map((link) => (
                    <li key={link}>
                      <a href="#/" className="text-sm text-zinc-400 hover:text-indigo-300 transition-colors">{link}</a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-12 pt-8 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-xs text-zinc-500">© 2025 APSAMO. Built by APSAMO Technology.</p>
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
