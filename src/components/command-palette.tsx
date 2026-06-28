'use client'

import { useEffect, useState, useCallback } from 'react'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import {
  LayoutDashboard,
  Server,
  Globe,
  Rocket,
  CreditCard,
  Shield,
  Settings,
  Users,
  BarChart3,
  GitMerge,
  LayoutGrid,
  Webhook,
  Github,
  Sparkles,
  Activity,
  Plus,
  Search,
  Moon,
  Sun,
  LogOut,
  FileText,
  KeyRound,
  ShieldCheck,
  Wallet,
  CornerDownLeft,
} from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { useAppStore, type DashboardTab } from '@/store/app-store'
import { useAuthStore } from '@/store/auth-store'

// ── Custom event the palette dispatches to ask other panels to open
//    their "create" dialogs (e.g. HostingPanel listens for
//    `deployhub:command:create-project`). ────────────────────────────
export const COMMAND_EVENTS = {
  createProject: 'deployhub:command:create-project',
  registerDomain: 'deployhub:command:register-domain',
  deployProject: 'deployhub:command:deploy-project',
  searchTemplates: 'deployhub:command:search-templates',
} as const

type NavItem = {
  id: DashboardTab
  label: string
  icon: React.ElementType
  hint?: string
}

const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, hint: 'Dashboard home' },
  { id: 'hosting', label: 'Hosting', icon: Server, hint: 'Manage projects' },
  { id: 'domains', label: 'Domains', icon: Globe, hint: 'Domain & DNS' },
  { id: 'deployments', label: 'Deployments', icon: Rocket, hint: 'CI/CD history' },
  { id: 'github', label: 'GitHub', icon: Github, hint: 'Repositories' },
  { id: 'pipelines', label: 'Pipelines', icon: GitMerge, hint: 'CI/CD pipelines' },
  { id: 'templates', label: 'Templates', icon: LayoutGrid, hint: 'Starter templates' },
  { id: 'billing', label: 'Billing', icon: CreditCard, hint: 'Plans & invoices' },
  { id: 'webhooks', label: 'Webhooks', icon: Webhook, hint: 'Event delivery' },
  { id: 'monitoring', label: 'Monitoring', icon: Activity, hint: 'Uptime checks' },
  { id: 'teams', label: 'Teams', icon: Users, hint: 'Team members' },
  { id: 'analytics', label: 'Analytics', icon: BarChart3, hint: 'Traffic insights' },
  { id: 'admin', label: 'Admin', icon: Shield, hint: 'Admin panel' },
  { id: 'settings', label: 'Settings', icon: Settings, hint: 'Account settings' },
  { id: 'assistant', label: 'AI Assistant', icon: Sparkles, hint: 'AI helper' },
]

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const { setDashboardTab } = useAppStore()
  const { logout } = useAuthStore()
  const { theme, setTheme } = useTheme()

  // ── Keyboard shortcut: Cmd+K / Ctrl+K ──────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // cmdk ignores input fields automatically, but we mirror that here
      // so the palette never hijacks typing in a textarea/input.
      const target = e.target as HTMLElement | null
      const isTyping =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (!isTyping) {
          setOpen((v) => !v)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // ── Public bus: any component can open the palette ─────────────────
  useEffect(() => {
    const opener = () => setOpen(true)
    window.addEventListener('deployhub:open-command-palette', opener)
    return () => window.removeEventListener('deployhub:open-command-palette', opener)
  }, [])

  const close = useCallback(() => setOpen(false), [])

  const goTo = useCallback(
    (tab: DashboardTab) => {
      setDashboardTab(tab)
      close()
    },
    [setDashboardTab, close],
  )

  const dispatchCommand = useCallback(
    (eventName: string) => {
      window.dispatchEvent(new CustomEvent(eventName))
      close()
    },
    [close],
  )

  const handleCreateProject = useCallback(() => {
    setDashboardTab('hosting')
    // Small delay so the panel mounts before it receives the event.
    setTimeout(() => dispatchCommand(COMMAND_EVENTS.createProject), 50)
  }, [setDashboardTab, dispatchCommand])

  const handleRegisterDomain = useCallback(() => {
    setDashboardTab('domains')
    setTimeout(() => dispatchCommand(COMMAND_EVENTS.registerDomain), 50)
  }, [setDashboardTab, dispatchCommand])

  const handleDeployProject = useCallback(() => {
    goTo('deployments')
  }, [goTo])

  const handleSearchTemplates = useCallback(() => {
    setDashboardTab('templates')
    setTimeout(() => dispatchCommand(COMMAND_EVENTS.searchTemplates), 50)
  }, [setDashboardTab, dispatchCommand])

  const handleToggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark')
    toast.success(`Switched to ${theme === 'dark' ? 'light' : 'dark'} mode`)
    close()
  }, [theme, setTheme, close])

  const handleSignOut = useCallback(async () => {
    close()
    await logout()
    toast.success('Signed out')
  }, [logout, close])

  const isMac =
    typeof navigator !== 'undefined' &&
    (navigator.platform.toLowerCase().includes('mac') ||
      navigator.userAgent.toLowerCase().includes('mac'))

  const modKey = isMac ? '⌘' : 'Ctrl'

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command Palette"
      description="Search commands and navigate Apsamo Panel"
      className="sm:max-w-2xl"
    >
      <CommandInput placeholder={`Search commands... (press ${modKey}K to toggle)`} />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {/* ── Actions ─────────────────────────────────────────────── */}
        <CommandGroup heading="Actions">
          <CommandItem onSelect={handleCreateProject} value="create new project hosting">
            <Plus className="size-4 text-indigo-600" />
            <div className="flex flex-col">
              <span>Create New Project</span>
              <span className="text-xs text-muted-foreground">Provision a new hosting project</span>
            </div>
            <CommandShortcut>New</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleRegisterDomain} value="register domain dns">
            <Globe className="size-4 text-indigo-600" />
            <div className="flex flex-col">
              <span>Register Domain</span>
              <span className="text-xs text-muted-foreground">Search & register a new domain</span>
            </div>
          </CommandItem>
          <CommandItem onSelect={handleDeployProject} value="deploy project deployment">
            <Rocket className="size-4 text-indigo-600" />
            <div className="flex flex-col">
              <span>Deploy Project</span>
              <span className="text-xs text-muted-foreground">View deployment history</span>
            </div>
          </CommandItem>
          <CommandItem onSelect={handleSearchTemplates} value="search templates starter">
            <LayoutGrid className="size-4 text-indigo-600" />
            <div className="flex flex-col">
              <span>Search Templates</span>
              <span className="text-xs text-muted-foreground">Browse starter templates</span>
            </div>
          </CommandItem>
          <CommandItem onSelect={handleToggleTheme} value="toggle theme dark light mode">
            {theme === 'dark' ? (
              <Sun className="size-4 text-amber-500" />
            ) : (
              <Moon className="size-4 text-indigo-500" />
            )}
            <span>Toggle Theme</span>
            <CommandShortcut>{theme === 'dark' ? 'Light' : 'Dark'}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleSignOut} value="sign out logout">
            <LogOut className="size-4 text-red-500" />
            <span>Sign Out</span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        {/* ── Navigation ──────────────────────────────────────────── */}
        <CommandGroup heading="Navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            return (
              <CommandItem
                key={item.id}
                value={`go to ${item.label} ${item.hint || ''}`}
                onSelect={() => goTo(item.id)}
              >
                <Icon className="size-4 text-muted-foreground" />
                <div className="flex flex-col">
                  <span>Go to {item.label}</span>
                  {item.hint && (
                    <span className="text-xs text-muted-foreground">{item.hint}</span>
                  )}
                </div>
              </CommandItem>
            )
          })}
        </CommandGroup>

        <CommandSeparator />

        {/* ── Quick Links ─────────────────────────────────────────── */}
        <CommandGroup heading="Quick Links">
          <CommandItem
            value="view audit logs settings security"
            onSelect={() => goTo('settings')}
          >
            <FileText className="size-4 text-muted-foreground" />
            <span>View Audit Logs</span>
            <CommandShortcut>Settings</CommandShortcut>
          </CommandItem>
          <CommandItem
            value="manage api keys settings tokens"
            onSelect={() => goTo('settings')}
          >
            <KeyRound className="size-4 text-muted-foreground" />
            <span>Manage API Keys</span>
            <CommandShortcut>Settings</CommandShortcut>
          </CommandItem>
          <CommandItem
            value="enable 2fa two factor settings security"
            onSelect={() => goTo('settings')}
          >
            <ShieldCheck className="size-4 text-muted-foreground" />
            <span>Enable 2FA</span>
            <CommandShortcut>Settings</CommandShortcut>
          </CommandItem>
          <CommandItem
            value="manage billing subscription plan invoices"
            onSelect={() => goTo('billing')}
          >
            <Wallet className="size-4 text-muted-foreground" />
            <span>Manage Billing</span>
            <CommandShortcut>Billing</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        {/* ── Footer hint ─────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">↑↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                <CornerDownLeft className="size-2.5 inline" />
              </kbd>
              select
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">esc</kbd>
              close
            </span>
          </div>
          <span className="hidden sm:inline">{modKey}K</span>
        </div>
      </CommandList>
    </CommandDialog>
  )
}

export default CommandPalette
