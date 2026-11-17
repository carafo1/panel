'use client'

import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '@/store/auth-store'
import { toast } from 'sonner'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  History,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  ShieldAlert,
  Filter,
  Search,
  AlertCircle,
  Activity,
  User as UserIcon,
  Globe,
  Key,
  CreditCard,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────
interface AuditLog {
  id: string
  userId: string | null
  action: string
  resource: string
  resourceId: string | null
  ip: string | null
  userAgent: string | null
  metadata: unknown
  status: string
  createdAt: string
  user?: {
    id: string
    email: string
    name: string
  } | null
}

interface AuditLogsResponse {
  logs: AuditLog[]
  total: number
  page: number
  totalPages: number
  limit: number
  isAdmin: boolean
}

// ── Constants ──────────────────────────────────────────────────────────────
const PAGE_SIZE = 25

const ACTION_GROUPS: Array<{ label: string; value: string; color: string }> = [
  { label: 'user.login', value: 'user.login', color: 'bg-indigo-100 text-indigo-700 hover:bg-indigo-100' },
  { label: 'user.login_failed', value: 'user.login_failed', color: 'bg-red-100 text-red-700 hover:bg-red-100' },
  { label: 'user.logout', value: 'user.logout', color: 'bg-slate-100 text-slate-700 hover:bg-slate-100' },
  { label: 'user.register', value: 'user.register', color: 'bg-indigo-100 text-indigo-700 hover:bg-indigo-100' },
  { label: 'project.create', value: 'project.create', color: 'bg-indigo-100 text-indigo-700 hover:bg-indigo-100' },
  { label: 'project.update', value: 'project.update', color: 'bg-amber-100 text-amber-700 hover:bg-amber-100' },
  { label: 'project.delete', value: 'project.delete', color: 'bg-red-100 text-red-700 hover:bg-red-100' },
  { label: 'project.deploy', value: 'project.deploy', color: 'bg-indigo-100 text-indigo-700 hover:bg-indigo-100' },
  { label: 'domain.register', value: 'domain.register', color: 'bg-indigo-100 text-indigo-700 hover:bg-indigo-100' },
  { label: 'domain.delete', value: 'domain.delete', color: 'bg-red-100 text-red-700 hover:bg-red-100' },
  { label: 'api_key.create', value: 'api_key.create', color: 'bg-indigo-100 text-indigo-700 hover:bg-indigo-100' },
  { label: 'api_key.delete', value: 'api_key.delete', color: 'bg-red-100 text-red-700 hover:bg-red-100' },
  { label: 'subscription.create', value: 'subscription.create', color: 'bg-indigo-100 text-indigo-700 hover:bg-indigo-100' },
]

const RESOURCE_OPTIONS = [
  { label: 'All Resources', value: 'all' },
  { label: 'User', value: 'user' },
  { label: 'Project', value: 'project' },
  { label: 'Domain', value: 'domain' },
  { label: 'API Key', value: 'api_key' },
  { label: 'Subscription', value: 'subscription' },
  { label: 'Payment', value: 'payment' },
]

const ACTION_OPTIONS = [
  { label: 'All Actions', value: 'all' },
  ...ACTION_GROUPS.map((g) => ({ label: g.label, value: g.value })),
]

// ── Helpers ────────────────────────────────────────────────────────────────
function getActionBadgeClass(action: string): string {
  const found = ACTION_GROUPS.find((g) => g.value === action)
  if (found) return found.color
  // Fallback heuristics based on action verb
  if (action.endsWith('.delete') || action.endsWith('_failed') || action.includes('failed')) {
    return 'bg-red-100 text-red-700 hover:bg-red-100'
  }
  if (action.endsWith('.update')) {
    return 'bg-amber-100 text-amber-700 hover:bg-amber-100'
  }
  return 'bg-slate-100 text-slate-700 hover:bg-slate-100'
}

function getStatusBadge(status: string) {
  const isFailure = status === 'failure' || status === 'failed'
  if (isFailure) {
    return (
      <Badge className="bg-red-100 text-red-700 hover:bg-red-100 gap-1">
        <ShieldAlert className="size-3" />
        Failed
      </Badge>
    )
  }
  return (
    <Badge className="bg-indigo-100 text-indigo-700 hover:bg-indigo-100 gap-1">
      <ShieldCheck className="size-3" />
      Success
    </Badge>
  )
}

function formatTimestamp(iso: string): { absolute: string; relative: string } {
  const d = new Date(iso)
  const absolute = d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const now = Date.now()
  const diff = now - d.getTime()
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  let relative: string
  if (seconds < 60) relative = 'just now'
  else if (minutes < 60) relative = `${minutes}m ago`
  else if (hours < 24) relative = `${hours}h ago`
  else if (days < 30) relative = `${days}d ago`
  else relative = d.toLocaleDateString()
  return { absolute, relative }
}

function formatMetadata(metadata: unknown): string {
  if (!metadata) return ''
  if (typeof metadata === 'string') return metadata
  try {
    return JSON.stringify(metadata, null, 2)
  } catch {
    return String(metadata)
  }
}

function getResourceIcon(resource: string) {
  switch (resource) {
    case 'user':
      return <UserIcon className="size-3.5 text-slate-500" />
    case 'project':
      return <Activity className="size-3.5 text-indigo-500" />
    case 'domain':
      return <Globe className="size-3.5 text-indigo-500" />
    case 'api_key':
      return <Key className="size-3.5 text-indigo-500" />
    case 'subscription':
      return <CreditCard className="size-3.5 text-indigo-500" />
    default:
      return <Activity className="size-3.5 text-slate-500" />
  }
}

// ── Component ──────────────────────────────────────────────────────────────
export default function AuditLogPanel() {
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [actionFilter, setActionFilter] = useState<string>('all')
  const [resourceFilter, setResourceFilter] = useState<string>('all')
  const [searchInput, setSearchInput] = useState('')

  const fetchLogs = useCallback(async (targetPage: number = 1) => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      params.set('page', String(targetPage))
      params.set('limit', String(PAGE_SIZE))
      if (actionFilter !== 'all') params.set('action', actionFilter)
      if (resourceFilter !== 'all') params.set('resource', resourceFilter)
      const data = await apiFetch(`/audit-logs?${params.toString()}`) as AuditLogsResponse
      setLogs(data.logs || [])
      setTotal(data.total || 0)
      setPage(data.page || 1)
      setTotalPages(data.totalPages || 1)
      setIsAdmin(!!data.isAdmin)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load audit logs'
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }, [actionFilter, resourceFilter])

  useEffect(() => {
    fetchLogs(1)
  }, [fetchLogs])

  const handlePageChange = (newPage: number) => {
    if (newPage < 1 || newPage > totalPages) return
    fetchLogs(newPage)
  }

  const handleRefresh = () => {
    fetchLogs(page)
    toast.success('Audit logs refreshed')
  }

  const handleClearFilters = () => {
    setActionFilter('all')
    setResourceFilter('all')
    setSearchInput('')
  }

  // Filter logs client-side by search input (resourceId substring)
  const visibleLogs = searchInput.trim()
    ? logs.filter((log) =>
        log.resourceId?.toLowerCase().includes(searchInput.trim().toLowerCase()) ||
        log.action.toLowerCase().includes(searchInput.trim().toLowerCase()) ||
        log.ip?.toLowerCase().includes(searchInput.trim().toLowerCase()) ||
        log.user?.email?.toLowerCase().includes(searchInput.trim().toLowerCase())
      )
    : logs

  const hasActiveFilters = actionFilter !== 'all' || resourceFilter !== 'all' || searchInput.trim() !== ''

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <History className="size-5 text-indigo-600" />
              Audit Logs
            </CardTitle>
            <CardDescription className="mt-1">
              {isAdmin
                ? 'All account activity across the platform (admin view).'
                : 'A record of all actions taken on your account.'}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={loading}
            className="gap-1.5"
          >
            <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ── Filters ────────────────────────────────────────────────── */}
        <div className="flex flex-col md:flex-row gap-2 items-stretch md:items-end">
          <div className="flex-1 space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <Search className="size-3" />
              Search
            </label>
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Filter by IP, resource ID, action, or email (admin)..."
              className="h-9"
            />
          </div>
          <div className="w-full md:w-48 space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <Filter className="size-3" />
              Action
            </label>
            <Select value={actionFilter} onValueChange={setActionFilter}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="All actions" />
              </SelectTrigger>
              <SelectContent>
                {ACTION_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-full md:w-40 space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <Filter className="size-3" />
              Resource
            </label>
            <Select value={resourceFilter} onValueChange={setResourceFilter}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="All resources" />
              </SelectTrigger>
              <SelectContent>
                {RESOURCE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={handleClearFilters} className="h-9">
              Clear
            </Button>
          )}
        </div>

        {/* ── Stats summary ──────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>
            <strong className="text-foreground">{total}</strong> total log{total === 1 ? '' : 's'}
          </span>
          <span className="text-slate-300">•</span>
          <span>
            Showing <strong className="text-foreground">{visibleLogs.length}</strong> of {logs.length} on this page
          </span>
          <span className="text-slate-300">•</span>
          <span>Page <strong className="text-foreground">{page}</strong> of {totalPages}</span>
          {isAdmin && (
            <>
              <span className="text-slate-300">•</span>
              <Badge variant="outline" className="text-[10px] gap-1 border-amber-300 text-amber-700">
                <ShieldAlert className="size-3" />
                Admin view
              </Badge>
            </>
          )}
        </div>

        {/* ── Table ──────────────────────────────────────────────────── */}
        {error ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <div className="size-12 rounded-full bg-red-50 flex items-center justify-center">
              <AlertCircle className="size-6 text-red-500" />
            </div>
            <p className="text-sm font-medium text-red-700">{error}</p>
            <Button variant="outline" size="sm" onClick={() => fetchLogs(page)}>
              <RefreshCw className="size-3.5 me-1.5" />
              Try again
            </Button>
          </div>
        ) : loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : visibleLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <div className="size-14 rounded-full bg-slate-100 flex items-center justify-center">
              <History className="size-7 text-slate-400" />
            </div>
            <div>
              <p className="text-sm font-medium">No audit logs found</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                {hasActiveFilters
                  ? 'Try adjusting your filters or clearing them to see all logs.'
                  : 'When you perform actions like signing in, creating projects, or deploying, they will appear here.'}
              </p>
            </div>
            {hasActiveFilters && (
              <Button variant="outline" size="sm" onClick={handleClearFilters}>
                Clear filters
              </Button>
            )}
          </div>
        ) : (
          <div className="rounded-md border">
            <ScrollArea className="max-h-[28rem]">
              <Table>
                <TableHeader className="sticky top-0 bg-background z-10">
                  <TableRow>
                    <TableHead className="w-[140px]">Timestamp</TableHead>
                    <TableHead className="min-w-[140px]">Action</TableHead>
                    <TableHead className="min-w-[100px]">Resource</TableHead>
                    <TableHead className="min-w-[120px]">Resource ID</TableHead>
                    {isAdmin && <TableHead className="min-w-[140px]">User</TableHead>}
                    <TableHead className="min-w-[110px]">IP Address</TableHead>
                    <TableHead className="w-[100px]">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleLogs.map((log) => {
                    const { absolute, relative } = formatTimestamp(log.createdAt)
                    const metaStr = formatMetadata(log.metadata)
                    return (
                      <TableRow key={log.id} className="hover:bg-muted/40" title={metaStr || undefined}>
                        <TableCell className="font-mono text-xs">
                          <div className="flex flex-col">
                            <span className="font-medium text-foreground">{relative}</span>
                            <span className="text-muted-foreground text-[10px]">{absolute}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge className={`text-[10px] font-mono ${getActionBadgeClass(log.action)}`}>
                            {log.action}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5 text-xs">
                            {getResourceIcon(log.resource)}
                            <span className="font-medium">{log.resource}</span>
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {log.resourceId ? (
                            <span title={log.resourceId} className="inline-block max-w-[120px] truncate align-bottom">
                              {log.resourceId}
                            </span>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </TableCell>
                        {isAdmin && (
                          <TableCell className="text-xs">
                            {log.user ? (
                              <div className="flex flex-col">
                                <span className="font-medium text-foreground">{log.user.name || log.user.email}</span>
                                <span className="text-muted-foreground text-[10px]">{log.user.email}</span>
                              </div>
                            ) : (
                              <span className="text-slate-400 italic">anonymous</span>
                            )}
                          </TableCell>
                        )}
                        <TableCell className="font-mono text-xs">
                          {log.ip ? (
                            <span className="text-muted-foreground">{log.ip}</span>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {getStatusBadge(log.status)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </ScrollArea>
          </div>
        )}

        {/* ── Pagination ─────────────────────────────────────────────── */}
        {!loading && !error && totalPages > 1 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
            <p className="text-xs text-muted-foreground">
              Page <strong className="text-foreground">{page}</strong> of {totalPages}
              {' '}•{' '}
              {total} total log{total === 1 ? '' : 's'}
            </p>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(1)}
                disabled={page === 1}
                className="h-8 px-2"
                title="First page"
              >
                «
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(page - 1)}
                disabled={page === 1}
                className="h-8 gap-1"
              >
                <ChevronLeft className="size-3.5" />
                Prev
              </Button>
              <span className="text-xs font-medium px-2 min-w-[60px] text-center">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(page + 1)}
                disabled={page === totalPages}
                className="h-8 gap-1"
              >
                Next
                <ChevronRight className="size-3.5" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(totalPages)}
                disabled={page === totalPages}
                className="h-8 px-2"
                title="Last page"
              >
                »
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
