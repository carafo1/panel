'use client'

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { SERVICES } from './services-data'
import { resolveIcon } from './icon-registry'
import { DEFAULT_CONTENT } from '@/lib/content-schema'
import type { LucideIcon } from 'lucide-react'

/**
 * Client-side CMS context.
 *
 * Fetches the full site content (services + global text) from
 * /api/site/content on mount. While loading, or if the fetch fails, it
 * falls back to the static seed in services-data.ts so the public site
 * always renders.
 *
 * Components consume this via `useSiteContent()` instead of importing
 * SERVICES directly, so admin edits are reflected after a refresh.
 */

export interface CmsService {
  id: string
  slug: string
  name: string
  tagline: string
  description: string
  iconName: string
  accent: string
  features: string[]
  visible: boolean
  plans: {
    id: string
    name: string
    price: number
    period: string
    description: string
    features: string[]
    popular: boolean
  }[]
  highlights: {
    title: string
    description: string
    iconName: string
  }[]
  faqs: {
    q: string
    a: string
  }[]
}

interface SiteDataContextValue {
  /** Services from the DB (or static fallback). Icon components resolved. */
  services: CmsService[]
  /** Raw site content key/value map (may be empty if using fallback). */
  content: Record<string, string>
  /** Whether the initial fetch is in progress. */
  loading: boolean
  /** Re-fetch from the API (e.g. after an admin edit). */
  refresh: () => void
  /** Look up a single content value, falling back to the provided default. */
  getContent: (key: string, fallback?: string) => string
}

const SiteDataContext = createContext<SiteDataContextValue | null>(null)

/** Build the static fallback (from services-data.ts) as CmsService[]. */
function buildFallbackServices(): CmsService[] {
  return SERVICES.map((s) => {
    const iconName = resolveIconName(s.icon) ?? 'LayoutGrid'
    return {
      id: `static-${s.slug}`,
      slug: s.slug,
      name: s.name,
      tagline: s.tagline,
      description: s.description,
      iconName,
      accent: s.accent,
      features: s.features,
      visible: true,
      plans: s.plans.map((p) => ({
        id: `static-${s.slug}-${p.name}`,
        name: p.name,
        price: p.price,
        period: p.period,
        description: p.description,
        features: p.features,
        popular: p.popular ?? false,
      })),
      highlights: s.highlights.map((h) => ({
        title: h.title,
        description: h.description,
        iconName: resolveIconName(h.icon) ?? 'LayoutGrid',
      })),
      faqs: s.faqs,
    }
  })
}

/** Reverse-lookup a lucide component to its registry name. */
function resolveIconName(icon: LucideIcon): string | undefined {
  // Import the registry lazily to avoid circular deps at module scope.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ICON_REGISTRY } = require('./icon-registry') as typeof import('./icon-registry')
  for (const [name, comp] of Object.entries(ICON_REGISTRY)) {
    if (comp === icon) return name
  }
  return undefined
}

interface SiteDataProviderProps {
  children: ReactNode
}

export function SiteDataProvider({ children }: SiteDataProviderProps) {
  const [services, setServices] = useState<CmsService[]>(() => buildFallbackServices())
  const [content, setContent] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/site/content', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data.services && Array.isArray(data.services)) {
        setServices(data.services)
      }
      if (data.content && typeof data.content === 'object') {
        setContent(data.content)
      }
    } catch (err) {
      // Silent fallback — keep the static seed. Don't crash the public site.
      console.warn('[SiteDataProvider] fetch failed, using static fallback:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const getContent = useCallback((key: string, fallback?: string) => {
    // Prefer the admin-overridden DB value, then the schema default, then
    // the caller-provided fallback. This guarantees every known key resolves
    // even before the API responds (during the initial loading state).
    if (content[key] != null && content[key] !== '') return content[key]
    if (DEFAULT_CONTENT[key] != null) return DEFAULT_CONTENT[key]
    return fallback ?? ''
  }, [content])

  return (
    <SiteDataContext.Provider value={{ services, content, loading, refresh, getContent }}>
      {children}
    </SiteDataContext.Provider>
  )
}

/** Hook to access the CMS data. Must be used inside <SiteDataProvider>. */
export function useSiteContent(): SiteDataContextValue {
  const ctx = useContext(SiteDataContext)
  if (!ctx) {
    throw new Error('useSiteContent must be used within a <SiteDataProvider>')
  }
  return ctx
}

/**
 * Get a service by slug from the context. Returns undefined if not found.
 */
export function useServiceBySlug(slug?: string): CmsService | undefined {
  const { services } = useSiteContent()
  if (!slug) return undefined
  return services.find((s) => s.slug === slug)
}

/** Re-export resolveIcon for components that need to render icons from names. */
export { resolveIcon }
