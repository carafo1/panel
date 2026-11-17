'use client'

import { Home, Search, ArrowLeft, Sparkles, Headset } from 'lucide-react'
import { ScrollReveal } from '../ui-helpers'
import { useAppStore } from '@/store/app-store'
import { useSiteContent, resolveIcon } from '../site-data-context'

export function NotFoundPage() {
  const { setPublicPage } = useAppStore()
  const { services } = useSiteContent()

  return (
    <section className="relative overflow-hidden aurora-bg text-white grain-overlay" style={{ backgroundColor: '#1E1A47' }}>
      <div className="aurora-blob aurora-blob-1" style={{ top: '-10%', right: '5%', width: '500px', height: '500px', background: 'radial-gradient(circle, #706FD3 0%, transparent 70%)' }} />
      <div className="aurora-blob aurora-blob-2" style={{ bottom: '-15%', left: '0%', width: '450px', height: '450px', background: 'radial-gradient(circle, #8888FF 0%, transparent 70%)' }} />
      <div className="absolute inset-0 dot-grid opacity-30 pointer-events-none" />

      <div className="relative z-10 mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-24 sm:py-32 text-center">
        <ScrollReveal>
          {/* Big 404 */}
          <div className="relative inline-block mb-6">
            <h1 className="text-[8rem] sm:text-[10rem] font-extrabold leading-none text-gradient-brand select-none">404</h1>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-[8rem] sm:text-[10rem] font-extrabold leading-none text-white/5 select-none">404</span>
            </div>
          </div>

          <div className="inline-flex items-center gap-2 mb-5 rounded-full glass px-4 py-1.5 text-sm text-indigo-200">
            <Sparkles className="size-3.5 text-indigo-300" />
            Page not found
          </div>

          <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mb-3">
            This page took a <span className="text-gradient-brand">detour</span>
          </h2>
          <p className="text-zinc-300 text-base sm:text-lg mb-8 max-w-lg mx-auto">
            The page you&apos;re looking for doesn&apos;t exist or may have moved. Let&apos;s get you back on track.
          </p>

          {/* Primary actions */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-12">
            <a
              href="#/"
              onClick={() => setPublicPage({ page: 'home' })}
              className="inline-flex items-center justify-center gap-2 h-12 px-7 rounded-md btn-shimmer bg-indigo-500 hover:bg-indigo-600 text-white border-0 shadow-glow-indigo hover:scale-105 transition-all text-sm font-semibold"
            >
              <Home className="size-4" />
              Back to Home
            </a>
            <a
              href="#/services"
              onClick={() => setPublicPage({ page: 'services' })}
              className="inline-flex items-center justify-center gap-2 h-12 px-7 rounded-md glass text-white hover:bg-white/10 transition-all text-sm font-semibold"
            >
              <Search className="size-4 text-indigo-300" />
              Browse Services
            </a>
          </div>

          {/* Popular destinations */}
          <ScrollReveal delay={100}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-start">
              {services.map((svc) => {
                const Icon = resolveIcon(svc.iconName)
                return (
                  <a
                    key={svc.slug}
                    href={`#/services/${svc.slug}`}
                    onClick={() => setPublicPage({ page: 'service-detail', slug: svc.slug })}
                    className="group flex items-center gap-3 rounded-xl glass p-4 hover:bg-white/10 transition-all"
                  >
                    <div className={`flex size-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${svc.accent} text-white shadow-glow-indigo group-hover:scale-110 transition-transform`}>
                      <Icon className="size-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-white truncate">{svc.name}</p>
                      <p className="text-xs text-zinc-400 truncate">{svc.tagline}</p>
                    </div>
                    <ArrowLeft className="size-4 text-indigo-300 rotate-180 group-hover:translate-x-1 transition-transform" />
                  </a>
                )
              })}
            </div>
          </ScrollReveal>

          {/* Help line */}
          <ScrollReveal delay={200}>
            <div className="mt-10 flex items-center justify-center gap-2 text-sm text-zinc-400">
              <Headset className="size-4 text-indigo-300" />
              Still lost?
              <a
                href="#/contact"
                onClick={() => setPublicPage({ page: 'contact' })}
                className="text-indigo-300 hover:text-indigo-200 font-medium underline-offset-4 hover:underline transition-colors"
              >
                Contact our team
              </a>
            </div>
          </ScrollReveal>
        </ScrollReveal>
      </div>
    </section>
  )
}
