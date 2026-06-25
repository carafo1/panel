'use client'

import { useAppStore } from '@/store/app-store'
import { SiteLayout } from './site-layout'
import { HomePage } from './pages/home-page'
import { ServicesPage } from './pages/services-page'
import { ServiceDetailPage } from './pages/service-detail-page'
import { WebDevelopmentPage } from './pages/web-development-page'
import { HostingPage } from './pages/hosting-page'
import { DomainPage } from './pages/domain-page'
import { PricingPage } from './pages/pricing-page'
import { AboutPage } from './pages/about-page'
import { ContactPage } from './pages/contact-page'

interface PublicRouterProps {
  onGetStarted: () => void
}

export function PublicRouter({ onGetStarted }: PublicRouterProps) {
  const publicPage = useAppStore((s) => s.publicPage)

  let content: React.ReactNode
  switch (publicPage.page) {
    case 'services':
      content = <ServicesPage />
      break
    case 'service-detail':
      // Dedicated, custom-designed pages for the flagship services.
      switch (publicPage.slug) {
        case 'web-development':
          content = <WebDevelopmentPage onGetStarted={onGetStarted} />
          break
        case 'web-hosting':
          content = <HostingPage onGetStarted={onGetStarted} />
          break
        case 'domain-registration':
          content = <DomainPage onGetStarted={onGetStarted} />
          break
        default:
          content = <ServiceDetailPage slug={publicPage.slug} onGetStarted={onGetStarted} />
      }
      break
    case 'pricing':
      content = <PricingPage onGetStarted={onGetStarted} />
      break
    case 'about':
      content = <AboutPage />
      break
    case 'contact':
      content = <ContactPage />
      break
    case 'home':
    default:
      content = <HomePage onGetStarted={onGetStarted} />
  }

  return <SiteLayout onGetStarted={onGetStarted}>{content}</SiteLayout>
}
