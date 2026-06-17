'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Users,
  DollarSign,
  Server,
  Globe,
  Search,
  RefreshCw,
  Cpu,
  HardDrive,
  MapPin,
  Loader2,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  CreditCard,
  ChevronDown,
  Crown,
  User as UserIcon,
  Building2,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '@/store/auth-store'
import { PaymentMethodsPanel } from '@/components/admin/payment-methods-panel'

// ── Types ──────────────────────────────────────────────────────────────
interface Stats {
  totalUsers: number
  recentSignups: number
  totalProjects: number
  activeProjects: number
  totalDomains: number
  totalServers: number
  activeSubscriptions: number
  totalRevenue: number
  totalPayments: number
  monthlyRevenue: number
}

interface AdminUser {
  id: string
  name: string
  email: string
  role: string
  emailVerified: boolean
  createdAt: string
  activeSubscription: {
    id: string
    planName: string
    status: string
  } | null
  stats: {
    projects: number
    domains: number
    payments: number
  }
}

interface Job {
  id: string
  type: string
  payload: Record<string, unknown>
  status: string
  attempts: number
  maxAttempts: number
  error: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

interface ServerInfo {
  id: string
  name: string
  ip: string
  provider: string
  status: string
  cpuCores: number
  ramGB: number
  storageGB: number
  bandwidthGB: number
  usedRamGB: number
  usedStorageGB: number
  region: string
  projectCount: number
  ramUsagePercent: number
  storageUsagePercent: number
}

// ── API helper ─────────────────────────────────────────────────────────
async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('deployhub_token')
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(data.error || `Request failed with status ${res.status}`)
  }
  return res.json()
}

// ── Badge helpers ──────────────────────────────────────────────────────
//
// Roles: super_admin (highest), admin, client, user. Each gets a distinct
// colour so admins can spot privileged users at a glance.
const ROLE_STYLES: Record<
  string,
  { className: string; icon?: React.ElementType }
> = {
  super_admin: {
    className: 'bg-purple-100 text-purple-700 border-purple-200',
    icon: Crown,
  },
  admin: {
    className: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    icon: ShieldCheck,
  },
  client: {
    className: 'bg-blue-100 text-blue-700 border-blue-200',
    icon: Building2,
  },
  user: {
    className: 'bg-gray-100 text-gray-700 border-gray-200',
    icon: UserIcon,
  },
}

function roleLabel(role: string): string {
  switch (role) {
    case 'super_admin':
      return 'Super Admin'
    case 'admin':
      return 'Admin'
    case 'client':
      return 'Client'
    case 'user':
      return 'User'
    default:
      return role.charAt(0).toUpperCase() + role.slice(1)
  }
}

function RoleBadge({ role }: { role: string }) {
  const cfg = ROLE_STYLES[role] || ROLE_STYLES.user
  const Icon = cfg.icon
  return (
    <Badge variant="outline" className={cfg.className}>
      {Icon && <Icon className="size-3 mr-1" />}
      {roleLabel(role)}
    </Badge>
  )
}

function JobStatusBadge({ status }: { status: string }) {
  const map: Record<string, { className: string; icon: React.ElementType }> = {
    queued: { className: 'bg-yellow-100 text-yellow-700 border-yellow-200', icon: Clock },
    processing: { className: 'bg-blue-100 text-blue-700 border-blue-200', icon: Loader2 },
    completed: { className: 'bg-emerald-100 text-emerald-700 border-emerald-200', icon: CheckCircle2 },
    failed: { className: 'bg-red-100 text-red-700 border-red-200', icon: XCircle },
  }
  const cfg = map[status] || map.queued
  const Icon = cfg.icon
  return (
    <Badge variant="outline" className={cfg.className}>
      <Icon className={`size-3 mr-1 ${status === 'processing' ? 'animate-spin' : ''}`} />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  )
}

function ServerStatusBadge({ status }: { status: string }) {
  const map: Record<string, { className: string }> = {
    active: { className: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
    maintenance: { className: 'bg-yellow-100 text-yellow-700 border-yellow-200' },
    offline: { className: 'bg-red-100 text-red-700 border-red-200' },
  }
  const cfg = map[status] || map.offline
  return (
    <Badge variant="outline" className={cfg.className}>
      {status === 'active' && <CheckCircle2 className="size-3 mr-1" />}
      {status === 'maintenance' && <AlertTriangle className="size-3 mr-1" />}
      {status === 'offline' && <XCircle className="size-3 mr-1" />}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  )
}

// ── Component ──────────────────────────────────────────────────────────
export function AdminPanel() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [servers, setServers] = useState<ServerInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [userSearch, setUserSearch] = useState('')
  const [jobFilter, setJobFilter] = useState('all')
  const [retryLoading, setRetryLoading] = useState<string | null>(null)
  const [roleLoading, setRoleLoading] = useState<string | null>(null)

  // Current viewer role — used to gate the super_admin-only Payment
  // Methods tab and the inline role-change dropdown.
  const currentRole = useAuthStore((s) => s.user?.role || '')
  const currentUserId = useAuthStore((s) => s.user?.id || '')
  const isSuperAdmin = currentRole === 'super_admin'

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [statsRes, usersRes, jobsRes, serversRes] = await Promise.all([
        apiFetch<{ stats: Stats }>('/admin/stats').catch(() => ({ stats: null as Stats | null })),
        apiFetch<{ users: AdminUser[] }>('/admin/users').catch(() => ({ users: [] as AdminUser[] })),
        apiFetch<{ jobs: Job[] }>('/admin/jobs').catch(() => ({ jobs: [] as Job[] })),
        apiFetch<{ servers: ServerInfo[] }>('/admin/servers').catch(() => ({
          servers: [] as ServerInfo[],
        })),
      ])
      setStats(statsRes.stats)
      setUsers(usersRes.users)
      setJobs(jobsRes.jobs)
      setServers(serversRes.servers)
    } catch {
      toast.error('Failed to load admin data. Make sure you have admin access.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const handleRetryJob = async (id: string) => {
    setRetryLoading(id)
    try {
      await apiFetch(`/admin/jobs/${id}/retry`, { method: 'POST' })
      toast.success('Job retried')
      await fetchAll()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Retry failed')
    } finally {
      setRetryLoading(null)
    }
  }

  // ── Change a user's role (super_admin only) ───────────────────────
  // Calls PATCH /api/admin/users/[userId]/role with the new role. The
  // API prevents self role-change so we mirror that check client-side
  // for a snappier UX.
  const handleChangeRole = async (userId: string, newRole: string) => {
    if (userId === currentUserId) {
      toast.error('You cannot change your own role')
      return
    }
    setRoleLoading(userId)
    try {
      const res = await apiFetch<{ success: boolean; user: { id: string; role: string } }>(
        `/admin/users/${userId}/role`,
        {
          method: 'PATCH',
          body: JSON.stringify({ role: newRole }),
        }
      )
      setUsers((prev) =>
        prev.map((u) =>
          u.id === res.user.id ? { ...u, role: res.user.role } : u
        )
      )
      toast.success(`Role updated to ${roleLabel(newRole)}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update role')
    } finally {
      setRoleLoading(null)
    }
  }

  // ── Loading skeleton ────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }

  // ── Filtered data ───────────────────────────────────────────────────
  const filteredUsers = users.filter(
    (u) =>
      u.name.toLowerCase().includes(userSearch.toLowerCase()) ||
      u.email.toLowerCase().includes(userSearch.toLowerCase()) ||
      u.role.toLowerCase().includes(userSearch.toLowerCase())
  )

  const filteredJobs =
    jobFilter === 'all' ? jobs : jobs.filter((j) => j.status === jobFilter)

  // ── Stats cards ─────────────────────────────────────────────────────
  const statCards = [
    {
      title: 'Total Users',
      value: stats?.totalUsers ?? 0,
      subtitle: `${stats?.recentSignups ?? 0} new (30d)`,
      icon: Users,
      color: 'text-emerald-600',
      bg: 'bg-emerald-50',
    },
    {
      title: 'Monthly Revenue',
      value: `$${(stats?.monthlyRevenue ?? 0).toLocaleString()}`,
      subtitle: `Total: $${(stats?.totalRevenue ?? 0).toLocaleString()}`,
      icon: DollarSign,
      color: 'text-emerald-600',
      bg: 'bg-emerald-50',
    },
    {
      title: 'Active Projects',
      value: stats?.activeProjects ?? 0,
      subtitle: `${stats?.totalProjects ?? 0} total`,
      icon: Server,
      color: 'text-emerald-600',
      bg: 'bg-emerald-50',
    },
    {
      title: 'Domains Managed',
      value: stats?.totalDomains ?? 0,
      subtitle: `${stats?.activeSubscriptions ?? 0} active subs`,
      icon: Globe,
      color: 'text-emerald-600',
      bg: 'bg-emerald-50',
    },
  ]

  return (
    <div className="space-y-6">
      {/* ── Stats Overview ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((s) => {
          const Icon = s.icon
          return (
            <Card key={s.title}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">{s.title}</p>
                    <p className="text-2xl font-bold mt-1">{s.value}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {s.subtitle}
                    </p>
                  </div>
                  <div className={`size-11 rounded-lg ${s.bg} flex items-center justify-center`}>
                    <Icon className={`size-5 ${s.color}`} />
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* ── Tabbed sections ────────────────────────────────────────── */}
      <Tabs defaultValue="users" className="space-y-4">
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="jobs">Job Queue</TabsTrigger>
          <TabsTrigger value="servers">Servers</TabsTrigger>
          {isSuperAdmin && (
            <TabsTrigger value="payment-methods">
              <CreditCard className="size-4 mr-1.5" />
              Payment Methods
            </TabsTrigger>
          )}
        </TabsList>

        {/* ── Users Tab ──────────────────────────────────────────────── */}
        <TabsContent value="users">
          <Card>
            <CardHeader>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <CardTitle>Users</CardTitle>
                  <CardDescription>
                    {users.length} registered users
                  </CardDescription>
                </div>
                <div className="relative w-full sm:w-64">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                  <Input
                    placeholder="Search users..."
                    className="pl-9"
                    value={userSearch}
                    onChange={(e) => setUserSearch(e.target.value)}
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Plan</TableHead>
                      <TableHead>Projects</TableHead>
                      <TableHead>Joined</TableHead>
                      {isSuperAdmin && <TableHead className="text-right">Actions</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredUsers.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={isSuperAdmin ? 7 : 6} className="text-center py-8 text-muted-foreground">
                          No users found
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredUsers.map((u) => (
                        <TableRow key={u.id}>
                          <TableCell className="font-medium">{u.name}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {u.email}
                          </TableCell>
                          <TableCell>
                            {isSuperAdmin && u.id !== currentUserId ? (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <button
                                    className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs font-medium hover:bg-muted transition-colors disabled:opacity-50"
                                    disabled={roleLoading === u.id}
                                  >
                                    {roleLoading === u.id ? (
                                      <Loader2 className="size-3 animate-spin" />
                                    ) : (
                                      <RoleBadge role={u.role} />
                                    )}
                                    <ChevronDown className="size-3 ml-0.5 text-muted-foreground" />
                                  </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start">
                                  <DropdownMenuLabel>Change role</DropdownMenuLabel>
                                  <DropdownMenuSeparator />
                                  {(['super_admin', 'admin', 'client', 'user'] as const).map(
                                    (r) => (
                                      <DropdownMenuItem
                                        key={r}
                                        onClick={() => handleChangeRole(u.id, r)}
                                        className={u.role === r ? 'bg-muted/60' : ''}
                                      >
                                        <RoleBadge role={r} />
                                        {u.role === r && (
                                          <CheckCircle2 className="size-3.5 ml-auto text-emerald-600" />
                                        )}
                                      </DropdownMenuItem>
                                    )
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            ) : (
                              <RoleBadge role={u.role} />
                            )}
                          </TableCell>
                          <TableCell>
                            {u.activeSubscription ? (
                              <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                                {u.activeSubscription.planName}
                              </Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">Free</span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {u.stats.projects}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {new Date(u.createdAt).toLocaleDateString()}
                          </TableCell>
                          {isSuperAdmin && (
                            <TableCell className="text-right">
                              {u.id === currentUserId ? (
                                <span className="text-xs text-muted-foreground italic">
                                  You
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  Use role menu
                                </span>
                              )}
                            </TableCell>
                          )}
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Jobs Tab ───────────────────────────────────────────────── */}
        <TabsContent value="jobs">
          <Card>
            <CardHeader>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <CardTitle>Job Queue</CardTitle>
                  <CardDescription>
                    {jobs.length} automation jobs
                  </CardDescription>
                </div>
                <div className="flex gap-2 flex-wrap">
                  {['all', 'queued', 'processing', 'completed', 'failed'].map(
                    (filter) => (
                      <Button
                        key={filter}
                        variant={jobFilter === filter ? 'default' : 'outline'}
                        size="sm"
                        className={jobFilter === filter ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}
                        onClick={() => setJobFilter(filter)}
                      >
                        {filter.charAt(0).toUpperCase() + filter.slice(1)}
                      </Button>
                    )
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Attempts</TableHead>
                      <TableHead>Error</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredJobs.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                          No jobs found
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredJobs.map((j) => (
                        <TableRow key={j.id}>
                          <TableCell className="font-medium">
                            {j.type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                          </TableCell>
                          <TableCell>
                            <JobStatusBadge status={j.status} />
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {new Date(j.createdAt).toLocaleString()}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {j.attempts}/{j.maxAttempts}
                          </TableCell>
                          <TableCell className="max-w-[200px] truncate text-xs text-red-500">
                            {j.error || '—'}
                          </TableCell>
                          <TableCell>
                            {j.status === 'failed' && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={retryLoading === j.id}
                                onClick={() => handleRetryJob(j.id)}
                              >
                                {retryLoading === j.id ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : (
                                  <RefreshCw className="size-4" />
                                )}
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Servers Tab ────────────────────────────────────────────── */}
        <TabsContent value="servers">
          {servers.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <Server className="size-10 text-muted-foreground mb-3" />
                <p className="text-muted-foreground">No servers configured</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {servers.map((s) => (
                <Card key={s.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="size-9 rounded-lg bg-emerald-50 flex items-center justify-center">
                          <Server className="size-5 text-emerald-600" />
                        </div>
                        <div>
                          <CardTitle className="text-base">{s.name}</CardTitle>
                          <CardDescription className="flex items-center gap-2 text-xs">
                            <span>{s.ip}</span>
                            <span className="flex items-center gap-1">
                              <MapPin className="size-3" />
                              {s.region}
                            </span>
                          </CardDescription>
                        </div>
                      </div>
                      <ServerStatusBadge status={s.status} />
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* RAM */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <Cpu className="size-3.5" />
                          RAM
                        </span>
                        <span className="font-medium">
                          {s.usedRamGB}/{s.ramGB} GB
                        </span>
                      </div>
                      <Progress value={s.ramUsagePercent} className="h-2" />
                    </div>

                    {/* Storage */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <HardDrive className="size-3.5" />
                          Storage
                        </span>
                        <span className="font-medium">
                          {s.usedStorageGB}/{s.storageGB} GB
                        </span>
                      </div>
                      <Progress value={s.storageUsagePercent} className="h-2" />
                    </div>

                    {/* CPU & extra info */}
                    <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t">
                      <span className="flex items-center gap-1">
                        <Cpu className="size-3" />
                        {s.cpuCores} vCPU
                      </span>
                      <span>{s.projectCount} projects</span>
                      <span>{s.provider}</span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Payment Methods Tab (super_admin only) ─────────────────── */}
        {isSuperAdmin && (
          <TabsContent value="payment-methods">
            <PaymentMethodsPanel />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
