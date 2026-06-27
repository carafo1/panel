import { create } from 'zustand'

export type AppView = 'landing' | 'auth' | 'dashboard'
export type DashboardTab = 'overview' | 'hosting' | 'domains' | 'deployments' | 'billing' | 'admin' | 'teams' | 'settings' | 'analytics' | 'pipelines' | 'templates' | 'webhooks' | 'github' | 'assistant' | 'monitoring' | 'provisioning'
export type AuthMode = 'login' | 'register' | 'forgot-password' | 'reset-password' | 'two-factor'

/**
 * Public marketing site pages.
 * - `home`       — landing hero
 * - `services`   — services index
 * - `service-detail` — a single service (slug carried in `serviceSlug`)
 * - `pricing`    — pricing index
 * - `about`      — about page
 * - `contact`    — contact page
 */
export type PublicPage =
  | 'home'
  | 'services'
  | 'service-detail'
  | 'pricing'
  | 'about'
  | 'contact'
  | 'not-found'

export interface PublicPageState {
  page: PublicPage
  /** Set only when `page === 'service-detail'` */
  slug?: string
}

interface AppState {
  view: AppView
  dashboardTab: DashboardTab
  authMode: AuthMode
  sidebarOpen: boolean
  selectedProjectId: string | null
  selectedDomainId: string | null
  /** Current public marketing site page (driven by the hash router). */
  publicPage: PublicPageState
  setView: (view: AppView) => void
  setDashboardTab: (tab: DashboardTab) => void
  setAuthMode: (mode: AuthMode) => void
  setSidebarOpen: (open: boolean) => void
  setSelectedProjectId: (id: string | null) => void
  setSelectedDomainId: (id: string | null) => void
  setPublicPage: (page: PublicPageState) => void
}

export const useAppStore = create<AppState>((set) => ({
  view: 'landing',
  dashboardTab: 'overview',
  authMode: 'login',
  sidebarOpen: true,
  selectedProjectId: null,
  selectedDomainId: null,
  publicPage: { page: 'home' },
  setView: (view) => set({ view }),
  setDashboardTab: (dashboardTab) => set({ dashboardTab }),
  setAuthMode: (authMode) => set({ authMode }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setSelectedProjectId: (selectedProjectId) => set({ selectedProjectId }),
  setSelectedDomainId: (selectedDomainId) => set({ selectedDomainId }),
  setPublicPage: (publicPage) => set({ publicPage }),
}))
