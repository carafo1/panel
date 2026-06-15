'use client'

import { useState, useEffect } from 'react'
import { useAppStore, type DashboardTab } from '@/store/app-store'
import { useAuthStore } from '@/store/auth-store'
import LandingPage from '@/components/landing/landing-page'
import { AuthModal } from '@/components/auth/auth-modal'
import HostingPanel from '@/components/hosting/hosting-panel'
import DomainsPanel from '@/components/domains/domains-panel'
import { BillingPanel } from '@/components/billing/billing-panel'
import { DeploymentsPanel } from '@/components/deployments/deployments-panel'
import { AdminPanel } from '@/components/admin/admin-panel'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  LayoutDashboard,
  Server,
  Globe,
  Rocket,
  CreditCard,
  Shield,
  Menu,
  X,
  LogOut,
  Bell,
  Activity,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  AlertCircle,
} from 'lucide-react'
import { toast } from 'sonner'

// ── Sidebar nav items ──────────────────────────────────────────────────
const NAV_ITEMS: { id: DashboardTab; label: string; icon: React.ElementType; adminOnly?: boolean }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'hosting', label: 'Hosting', icon: Server },
  { id: 'domains', label: 'Domains', icon: Globe },
  { id: 'deployments', label: 'Deployments', icon: Rocket },
  { id: 'billing', label: 'Billing', icon: CreditCard },
  { id: 'admin', label: 'Admin', icon: Shield, adminOnly: true },
]

// ── Overview Dashboard ─────────────────────────────────────────────────
function OverviewPanel() {
  const { user } = useAuthStore()
  const setDashboardTab = useAppStore((s) => s.setDashboardTab)
  const [stats, setStats] = useState<{ projects: number; domains: number; deployments: number; recentActivity: Array<{ id: string; type: string; message: string; time: string; status: string }> }>({ projects: 0, domains: 0, deployments: 0, recentActivity: [] })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadData() {
      const token = localStorage.getItem('deployhub_token')
      if (!token) return
      try {
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        const [projRes, domRes, depRes] = await Promise.all([
          fetch('/api/hosting', { headers }),
          fetch('/api/domains', { headers }),
          fetch('/api/deployments', { headers }),
        ])
        const projData = await projRes.json().catch(() => ({ projects: [] }))
        const domData = await domRes.json().catch(() => ({ domains: [] }))
        const depData = await depRes.json().catch(() => ({ deployments: [] }))
        const projects = Array.isArray(projData.projects) ? projData.projects.length : Array.isArray(projData) ? projData.length : 0
        const domains = Array.isArray(domData.domains) ? domData.domains.length : Array.isArray(domData) ? domData.length : 0
        const deployments = Array.isArray(depData.deployments) ? depData.deployments.length : Array.isArray(depData) ? depData.length : 0
        
        const activity: Array<{ id: string; type: string; message: string; time: string; status: string }> = []
        if (Array.isArray(depData.deployments)) {
          depData.deployments.slice(0, 5).forEach((d: { id: string; status: string; createdAt: string; projectId?: string }) => {
            activity.push({
              id: d.id,
              type: 'deployment',
              message: `Deployment ${d.status}`,
              time: d.createdAt,
              status: d.status,
            })
          })
        }
        if (Array.isArray(domData.domains)) {
          domData.domains.slice(0, 3).forEach((d: { id: string; status: string; name: string; createdAt: string }) => {
            activity.push({
              id: d.id,
              type: 'domain',
              message: `Domain ${d.name} - ${d.status}`,
              time: d.createdAt,
              status: d.status,
            })
          })
        }
        
        setStats({ projects, domains, deployments, recentActivity: activity.slice(0, 8) })
      } catch {
        // Silently handle
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [])

  const statCards = [
    { title: 'Hosting Projects', value: stats.projects, icon: Server, color: 'bg-emerald-50 text-emerald-600', tab: 'hosting' as DashboardTab },
    { title: 'Domains', value: stats.domains, icon: Globe, color: 'bg-amber-50 text-amber-600', tab: 'domains' as DashboardTab },
    { title: 'Deployments', value: stats.deployments, icon: Rocket, color: 'bg-violet-50 text-violet-600', tab: 'deployments' as DashboardTab },
  ]

  const statusIcon = (status: string) => {
    switch (status) {
      case 'live':
      case 'active':
      case 'completed':
        return <CheckCircle2 className="size-4 text-emerald-500" />
      case 'building':
      case 'deploying':
      case 'running':
      case 'pending':
        return <Clock className="size-4 text-amber-500" />
      default:
        return <AlertCircle className="size-4 text-red-500" />
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">
          Welcome back{user?.name ? `, ${user.name}` : ''}!
        </h1>
        <p className="text-muted-foreground mt-1">
          Here&apos;s what&apos;s happening with your infrastructure.
        </p>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {statCards.map((card) => {
          const Icon = card.icon
          return (
            <button
              key={card.title}
              onClick={() => setDashboardTab(card.tab)}
              className="bg-card border rounded-xl p-5 flex items-center gap-4 hover:shadow-md transition-all text-left group"
            >
              <div className={`size-12 rounded-xl ${card.color} flex items-center justify-center shrink-0`}>
                <Icon className="size-6" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-muted-foreground">{card.title}</p>
                <p className="text-2xl font-bold mt-0.5">{loading ? '...' : card.value}</p>
              </div>
              <ArrowUpRight className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          )
        })}
      </div>

      {/* Quick actions */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Quick Actions</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: 'New Project', desc: 'Create hosting', icon: Server, tab: 'hosting' as DashboardTab },
            { label: 'Register Domain', desc: 'Search domains', icon: Globe, tab: 'domains' as DashboardTab },
            { label: 'View Deployments', desc: 'Recent deploys', icon: Rocket, tab: 'deployments' as DashboardTab },
            { label: 'Manage Billing', desc: 'Plans & invoices', icon: CreditCard, tab: 'billing' as DashboardTab },
          ].map((action) => {
            const Icon = action.icon
            return (
              <button
                key={action.label}
                onClick={() => setDashboardTab(action.tab)}
                className="bg-card border rounded-xl p-4 flex items-center gap-3 hover:border-emerald-300 hover:shadow-sm transition-all text-left"
              >
                <div className="size-9 rounded-lg bg-emerald-50 flex items-center justify-center text-emerald-600 shrink-0">
                  <Icon className="size-4" />
                </div>
                <div>
                  <p className="text-sm font-medium">{action.label}</p>
                  <p className="text-xs text-muted-foreground">{action.desc}</p>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Recent Activity */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Recent Activity</h2>
        <div className="bg-card border rounded-xl divide-y">
          {stats.recentActivity.length === 0 ? (
            <div className="p-8 text-center">
              <Activity className="size-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No recent activity</p>
              <p className="text-xs text-muted-foreground mt-1">Create a project or register a domain to get started</p>
            </div>
          ) : (
            stats.recentActivity.map((item) => (
              <div key={item.id} className="flex items-center gap-3 p-3">
                {statusIcon(item.status)}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{item.message}</p>
                  <p className="text-xs text-muted-foreground">{item.type}</p>
                </div>
                <Badge variant="outline" className="text-[10px] capitalize shrink-0">{item.status}</Badge>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// ── Dashboard with sidebar ─────────────────────────────────────────────
function Dashboard() {
  const { dashboardTab, setDashboardTab, sidebarOpen, setSidebarOpen } = useAppStore()
  const { user, logout } = useAuthStore()

  const renderPanel = () => {
    switch (dashboardTab) {
      case 'overview':
        return <OverviewPanel />
      case 'hosting':
        return <HostingPanel />
      case 'domains':
        return <DomainsPanel />
      case 'deployments':
        return <DeploymentsPanel />
      case 'billing':
        return <BillingPanel />
      case 'admin':
        return user?.role === 'admin' ? <AdminPanel /> : <OverviewPanel />
      default:
        return <OverviewPanel />
    }
  }

  return (
    <div className="flex h-screen bg-background">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-40 w-64 bg-card border-r flex flex-col transition-transform duration-200 lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-4 py-4 border-b">
          <div className="size-8 rounded-lg bg-emerald-600 flex items-center justify-center">
            <Rocket className="size-4 text-white" />
          </div>
          <span className="font-bold text-lg tracking-tight">DeployHub</span>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto lg:hidden"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="size-5" />
          </Button>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {NAV_ITEMS.filter(item => !item.adminOnly || user?.role === 'admin').map((item) => {
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
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                <Icon className="size-4" />
                {item.label}
                {isActive && <div className="ml-auto size-1.5 rounded-full bg-emerald-500" />}
              </button>
            )
          })}
        </nav>

        {/* User section */}
        <div className="p-3 border-t">
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="size-9 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
              <span className="text-sm font-semibold text-emerald-700">
                {user?.name?.charAt(0)?.toUpperCase() || 'U'}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{user?.name || 'User'}</p>
              <p className="text-xs text-muted-foreground truncate">{user?.email || ''}</p>
            </div>
            <Button variant="ghost" size="icon" onClick={() => { logout(); toast.success('Signed out') }} title="Sign out">
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        {/* Top bar */}
        <header className="sticky top-0 z-20 bg-background/80 backdrop-blur-sm border-b px-4 py-3 flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="size-5" />
          </Button>
          <div className="flex items-center gap-2">
            <h2 className="font-semibold capitalize">{dashboardTab === 'overview' ? 'Dashboard' : dashboardTab}</h2>
            {dashboardTab === 'hosting' && <Badge variant="outline" className="text-[10px]">Projects</Badge>}
            {dashboardTab === 'domains' && <Badge variant="outline" className="text-[10px]">DNS</Badge>}
            {dashboardTab === 'deployments' && <Badge variant="outline" className="text-[10px]">CI/CD</Badge>}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="icon" className="relative" onClick={() => toast.info('No new notifications')}>
              <Bell className="size-4" />
              <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-emerald-500" />
            </Button>
          </div>
        </header>

        <div className="p-4 md:p-6 max-w-7xl mx-auto">
          {renderPanel()}
        </div>

        {/* Footer */}
        <footer className="border-t px-4 py-4 text-center text-xs text-muted-foreground mt-auto">
          © 2024 DeployHub. All rights reserved. · Automated Hosting & Domain Platform
        </footer>
      </main>
    </div>
  )
}

// ── Root page ──────────────────────────────────────────────────────────
export default function Home() {
  const { view, setView, setAuthMode } = useAppStore()
  const { isAuthenticated, isLoading, loadUser } = useAuthStore()
  const [showAuthModal, setShowAuthModal] = useState(false)

  useEffect(() => {
    loadUser()
  }, [loadUser])

  useEffect(() => {
    if (!isLoading) {
      if (isAuthenticated) {
        setView('dashboard')
      }
      // If not authenticated, stay on landing page
    }
  }, [isLoading, isAuthenticated, setView])

  // Loading screen
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-3">
          <div className="size-10 animate-spin rounded-full border-4 border-emerald-600 border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading DeployHub...</p>
        </div>
      </div>
    )
  }

  // Authenticated → Dashboard
  if (isAuthenticated && view === 'dashboard') {
    return <Dashboard />
  }

  // Not authenticated → Landing page with auth modal
  return (
    <div className="min-h-screen flex flex-col">
      <LandingPage
        onGetStarted={() => {
          setAuthMode('register')
          setShowAuthModal(true)
        }}
        onLogin={() => {
          setAuthMode('login')
          setShowAuthModal(true)
        }}
      />
      {showAuthModal && (
        <AuthModal
          mode={useAppStore.getState().authMode}
          onModeSwitch={() => {
            const current = useAppStore.getState().authMode
            setAuthMode(current === 'login' ? 'register' : 'login')
          }}
          onClose={() => setShowAuthModal(false)}
        />
      )}
    </div>
  )
}
