'use client'

import { PublicRouter } from './public-router'
import { usePublicHashRouter } from './use-public-hash-router'
import { SiteDataProvider } from './site-data-context'

interface LandingPageProps {
  onGetStarted: () => void
}

/**
 * Thin wrapper that activates the public hash router and renders the
 * active public page via <PublicRouter />. Wraps everything in the
 * SiteDataProvider so public pages read CMS-managed content from the DB.
 */
export default function LandingPage({ onGetStarted }: LandingPageProps) {
  usePublicHashRouter()
  return (
    <SiteDataProvider>
      <PublicRouter onGetStarted={onGetStarted} />
    </SiteDataProvider>
  )
}
