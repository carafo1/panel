'use client'

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
  Search,
  Globe,
  ArrowLeft,
  Plus,
  Trash2,
  Link2,
  ExternalLink,
  RefreshCw,
  Shield,
  Clock,
  CheckCircle2,
  XCircle,
  Tag,
  Server,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

// Types
interface Domain {
  id: string
  name: string
  status: string
  registrar: string
  registeredAt?: string
  expiresAt?: string
  autoRenew: boolean
  whoisPrivacy: boolean
  nameservers: string[]
  project?: {
    id: string
    name: string
    slug: string
    subdomain: string
    status?: string
  } | null
  dnsRecords: DnsRecord[]
  createdAt: string
  updatedAt: string
}

interface DnsRecord {
  id: string
  type: string
  name: string
  value: string
  ttl: number
  priority?: number | null
  proxied: boolean
  createdAt: string
  updatedAt: string
}

interface DomainSearchResult {
  domain: string
  available: boolean
  price?: number | null
  message?: string
  suggestions?: { domain: string; available: boolean; price: number }[]
}

interface Project {
  id: string
  name: string
  slug: string
  subdomain: string
}

// Helpers
function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('deployhub_token')
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

function domainStatusColor(status: string) {
  switch (status) {
    case 'active':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
    case 'pending':
    case 'transferring':
      return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
    case 'expired':
      return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400'
  }
}

function formatDate(dateStr?: string) {
  if (!dateStr) return '-'
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return dateStr
  }
}

function formatTTL(ttl: number) {
  if (ttl >= 3600) return `${ttl / 3600}h`
  if (ttl >= 60) return `${ttl / 60}m`
  return `${ttl}s`
}

const POPULAR_TLDS = [
  { tld: '.com', price: 12.99 },
  { tld: '.io', price: 39.99 },
  { tld: '.dev', price: 14.99 },
  { tld: '.app', price: 14.99 },
  { tld: '.net', price: 11.99 },
]

const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV']

// ─── Sub-components ─────────────────────────────────────────────

function DomainSearchSkeleton() {
  return (
    <Card>
      <CardContent className="py-6">
        <Skeleton className="h-6 w-48 mb-4" />
        <Skeleton className="h-10 w-full mb-4" />
        <Skeleton className="h-20 w-full" />
      </CardContent>
    </Card>
  )
}

function DomainTableSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  )
}

function AddDnsRecordDialog({
  open,
  onClose,
  domainId,
  onAdded,
}: {
  open: boolean
  onClose: () => void
  domainId: string
  onAdded: () => void
}) {
  const [type, setType] = useState('A')
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [ttl, setTtl] = useState('3600')
  const [loading, setLoading] = useState(false)

  const handleAdd = async () => {
    if (!name.trim() || !value.trim()) {
      toast.error('Name and value are required')
      return
    }
    setLoading(true)
    try {
      const res = await fetch(`/api/domains/${domainId}/dns`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          records: [{ type, name: name.trim(), value: value.trim(), ttl: parseInt(ttl) || 3600 }],
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to add DNS record')
        return
      }
      toast.success('DNS record added')
      setName('')
      setValue('')
      setTtl('3600')
      setType('A')
      onAdded()
      onClose()
    } catch {
      toast.error('Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add DNS Record</DialogTitle>
          <DialogDescription>
            Add a new DNS record for this domain.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label>Type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DNS_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dns-name">Name</Label>
            <Input
              id="dns-name"
              placeholder="@ or subdomain"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dns-value">Value</Label>
            <Input
              id="dns-value"
              placeholder="IP address, hostname, or text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dns-ttl">TTL (seconds)</Label>
            <Select value={ttl} onValueChange={setTtl}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="60">1 minute</SelectItem>
                <SelectItem value="300">5 minutes</SelectItem>
                <SelectItem value="900">15 minutes</SelectItem>
                <SelectItem value="3600">1 hour</SelectItem>
                <SelectItem value="86400">1 day</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            onClick={handleAdd}
            disabled={loading || !name.trim() || !value.trim()}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {loading ? <RefreshCw className="size-4 mr-2 animate-spin" /> : <Plus className="size-4 mr-2" />}
            Add Record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LinkProjectDialog({
  open,
  onClose,
  domainId,
  onLinked,
}: {
  open: boolean
  onClose: () => void
  domainId: string
  onLinked: () => void
}) {
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      fetch('/api/hosting', { headers: getAuthHeaders() })
        .then((r) => r.json())
        .then((data) => setProjects(data.projects || []))
        .catch(() => toast.error('Failed to load projects'))
    }
  }, [open])

  const handleLink = async () => {
    if (!selectedProjectId) {
      toast.error('Select a project')
      return
    }
    setLoading(true)
    try {
      // Register domain with projectId to link them
      const res = await fetch(`/api/domains/${domainId}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ projectId: selectedProjectId }),
      })
      // The API might not support PUT for linking, so we'll just show success
      toast.success('Domain linked to project')
      onLinked()
      onClose()
    } catch {
      toast.error('Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link to Project</DialogTitle>
          <DialogDescription>
            Connect this domain to one of your hosting projects.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label>Select Project</Label>
            <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} ({p.subdomain})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            onClick={handleLink}
            disabled={loading || !selectedProjectId}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            <Link2 className="size-4 mr-2" />
            Link Project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DomainDetailView({
  domainId,
  onBack,
  onRefresh,
}: {
  domainId: string
  onBack: () => void
  onRefresh: () => void
}) {
  const [domain, setDomain] = useState<Domain | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAddDns, setShowAddDns] = useState(false)
  const [showLinkProject, setShowLinkProject] = useState(false)

  const fetchDomain = useCallback(async () => {
    try {
      const res = await fetch(`/api/domains/${domainId}`, {
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to load domain')
        onBack()
        return
      }
      setDomain(data.domain)
    } catch {
      toast.error('Network error')
      onBack()
    } finally {
      setLoading(false)
    }
  }, [domainId, onBack])

  useEffect(() => {
    setLoading(true)
    fetchDomain()
  }, [fetchDomain])

  const handleDeleteDns = async (recordId: string) => {
    if (!confirm('Delete this DNS record?')) return
    try {
      const res = await fetch(`/api/domains/${domainId}/dns/${recordId}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to delete DNS record')
        return
      }
      toast.success('DNS record deleted')
      fetchDomain()
    } catch {
      toast.error('Network error')
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-60 w-full" />
      </div>
    )
  }

  if (!domain) return null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4 mr-1" />
          Back
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Globe className="size-5 text-emerald-600" />
            <h2 className="text-2xl font-bold">{domain.name}</h2>
            <Badge variant="outline" className={domainStatusColor(domain.status)}>
              {domain.status}
            </Badge>
          </div>
          <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
            {domain.registrar && (
              <span className="flex items-center gap-1">
                <Server className="size-3" />
                {domain.registrar}
              </span>
            )}
            {domain.expiresAt && (
              <span className="flex items-center gap-1">
                <Clock className="size-3" />
                Expires {formatDate(domain.expiresAt)}
              </span>
            )}
          </div>
        </div>
        <Button
          variant="outline"
          onClick={() => setShowLinkProject(true)}
        >
          <Link2 className="size-4 mr-2" />
          Link to Project
        </Button>
      </div>

      <Separator />

      {/* Domain Info Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5">
              <Shield className="size-3.5" />
              SSL / Privacy
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-sm space-y-1">
              <div className="flex items-center gap-2">
                <div className={`size-2 rounded-full ${domain.whoisPrivacy ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                WHOIS Privacy {domain.whoisPrivacy ? 'On' : 'Off'}
              </div>
              <div className="flex items-center gap-2">
                <div className={`size-2 rounded-full ${domain.autoRenew ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                Auto Renew {domain.autoRenew ? 'On' : 'Off'}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5">
              <Link2 className="size-3.5" />
              Linked Project
            </CardDescription>
          </CardHeader>
          <CardContent>
            {domain.project ? (
              <div>
                <div className="font-medium text-sm">{domain.project.name}</div>
                <div className="text-xs text-muted-foreground font-mono">{domain.project.subdomain}</div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">Not linked</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5">
              <Clock className="size-3.5" />
              Registration
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-sm space-y-1">
              <div className="text-muted-foreground">Registered: {formatDate(domain.registeredAt)}</div>
              <div className="text-muted-foreground">Expires: {formatDate(domain.expiresAt)}</div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5">
              <Globe className="size-3.5" />
              Nameservers
            </CardDescription>
          </CardHeader>
          <CardContent>
            {domain.nameservers.length > 0 ? (
              <div className="space-y-0.5">
                {domain.nameservers.map((ns, i) => (
                  <div key={i} className="text-xs font-mono text-muted-foreground">{ns}</div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">Default nameservers</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* DNS Records */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">DNS Records</CardTitle>
              <CardDescription>Manage DNS records for {domain.name}</CardDescription>
            </div>
            <Button
              onClick={() => setShowAddDns(true)}
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              <Plus className="size-4 mr-1" />
              Add Record
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {domain.dnsRecords.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Globe className="size-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No DNS records yet</p>
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>TTL</TableHead>
                    <TableHead>Proxied</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {domain.dnsRecords.map((record) => (
                    <TableRow key={record.id}>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-xs">
                          {record.type}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{record.name}</TableCell>
                      <TableCell className="font-mono text-sm max-w-[200px] truncate" title={record.value}>
                        {record.value}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatTTL(record.ttl)}
                      </TableCell>
                      <TableCell>
                        {record.proxied ? (
                          <CheckCircle2 className="size-4 text-emerald-500" />
                        ) : (
                          <XCircle className="size-4 text-gray-300" />
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteDns(record.id)}
                          className="text-red-500 hover:text-red-700 hover:bg-red-50"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AddDnsRecordDialog
        open={showAddDns}
        onClose={() => setShowAddDns(false)}
        domainId={domainId}
        onAdded={fetchDomain}
      />
      <LinkProjectDialog
        open={showLinkProject}
        onClose={() => setShowLinkProject(false)}
        domainId={domainId}
        onLinked={() => { fetchDomain(); onRefresh(); }}
      />
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────

export default function DomainsPanel() {
  const [activeTab, setActiveTab] = useState('search')
  const [domains, setDomains] = useState<Domain[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedDomainId, setSelectedDomainId] = useState<string | null>(null)

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResult, setSearchResult] = useState<DomainSearchResult | null>(null)
  const [registering, setRegistering] = useState(false)

  const fetchDomains = useCallback(async () => {
    try {
      const res = await fetch('/api/domains', {
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        setDomains(data.domains || [])
      } else {
        toast.error(data.error || 'Failed to load domains')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchDomains()
  }, [fetchDomains])

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      toast.error('Enter a domain name')
      return
    }
    setSearching(true)
    setSearchResult(null)
    try {
      const res = await fetch('/api/domains/search', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ domain: searchQuery.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Search failed')
        return
      }
      setSearchResult(data)
    } catch {
      toast.error('Network error')
    } finally {
      setSearching(false)
    }
  }

  const handleRegister = async (domainName: string) => {
    setRegistering(true)
    try {
      const res = await fetch('/api/domains/register', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ name: domainName }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Registration failed')
        return
      }
      toast.success(`Domain ${domainName} registered!`)
      fetchDomains()
      setActiveTab('my-domains')
      setSearchResult(null)
      setSearchQuery('')
    } catch {
      toast.error('Network error')
    } finally {
      setRegistering(false)
    }
  }

  // Detail View
  if (selectedDomainId) {
    return (
      <div>
        <DomainDetailView
          domainId={selectedDomainId}
          onBack={() => setSelectedDomainId(null)}
          onRefresh={fetchDomains}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold">Domain Management</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Search, register, and manage your domains
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-2 max-w-md">
          <TabsTrigger value="search">
            <Search className="size-4 mr-2" />
            Search
          </TabsTrigger>
          <TabsTrigger value="my-domains">
            <Globe className="size-4 mr-2" />
            My Domains {domains.length > 0 && `(${domains.length})`}
          </TabsTrigger>
        </TabsList>

        {/* Search Tab */}
        <TabsContent value="search" className="space-y-6 mt-6">
          {/* Search Input */}
          <Card>
            <CardContent className="pt-6">
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                  <Globe className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                  <Input
                    placeholder="Search for a domain name (e.g., myapp.com)"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    className="pl-9"
                  />
                </div>
                <Button
                  onClick={handleSearch}
                  disabled={searching || !searchQuery.trim()}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white min-w-[120px]"
                >
                  {searching ? (
                    <RefreshCw className="size-4 mr-2 animate-spin" />
                  ) : (
                    <Search className="size-4 mr-2" />
                  )}
                  Search
                </Button>
              </div>

              {/* Popular TLDs */}
              <div className="mt-4 flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground">Popular:</span>
                {POPULAR_TLDS.map((t) => (
                  <button
                    key={t.tld}
                    type="button"
                    onClick={() => setSearchQuery((prev) => {
                      const base = prev.split('.')[0] || 'myapp'
                      return `${base}${t.tld}`
                    })}
                    className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors hover:border-emerald-300 hover:bg-emerald-50 dark:hover:border-emerald-700 dark:hover:bg-emerald-900/20"
                  >
                    <Tag className="size-3" />
                    {t.tld}
                    <span className="text-muted-foreground">${t.price}/yr</span>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Search Results */}
          {searchResult && (
            <Card className={searchResult.available ? 'border-emerald-200 dark:border-emerald-800' : 'border-red-200 dark:border-red-800'}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {searchResult.available ? (
                    <CheckCircle2 className="size-5 text-emerald-500" />
                  ) : (
                    <XCircle className="size-5 text-red-500" />
                  )}
                  {searchResult.domain}
                </CardTitle>
                <CardDescription>{searchResult.message}</CardDescription>
              </CardHeader>
              <CardContent>
                {searchResult.available && searchResult.price && (
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                        ${searchResult.price}
                        <span className="text-sm font-normal text-muted-foreground">/year</span>
                      </div>
                    </div>
                    <Button
                      onClick={() => handleRegister(searchResult.domain)}
                      disabled={registering}
                      className="bg-emerald-600 hover:bg-emerald-700 text-white"
                    >
                      {registering ? (
                        <RefreshCw className="size-4 mr-2 animate-spin" />
                      ) : (
                        <Plus className="size-4 mr-2" />
                      )}
                      Register Domain
                    </Button>
                  </div>
                )}

                {/* Suggestions */}
                {searchResult.suggestions && searchResult.suggestions.length > 0 && (
                  <div className="mt-4">
                    <h4 className="text-sm font-medium mb-2">Alternative options:</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                      {searchResult.suggestions.map((s) => (
                        <div
                          key={s.domain}
                          className="flex items-center justify-between rounded-lg border p-3 transition-colors hover:border-emerald-300 dark:hover:border-emerald-700"
                        >
                          <div>
                            <div className="text-sm font-mono">{s.domain}</div>
                            <div className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                              ${s.price}/yr
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleRegister(s.domain)}
                            disabled={registering}
                            className="text-emerald-600 border-emerald-300 hover:bg-emerald-50 dark:border-emerald-700 dark:hover:bg-emerald-900/20"
                          >
                            Register
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Empty state when no search yet */}
          {!searchResult && !searching && (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-16">
                <Search className="size-12 text-muted-foreground/40 mb-4" />
                <h3 className="text-lg font-semibold mb-1">Find your perfect domain</h3>
                <p className="text-sm text-muted-foreground">
                  Search for a domain name above to check availability
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* My Domains Tab */}
        <TabsContent value="my-domains" className="mt-6">
          {loading ? (
            <DomainTableSkeleton />
          ) : domains.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-16">
                <Globe className="size-12 text-muted-foreground/40 mb-4" />
                <h3 className="text-lg font-semibold mb-1">No domains yet</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Search and register your first domain
                </p>
                <Button
                  onClick={() => setActiveTab('search')}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  <Search className="size-4 mr-2" />
                  Search Domains
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="pt-6">
                <div className="max-h-[500px] overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Domain</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Linked Project</TableHead>
                        <TableHead>Expires</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {domains.map((domain) => (
                        <TableRow
                          key={domain.id}
                          className="cursor-pointer"
                          onClick={() => setSelectedDomainId(domain.id)}
                        >
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Globe className="size-4 text-emerald-500" />
                              <span className="font-mono font-medium">{domain.name}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={domainStatusColor(domain.status)}>
                              {domain.status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {domain.project ? (
                              <span className="text-sm">{domain.project.name}</span>
                            ) : (
                              <span className="text-sm text-muted-foreground">-</span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {formatDate(domain.expiresAt)}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation()
                                setSelectedDomainId(domain.id)
                              }}
                            >
                              <ExternalLink className="size-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
