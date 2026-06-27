'use client'

import { useCallback, useEffect } from 'react'
import { useAppStore, type PublicPageState } from '@/store/app-store'

/**
 * Parse `window.location.hash` into a `PublicPageState`.
 *
 * Supported hashes:
 *   `#/`                          → home
 *   `#/services`                  → services index
 *   `#/services/<slug>`           → service detail (slug = the segment)
 *   `#/pricing`                   → pricing
 *   `#/about`                     → about
 *   `#/contact`                   → contact
 *
 * Anything else (or empty hash) → home.
 */
export function parseHash(hash: string): PublicPageState {
  // Normalise: strip leading `#`, then any leading `/`.
  const raw = hash.replace(/^#/, '')
  const path = raw.startsWith('/') ? raw.slice(1) : raw
  const parts = path.split('/').filter(Boolean)

  if (parts.length === 0) return { page: 'home' }

  switch (parts[0]) {
    case 'services':
      if (parts.length >= 2) {
        return { page: 'service-detail', slug: decodeURIComponent(parts[1]) }
      }
      return { page: 'services' }
    case 'pricing':
      return { page: 'pricing' }
    case 'about':
      return { page: 'about' }
    case 'contact':
      return { page: 'contact' }
    case 'home':
      return { page: 'home' }
    default:
      // Unknown top-level segment → 404 (only when the user typed something).
      return { page: 'not-found' }
  }
}

/** Reverse: build a hash string for a target page. */
export function buildHash(page: PublicPageState): string {
  switch (page.page) {
    case 'home':
      return '#/'
    case 'services':
      return '#/services'
    case 'service-detail':
      return `#/services/${encodeURIComponent(page.slug ?? '')}`
    case 'pricing':
      return '#/pricing'
    case 'about':
      return '#/about'
    case 'contact':
      return '#/contact'
    case 'not-found':
      return '#/not-found'
  }
}

/**
 * Syncs `window.location.hash` ↔ `useAppStore.publicPage`.
 * - On mount + on `hashchange`, parses the hash and pushes the state into the store.
 * - Exposes a `navigate(path)` helper that sets `location.hash` (which triggers
 *   the hashchange listener → store update → re-render via PublicRouter).
 */
export function usePublicHashRouter() {
  const setPublicPage = useAppStore((s) => s.setPublicPage)

  useEffect(() => {
    const apply = () => setPublicPage(parseHash(window.location.hash))
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [setPublicPage])

  const navigate = useCallback((path: string) => {
    // Normalise: callers can pass '#/services' or '/services' or 'services'.
    let target = path.trim()
    if (!target.startsWith('#')) target = '#' + (target.startsWith('/') ? target : '/' + target)
    if (window.location.hash === target) {
      // Already there — still fire the handler so the store re-syncs.
      setPublicPage(parseHash(target))
    } else {
      window.location.hash = target
    }
    // Scroll back to top whenever we navigate.
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
  }, [setPublicPage])

  return navigate
}
