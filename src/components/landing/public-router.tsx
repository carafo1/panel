'use client'

import { useAppStore } from '@/store/app-store'
import { SiteLayout } from './site-layout'
import { HomePage } from './pages/home-page'
import { ServicesPage } from './pages/services-page'
import { ServiceDetailPage } from './pages/service-detail-page'
import { WebDevelopmentPage } from './pages/web-development-page'
import { HostingPage } from './pages/hosting-page'
import { DomainPage } from './pages/domain-page'
import { SaasSystemPage } from './pages/saas-system-page'
import { PricingPage } from './pages/pricing-page'
import { AboutPage } from './pages/about-page'
import { ContactPage } from './pages/contact-page'
import { NotFoundPage } from './pages/not-found-page'

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
      // Dedicated, custom-designed pages for every service.
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
        case 'saas-system':
          content = <SaasSystemPage onGetStarted={onGetStarted} />
          break
        default:
          content = <NotFoundPage />
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
    case 'not-found':
      content = <NotFoundPage />
      break
    case 'home':
    default:
      content = <HomePage onGetStarted={onGetStarted} />
  }

  return <SiteLayout onGetStarted={onGetStarted}>{content}</SiteLayout>
}
