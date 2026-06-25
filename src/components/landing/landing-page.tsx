'use client'

import { PublicRouter } from './public-router'
import { usePublicHashRouter } from './use-public-hash-router'

interface LandingPageProps {
  onGetStarted: () => void
}

/**
 * Thin wrapper that activates the public hash router and renders the
 * active public page via <PublicRouter />.
 */
export default function LandingPage({ onGetStarted }: LandingPageProps) {
  usePublicHashRouter()
  return <PublicRouter onGetStarted={onGetStarted} />
}
