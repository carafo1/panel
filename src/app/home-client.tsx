'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useAppStore, type DashboardTab } from '@/store/app-store'
import { useAuthStore } from '@/store/auth-store'
import LandingPage from '@/components/landing/landing-page'
import { AuthModal } from '@/components/auth/auth-modal'
import HostingPanel from '@/components/hosting/hosting-panel'
import DomainsPanel from '@/components/domains/domains-panel'
import { BillingPanel } from '@/components/billing/billing-panel'
import { DeploymentsPanel } from '@/components/deployments/deployments-panel'
import { AdminPanel } from '@/components/admin/admin-panel'
import SettingsPanel from '@/components/settings/settings-panel'
import TeamsPanel from '@/components/teams/teams-panel'
import AnalyticsPanel from '@/components/analytics/analytics-panel'
import OverviewPanel from '@/components/dashboard/overview-panel'
import EmailHostingPanel from '@/components/email-hosting/email-hosting-panel'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  LayoutDashboard,
  Server,
  Globe,
  Rocket,
  CreditCard,
  Shield,
  Settings,
  Menu,
  X,
  LogOut,
  Users,
  BarChart3,
  GitMerge,
  Webhook,
  Github,
  Sparkles,
  Activity,
  Mail,
  LifeBuoy,
} from 'lucide-react'
import { toast } from 'sonner'
import { NotificationCenter } from '@/components/notifications/notification-center'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import OnboardingWizard from '@/components/onboarding/onboarding-wizard'
import { EmailVerificationBanner } from '@/components/auth/email-verification-banner'
import { SupportSessionBanner, AdminTwoFactorBanner } from '@/components/auth/support-session-banner'
import { ErrorBoundary } from '@/components/error-boundary'
import PipelinesPanel from '@/components/pipelines/pipelines-panel'
import WebhooksPanel from '@/components/webhooks/webhooks-panel'
import GithubPanel from '@/components/github/github-panel'
import AssistantPanel from '@/components/assistant/assistant-panel'
import UptimePanel from '@/components/monitoring/uptime-panel'
import ProvisioningPanel from '@/components/provisioning/provisioning-panel'
import SupportPanel from '@/components/support/support-panel'
import { IncidentBanner } from '@/components/status/incident-banner'
import { CommandPalette } from '@/components/command-palette'
import { Search, Zap } from 'lucide-react'
import { LogoMark } from '@/components/ui/logo'
import { migrateStorageKeys } from '@/lib/migrate-storage'
import { captureReferralCode } from '@/lib/referral-capture'
import { useTranslations } from 'next-intl'
import { LanguageSwitcher } from '@/components/ui/language-switcher'

// ── Sidebar nav items ──────────────────────────────────────────────────
const NAV_ITEMS: { id: DashboardTab; label: string; icon: React.ElementType; adminOnly?: boolean }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'provisioning', label: 'Provisioning', icon: Zap, adminOnly: true },
  { id: 'hosting', label: 'Hosting', icon: Server },
  { id: 'email', label: 'Email Hosting', icon: Mail },
  { id: 'domains', label: 'Domains', icon: Globe },
  { id: 'deployments', label: 'Deployments', icon: Rocket },
  { id: 'github', label: 'GitHub', icon: Github },
  { id: 'pipelines', label: 'Pipelines', icon: GitMerge },
  { id: 'billing', label: 'Billing', icon: CreditCard },
  { id: 'webhooks', label: 'Webhooks', icon: Webhook },
  { id: 'admin', label: 'Admin', icon: Shield, adminOnly: true },
  { id: 'teams', label: 'Teams', icon: Users },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
  { id: 'monitoring', label: 'Monitoring', icon: Activity },
  { id: 'support', label: 'Support', icon: LifeBuoy },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'assistant', label: 'AI Assistant', icon: Sparkles },
]

// ── Dashboard with sidebar ─────────────────────────────────────────────
function Dashboard() {
  const { dashboardTab, setDashboardTab, sidebarOpen, setSidebarOpen } = useAppStore()
  const { user, logout, verifyEmail, markEmailVerified } = useAuthStore()
  const t = useTranslations('shell')
  const tNav = useTranslations('nav')
  const MOBILE_LABEL: Partial<Record<DashboardTab, string>> = { overview: 'mobileHome', deployments: 'mobileDeploy', assistant: 'mobileAi' }

  // Handle email verification from URL
  const [verifying, setVerifying] = useState(false)
  const [pendingVerifyToken, setPendingVerifyToken] = useState<string | null>(null)
  const verificationAttempted = useRef(false)

  // Check URL for verification token on mount
  useEffect(() => {
    if (verificationAttempted.current) return
    const params = new URLSearchParams(window.location.search)
    const verifyToken = params.get('verify_token')
    if (verifyToken) {
      verificationAttempted.current = true
      setPendingVerifyToken(verifyToken)
    }
  }, [])

  // Process verification when token and user are available
  const handleVerifyClick = async () => {
    if (!pendingVerifyToken) return
    setVerifying(true)
    try {
      await verifyEmail(pendingVerifyToken)
      toast.success('Email verified successfully!')
      setPendingVerifyToken(null)
      window.history.replaceState({}, '', '/')
    } catch {
      toast.error('Email verification failed')
    } finally {
      setVerifying(false)
    }
  }

  // Auto-verify when user and token are both available
  useEffect(() => {
    if (pendingVerifyToken && user && !user.emailVerified && !verifying) {
      handleVerifyClick()
    }
  }, [pendingVerifyToken, user, verifying])

  const renderPanel = () => {
    return (
      <div key={dashboardTab} className="tab-panel-enter">
        {(() => {
          switch (dashboardTab) {
            case 'overview':
              return <OverviewPanel />
            case 'provisioning':
              // Operator-only infra wizard (registers real domains / deploys).
              // Customers get provisioned by paying, not by driving this.
              return user?.role === 'admin' || user?.role === 'super_admin' ? (
                <ProvisioningPanel />
              ) : (
                <OverviewPanel />
              )
            case 'hosting':
              return <HostingPanel />
            case 'email':
              return <EmailHostingPanel />
            case 'domains':
              return <DomainsPanel />
            case 'deployments':
              return <DeploymentsPanel />
            case 'pipelines':
              return <PipelinesPanel />
            case 'billing':
              return <BillingPanel />
            case 'webhooks':
              return <WebhooksPanel />
            case 'github':
              return <GithubPanel />
            case 'admin':
              return user?.role === 'admin' || user?.role === 'super_admin' ? <AdminPanel /> : <OverviewPanel />
            case 'teams':
              return <TeamsPanel />
            case 'settings':
              return <SettingsPanel />
            case 'analytics':
              return <AnalyticsPanel />
            case 'monitoring':
              return <UptimePanel />
            case 'assistant':
              return <AssistantPanel />
            case 'support':
              return <SupportPanel />
            default:
              return <OverviewPanel />
          }
        })()}
      </div>
    )
  }

  // Mobile bottom nav items (5 key tabs)
  const MOBILE_NAV_ITEMS: { id: DashboardTab; label: string; icon: React.ElementType }[] = [
    { id: 'overview', label: 'Home', icon: LayoutDashboard },
    { id: 'hosting', label: 'Hosting', icon: Server },
    { id: 'deployments', label: 'Deploy', icon: Rocket },
    { id: 'domains', label: 'Domains', icon: Globe },
    { id: 'settings', label: 'Settings', icon: Settings },
    { id: 'assistant', label: 'AI', icon: Sparkles },
  ]

  return (
    <div className="flex h-screen bg-background">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden animate-fade-in"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 start-0 z-40 w-64 bg-card border-e flex flex-col transition-transform duration-300 ease-out lg:translate-x-0 lg:rtl:translate-x-0 ${
          sidebarOpen ? 'translate-x-0 sidebar-slide-in' : '-translate-x-full rtl:translate-x-full'
        }`}
      >
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-4 py-4 border-b">
          <LogoMark className="size-8" />
          <span className="font-bold text-lg tracking-tight">Apsamo Panel</span>
          <Button
            variant="ghost"
            size="icon"
            className="ms-auto lg:hidden"
            aria-label={t('closeMenu')}
            onClick={() => setSidebarOpen(false)}
          >
            <X className="size-5" />
          </Button>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {NAV_ITEMS.filter(item => !item.adminOnly || user?.role === 'admin' || user?.role === 'super_admin').map((item) => {
            const Icon = item.icon
            const isActive = dashboardTab === item.id
            return (
              <button
                key={item.id}
                onClick={() => {
                  setDashboardTab(item.id)
                  setSidebarOpen(false)
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-indigo-600/10 text-indigo-600 dark:text-indigo-400'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                <Icon className="size-4" />
                {tNav(item.id)}
                {isActive && <div className="ms-auto size-1.5 rounded-full bg-indigo-500" />}
              </button>
            )
          })}
        </nav>

        {/* User section */}
        <div className="p-3 border-t">
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="size-9 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
              <span className="text-sm font-semibold text-indigo-700">
                {user?.name?.charAt(0)?.toUpperCase() || 'U'}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{user?.name || t('user')}</p>
              <p className="text-xs text-muted-foreground truncate">{user?.email || ''}</p>
            </div>
            <Button variant="ghost" size="icon" onClick={() => { logout(); toast.success(t('signedOut')) }} title={t('signOut')} aria-label={t('signOut')}>
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </aside>

      {/* Main content. min-w-0: a flex item otherwise grows to its widest
          content (e.g. a site's 17-tab strip) and pushes the whole page
          wider than the screen; with it, wide strips scroll inside instead. */}
      <main className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Top bar */}
        <header className="sticky top-0 z-20 bg-background/80 backdrop-blur-sm border-b px-4 py-3 flex items-center gap-3 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label={t('openMenu')}
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="size-5" />
          </Button>
          <div className="flex items-center gap-2">
            <h2 className="font-semibold">{dashboardTab === 'overview' ? t('dashboard') : tNav(dashboardTab)}</h2>
            {dashboardTab === 'hosting' && <Badge variant="outline" className="text-[10px] hidden sm:inline-flex">Projects</Badge>}
            {dashboardTab === 'domains' && <Badge variant="outline" className="text-[10px] hidden sm:inline-flex">DNS</Badge>}
            {dashboardTab === 'deployments' && <Badge variant="outline" className="text-[10px] hidden sm:inline-flex">CI/CD</Badge>}
            {dashboardTab === 'github' && <Badge variant="outline" className="text-[10px] hidden sm:inline-flex">Repos</Badge>}
            {dashboardTab === 'monitoring' && <Badge variant="outline" className="text-[10px] hidden sm:inline-flex">Uptime</Badge>}
            {dashboardTab === 'provisioning' && <Badge variant="outline" className="text-[10px] hidden sm:inline-flex bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/30">Auto</Badge>}
          </div>
          <div className="ms-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('deployhub:open-command-palette'))}
              className="hidden sm:flex items-center gap-2 h-9 w-56 lg:w-64 rounded-md border border-input bg-transparent px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={t('openCommandPalette')}
            >
              <Search className="size-4 shrink-0" />
              <span className="flex-1 text-start">{t('searchPlaceholder')}</span>
              <kbd className="pointer-events-none select-none rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                ⌘K
              </kbd>
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="sm:hidden"
              onClick={() => window.dispatchEvent(new CustomEvent('deployhub:open-command-palette'))}
              title={t('search')}
              aria-label={t('search')}
            >
              <Search className="size-4" />
            </Button>
            <LanguageSwitcher compact />
            <ThemeToggle />
            <NotificationCenter />
          </div>
        </header>

        {/* Support access ("log in as customer") — always visible while active */}
        <SupportSessionBanner />
        {/* Admin without 2FA: admin powers paused until it's turned on */}
        <AdminTwoFactorBanner onOpenSettings={() => setDashboardTab('settings')} />
        <IncidentBanner />

        {/* Scrollable content area */}
        <div className="flex-1 overflow-y-auto pb-16 lg:pb-0">
          <div className="p-4 md:p-6 max-w-7xl mx-auto">
            {/* Email Verification Banner */}
            {user && !user.emailVerified && (
              <EmailVerificationBanner
                email={user.email}
                onVerified={markEmailVerified}
              />
            )}
            {/* Verification in progress */}
            {verifying && (
              <div className="mb-4 flex items-center gap-2 p-3 bg-indigo-500/10 border border-indigo-500/30 rounded-lg text-indigo-300 text-sm">
                <div className="size-4 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
                Verifying your email...
              </div>
            )}
            <ErrorBoundary>
              {renderPanel()}
            </ErrorBoundary>
          </div>

          {/* Footer */}
          <footer className="border-t px-4 py-4 text-center text-xs text-muted-foreground mt-auto">
            {t('rights', { year: new Date().getFullYear() })} ·{' '}
            <a href="/status" target="_blank" rel="noreferrer" className="hover:text-foreground">{t('systemStatus')}</a> ·{' '}
            <a href="/help" target="_blank" rel="noreferrer" className="hover:text-foreground">{t('helpCenter')}</a>
          </footer>
        </div>

        {/* Mobile Bottom Navigation */}
        <nav className="fixed bottom-0 start-0 end-0 z-30 bg-card/95 backdrop-blur-sm border-t lg:hidden safe-area-inset-bottom transition-all duration-300">
          <div className="flex items-center justify-around px-1 py-1">
            {MOBILE_NAV_ITEMS.map((item) => {
              const Icon = item.icon
              const isActive = dashboardTab === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => setDashboardTab(item.id)}
                  className={`flex flex-col items-center justify-center gap-0.5 px-3 py-2 rounded-lg min-w-[56px] transition-all duration-200 mobile-nav-indicator ${
                    isActive
                      ? 'text-indigo-600 dark:text-indigo-400 active scale-105'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <div className={`transition-transform duration-200 ${isActive ? 'scale-110' : ''}`}>
                    <Icon className="size-5" />
                  </div>
                  <span className="text-[10px] font-medium">{tNav(MOBILE_LABEL[item.id] ?? item.id)}</span>
                </button>
              )
            })}
          </div>
        </nav>
      </main>

      {/* Command Palette (Cmd+K) — only available when authenticated */}
      <CommandPalette />
    </div>
  )
}

// ── Root page ──────────────────────────────────────────────────────────
export default function HomeClient({
  initialPanelHost = false,
}: {
  initialPanelHost?: boolean
}) {
  const { view, setView, authMode, setAuthMode, setDashboardTab } = useAppStore()
  const { isAuthenticated, isLoading, loadUser } = useAuthStore()
  const [showAuthModal, setShowAuthModal] = useState(false)
  // True when the current host is the panel host (e.g. panel.apsamo.com).
  // Seeded from the server (Host header) so the login screen renders on the
  // first paint — no marketing flash — then confirmed on the client.
  const [isPanelHostView, setIsPanelHostView] = useState(initialPanelHost)
  const [showOnboarding, setShowOnboarding] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('apsamo_onboarding_complete') !== 'true'
    }
    return false
  })

  useEffect(() => {
    // One-time backward-compat migration: rename deployhub_* storage keys → apsamo_*.
    // Idempotent — safe to call on every mount. Preserves existing user sessions.
    migrateStorageKeys()
    loadUser()
  }, [loadUser])

  // ── Host split: marketing on the brand apex, login/dashboard on the panel host ──
  // On the brand apex (apsamo.com) the auth actions send the user to the panel
  // host (panel.apsamo.com) to sign in; on the panel host (or localhost/dev) the
  // auth modal opens in place.
  const openAuthOrRedirect = (mode: 'login' | 'register') => {
    if (typeof window !== 'undefined') {
      const brand = process.env.NEXT_PUBLIC_BRAND_DOMAIN || 'apsamo.com'
      const host = window.location.hostname.toLowerCase()
      const onBrandApex = host === brand || host === `www.${brand}`
      if (onBrandApex) {
        const panelUrl = (process.env.NEXT_PUBLIC_APP_URL || `https://panel.${brand}`)
          .replace(/^http:/, 'https:')
          .replace(/\/$/, '')
        window.location.href = `${panelUrl}/#${mode}`
        return
      }
    }
    setAuthMode(mode)
    setShowAuthModal(true)
  }

  // Arriving from a password-reset email (?reset_token=…): open the reset form
  // with the token filled in. The token is removed from the address bar at
  // once so it doesn't linger in history or get shared with the URL.
  const [linkResetToken, setLinkResetToken] = useState<string | null>(null)
  // Read by the panel-host effect below, which would otherwise switch the
  // dialog straight back to "Sign in".
  const openedFromResetLink = useRef(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const token = params.get('reset_token')
    if (!token) return
    openedFromResetLink.current = true
    params.delete('reset_token')
    const qs = params.toString()
    history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash)
    setLinkResetToken(token)
    setAuthMode('reset-password')
    setShowAuthModal(true)
  }, [setAuthMode])

  // Arriving on the panel host with #login / #register (redirected from the
  // brand site) auto-opens the auth modal, then cleans the hash.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const h = window.location.hash.replace('#', '')
    if ((h === 'login' || h === 'register') && !isAuthenticated) {
      setAuthMode(h)
      setShowAuthModal(true)
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [isAuthenticated, setAuthMode])

  // Detect the panel host (the configured APP_URL host, e.g. panel.apsamo.com).
  // On it, an unauthenticated visitor is shown the login screen directly.
  useEffect(() => {
    if (typeof window === 'undefined') return
    let panelHost = ''
    try {
      panelHost = new URL(process.env.NEXT_PUBLIC_APP_URL || '').hostname.toLowerCase()
    } catch {
      /* ignore */
    }
    if (panelHost && window.location.hostname.toLowerCase() === panelHost) {
      setIsPanelHostView(true)
      if (!openedFromResetLink.current) setAuthMode('login')
    }
  }, [setAuthMode])

  // Remember a referral link's code until the visitor signs up.
  useEffect(() => {
    captureReferralCode()
  }, [])

  // ── Handle URL params (Stripe Checkout redirect, billing tab) ──────
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const tab = params.get('tab') as DashboardTab | null
    const paymentStatus = params.get('payment')

    if (tab) {
      setDashboardTab(tab)
    }

    if (paymentStatus === 'success') {
      toast.success('Payment successful! Your resources are being provisioned.')
    } else if (paymentStatus === 'cancelled') {
      toast.info('Checkout was cancelled.')
    } else if (paymentStatus === 'failed') {
      toast.error('Payment failed. Please try again or contact support.')
    } else if (paymentStatus === 'error') {
      toast.error('Something went wrong processing your payment.')
    }

    if (tab || paymentStatus) {
      // Clean the URL. A website deep link (?tab=hosting&project=<id>#files)
      // stays as it is: the hosting panel keeps it in sync with the open
      // site, so a reload lands on the same site and area. The hash is kept
      // in every case (it names the area inside the site).
      params.delete('payment')
      const keepSite = tab === 'hosting' && !!params.get('project')
      if (!keepSite) params.delete('tab')
      const remaining = params.toString()
      const newUrl = `${window.location.pathname}${remaining ? `?${remaining}` : ''}${window.location.hash}`
      window.history.replaceState(window.history.state, '', newUrl)
    }
  }, [setDashboardTab])

  useEffect(() => {
    if (!isLoading) {
      if (isAuthenticated) {
        setView('dashboard')
        document.title = 'Apsamo Panel'
      } else {
        document.title = 'Apsamo Technology - Hosting & Domain Automation Platform'
      }
    }
  }, [isLoading, isAuthenticated, setView])

  const handleOnboardingComplete = () => {
    localStorage.setItem('apsamo_onboarding_complete', 'true')
    setShowOnboarding(false)
  }

  const handleOnboardingSkip = () => {
    localStorage.setItem('apsamo_onboarding_complete', 'true')
    setShowOnboarding(false)
  }

  // Loading screen
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-3">
          <div className="size-10 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading Apsamo Panel...</p>
        </div>
      </div>
    )
  }

  // Authenticated + Onboarding
  if (isAuthenticated && showOnboarding) {
    return (
      <OnboardingWizard
        onComplete={handleOnboardingComplete}
        onSkip={handleOnboardingSkip}
      />
    )
  }

  // Authenticated → Dashboard
  if (isAuthenticated && view === 'dashboard') {
    return <Dashboard />
  }

  // Not authenticated:
  //   panel host  → login screen only (no marketing)
  //   brand / dev → landing page; auth modal opens on demand
  return (
    <div className="min-h-screen flex flex-col">
      {!isPanelHostView && (
        <LandingPage
          onGetStarted={() => openAuthOrRedirect('register')}
          onLogin={() => openAuthOrRedirect('login')}
        />
      )}
      {(showAuthModal || isPanelHostView) && (
        <AuthModal
          mode={authMode}
          initialResetToken={linkResetToken ?? undefined}
          onModeChange={(mode) => {
            setAuthMode(mode)
          }}
          onClose={() => {
            // AuthModal also calls onClose after a SUCCESSFUL sign-in, so the
            // authenticated case must be handled first — otherwise logging in
            // on the panel host bounces the user to the marketing site instead
            // of their dashboard. Read the store directly rather than the
            // captured `isAuthenticated`, which can still be false in this
            // closure at the moment login resolves.
            const signedIn = useAuthStore.getState().isAuthenticated
            if (isPanelHostView && !signedIn) {
              // The panel host (panel.<brand>) has no marketing content behind
              // the login, so dismissing it must take the user to the brand
              // site rather than leave them on a blank screen.
              const host = window.location.hostname
              const marketingHost = host.replace(/^(panel|www|app|dashboard)\./i, '')
              if (marketingHost && marketingHost !== host) {
                window.location.href = `${window.location.protocol}//${marketingHost}/`
                return
              }
            }
            setShowAuthModal(false)
          }}
        />
      )}
    </div>
  )
}
