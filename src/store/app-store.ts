import { create } from 'zustand'

export type AppView = 'landing' | 'auth' | 'dashboard'
export type DashboardTab = 'overview' | 'hosting' | 'domains' | 'deployments' | 'billing' | 'admin' | 'teams' | 'settings' | 'analytics' | 'pipelines' | 'templates' | 'webhooks' | 'github' | 'assistant' | 'monitoring' | 'provisioning'
export type AuthMode = 'login' | 'register' | 'forgot-password' | 'reset-password' | 'two-factor'

interface AppState {
  view: AppView
  dashboardTab: DashboardTab
  authMode: AuthMode
  sidebarOpen: boolean
  selectedProjectId: string | null
  selectedDomainId: string | null
  setView: (view: AppView) => void
  setDashboardTab: (tab: DashboardTab) => void
  setAuthMode: (mode: AuthMode) => void
  setSidebarOpen: (open: boolean) => void
  setSelectedProjectId: (id: string | null) => void
  setSelectedDomainId: (id: string | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  view: 'landing',
  dashboardTab: 'overview',
  authMode: 'login',
  sidebarOpen: true,
  selectedProjectId: null,
  selectedDomainId: null,
  setView: (view) => set({ view }),
  setDashboardTab: (dashboardTab) => set({ dashboardTab }),
  setAuthMode: (authMode) => set({ authMode }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setSelectedProjectId: (selectedProjectId) => set({ selectedProjectId }),
  setSelectedDomainId: (selectedDomainId) => set({ selectedDomainId }),
}))
