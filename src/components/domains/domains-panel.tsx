'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
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
  Lock,
  Upload,
  MapPin,
  Activity,
  Loader2,
  FileText,
  FileCheck,
  AlertTriangle,
  Radio,
  Copy,
  CloudUpload,
  ShieldCheck,
  HelpCircle,
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
import { Progress } from '@/components/ui/progress'
import { Textarea } from '@/components/ui/textarea'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

// Types
interface DomainVerificationInfo {
  verified: boolean
  verifiedAt?: string | null
  code?: string
  createdAt?: string
}

interface Domain {
  id: string
  name: string
  status: string
  registrar: string
  provider?: string // "deployhub" | "dynadot" | "custom"
  externalId?: string | null
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
  verification?: DomainVerificationInfo | null
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

// SSL Certificate API type
interface SslCertificateApi {
  id: string
  domain: string
  issuer: string
  status: 'active' | 'pending' | 'expired' | 'renewing'
  type: 'auto' | 'custom'
  issuedAt: string
  expiresAt: string
  autoRenew: boolean
  daysRemaining: number
  fingerprint: string
  sans: string[]
  keySize: number
  protocol: string
}

// DNS Propagation API types
interface PropagationChecker {
  location: string
  ip: string
  status: 'propagated' | 'pending' | 'failed'
  checkedAt: string
  latency?: number
}

interface RecordPropagation {
  id: string
  type: string
  name: string
  value: string
  propagation: {
    overall: number
    checkers: PropagationChecker[]
  }
}

interface PropagationResponse {
  domain: string
  nameservers: string[]
  records: RecordPropagation[]
  overallPropagation: number
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
    case 'pending_verification':
    case 'transferring':
      return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
    case 'expired':
      return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400'
  }
}

function providerLabel(provider?: string): string {
  switch (provider) {
    case 'dynadot':
      return 'Dynadot'
    case 'custom':
      return 'Custom'
    case 'deployhub':
    default:
      return 'DeployHub'
  }
}

function providerColor(provider?: string): string {
  switch (provider) {
    case 'dynadot':
      return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
    case 'custom':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
    case 'deployhub':
    default:
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
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

// ─── Propagation Ring Component ──────────────────────────────────

function PropagationRing({ percentage, size = 80 }: { percentage: number; size?: number }) {
  const strokeWidth = 6
  const radius = (size - strokeWidth) / 2
  const circumference = radius * 2 * Math.PI
  const offset = circumference - (percentage / 100) * circumference

  const color =
    percentage >= 80
      ? 'text-emerald-500'
      : percentage >= 50
      ? 'text-yellow-500'
      : 'text-red-500'

  const strokeColor =
    percentage >= 80
      ? 'stroke-emerald-500'
      : percentage >= 50
      ? 'stroke-yellow-500'
      : 'stroke-red-500'

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg className="transform -rotate-90" width={size} height={size}>
        <circle
          className="stroke-muted"
          strokeWidth={strokeWidth}
          fill="transparent"
          r={radius}
          cx={size / 2}
          cy={size / 2}
        />
        <circle
          className={strokeColor}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          fill="transparent"
          r={radius}
          cx={size / 2}
          cy={size / 2}
          style={{ transition: 'stroke-dashoffset 0.8s ease-in-out' }}
        />
      </svg>
      <div className={`absolute text-sm font-bold ${color}`}>
        {percentage}%
      </div>
    </div>
  )
}

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
      await fetch(`/api/domains/${domainId}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ projectId: selectedProjectId }),
      })
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

// ─── Domain Detail View with Tabs ──────────────────────────────

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
  const [detailTab, setDetailTab] = useState('dns')

  // SSL state
  const [sslData, setSslData] = useState<SslCertificateApi | null>(null)
  const [sslLoading, setSslLoading] = useState(true)
  const [renewingSsl, setRenewingSsl] = useState(false)
  const [showUploadCert, setShowUploadCert] = useState(false)
  const [certPem, setCertPem] = useState('')
  const [certKey, setCertKey] = useState('')
  const [uploadingCert, setUploadingCert] = useState(false)

  // DNS Propagation state
  const [propagationData, setPropagationData] = useState<PropagationResponse | null>(null)
  const [propagationLoading, setPropagationLoading] = useState(false)
  const [expandedRecords, setExpandedRecords] = useState<Set<string>>(new Set())

  // Verification state (for custom / pending_verification domains)
  const [verifyCode, setVerifyCode] = useState<string | null>(null)
  const [verifyInstructions, setVerifyInstructions] = useState<string>('')
  const [verifyLoading, setVerifyLoading] = useState(false)
  const [verifying, setVerifying] = useState(false)

  // Sync-from-Dynadot state
  const [syncing, setSyncing] = useState(false)

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

  const fetchSslData = useCallback(async () => {
    setSslLoading(true)
    try {
      const res = await fetch(`/api/domains/${domainId}/ssl`, {
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        setSslData(data.certificate)
      }
    } catch {
      // Silently fail - will show fallback
    } finally {
      setSslLoading(false)
    }
  }, [domainId])

  const fetchPropagationData = useCallback(async () => {
    setPropagationLoading(true)
    try {
      const res = await fetch(`/api/domains/${domainId}/propagation`, {
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        setPropagationData(data)
      }
    } catch {
      toast.error('Failed to check propagation')
    } finally {
      setPropagationLoading(false)
    }
  }, [domainId])

  // Fetch the DNS verification code + instructions (for pending_verification domains)
  const fetchVerifyCode = useCallback(async () => {
    setVerifyLoading(true)
    try {
      const res = await fetch(`/api/domains/${domainId}/verify-code`, {
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (res.ok) {
        setVerifyCode(data.code || null)
        setVerifyInstructions(data.instructions || '')
      }
    } catch {
      // Silent - verification is optional
    } finally {
      setVerifyLoading(false)
    }
  }, [domainId])

  // Verify the domain by checking DNS TXT record against expected code
  const handleVerify = async () => {
    setVerifying(true)
    try {
      const res = await fetch(`/api/domains/${domainId}/verify`, {
        method: 'POST',
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Verification failed')
        return
      }
      if (data.verified) {
        toast.success(data.message || 'Domain verified successfully!')
        fetchDomain()
        onRefresh()
      } else {
        toast.error(data.message || 'Verification failed - DNS record not found yet')
      }
    } catch {
      toast.error('Network error during verification')
    } finally {
      setVerifying(false)
    }
  }

  // Sync domain info from Dynadot
  const handleSyncDynadot = async () => {
    setSyncing(true)
    try {
      const res = await fetch(`/api/domains/${domainId}/sync`, {
        method: 'POST',
        headers: getAuthHeaders(),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to sync from Dynadot')
        return
      }
      toast.success(data.demo ? 'Synced from Dynadot (demo mode)' : 'Synced from Dynadot')
      fetchDomain()
      onRefresh()
    } catch {
      toast.error('Network error during sync')
    } finally {
      setSyncing(false)
    }
  }

  // Copy verification code to clipboard
  const handleCopyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      toast.success('Verification code copied to clipboard')
    } catch {
      toast.error('Failed to copy - copy manually')
    }
  }

  useEffect(() => {
    setLoading(true)
    fetchDomain()
  }, [fetchDomain])

  // Load verification code when domain arrives in pending_verification state
  useEffect(() => {
    if (domain && domain.status === 'pending_verification') {
      fetchVerifyCode()
    }
  }, [domain, fetchVerifyCode])

  useEffect(() => {
    if (domainId) {
      fetchSslData()
    }
  }, [domainId, fetchSslData])

  // SSL Renew handler
  const handleRenewSsl = async () => {
    setRenewingSsl(true)
    try {
      const res = await fetch(`/api/domains/${domainId}/ssl`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ action: 'renew' }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to renew certificate')
        return
      }
      toast.success('Certificate renewal initiated')
      // Poll for completion after 2 seconds
      setTimeout(() => {
        fetchSslData()
      }, 2500)
    } catch {
      toast.error('Network error')
    } finally {
      setRenewingSsl(false)
    }
  }

  // SSL Upload handler
  const handleUploadCert = async () => {
    if (!certPem.trim() || !certKey.trim()) {
      toast.error('Certificate and private key are required')
      return
    }
    setUploadingCert(true)
    try {
      const res = await fetch(`/api/domains/${domainId}/ssl`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          action: 'upload',
          certificate: certPem,
          privateKey: certKey,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to upload certificate')
        return
      }
      toast.success('Custom certificate uploaded successfully')
      setShowUploadCert(false)
      setCertPem('')
      setCertKey('')
      fetchSslData()
    } catch {
      toast.error('Network error')
    } finally {
      setUploadingCert(false)
    }
  }

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
      // Also refresh propagation if it was loaded
      if (propagationData) {
        fetchPropagationData()
      }
    } catch {
      toast.error('Network error')
    }
  }

  const toggleRecordExpanded = (recordId: string) => {
    setExpandedRecords((prev) => {
      const next = new Set(prev)
      if (next.has(recordId)) {
        next.delete(recordId)
      } else {
        next.add(recordId)
      }
      return next
    })
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
          <div className="flex items-center gap-3 flex-wrap">
            <Globe className="size-5 text-emerald-600" />
            <h2 className="text-2xl font-bold">{domain.name}</h2>
            <Badge variant="outline" className={domainStatusColor(domain.status)}>
              {domain.status}
            </Badge>
            <Badge variant="outline" className={providerColor(domain.provider)}>
              <Server className="size-3 mr-1" />
              {providerLabel(domain.provider)}
            </Badge>
            {domain.provider === 'dynadot' && domain.externalId && (
              <Badge variant="outline" className="font-mono text-xs">
                ID: {domain.externalId.length > 16 ? domain.externalId.substring(0, 16) + '...' : domain.externalId}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground flex-wrap">
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
            {domain.verification?.verified && (
              <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <ShieldCheck className="size-3" />
                Verified
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {domain.provider === 'dynadot' && (
            <Button
              variant="outline"
              onClick={handleSyncDynadot}
              disabled={syncing}
              size="sm"
            >
              {syncing ? (
                <Loader2 className="size-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="size-4 mr-2" />
              )}
              {syncing ? 'Syncing...' : 'Sync from Dynadot'}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => setShowLinkProject(true)}
            size="sm"
          >
            <Link2 className="size-4 mr-2" />
            Link to Project
          </Button>
        </div>
      </div>

      <Separator />

      {/* ─── Verification Banner (for pending_verification domains) ─── */}
      {domain.status === 'pending_verification' && (
        <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-900/10">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <ShieldCheck className="size-5 text-amber-600 dark:text-amber-400" />
              Verify Domain Ownership
            </CardTitle>
            <CardDescription>
              This custom domain requires DNS verification before it can be activated.
              Add the TXT record below at your DNS provider, then click &quot;Verify Now&quot;.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {verifyLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading verification code...
              </div>
            ) : verifyCode ? (
              <>
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">
                    Step 1 — Add this TXT record at your DNS provider:
                  </div>
                  <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-white dark:bg-card overflow-hidden">
                    <div className="grid grid-cols-1 sm:grid-cols-[100px_1fr] gap-x-4 gap-y-2 p-3 text-sm">
                      <div className="text-muted-foreground">Type</div>
                      <div className="font-mono font-medium">TXT</div>
                      <div className="text-muted-foreground">Name / Host</div>
                      <div className="font-mono font-medium">@</div>
                      <div className="text-muted-foreground">Value</div>
                      <div className="flex items-start gap-2 min-w-0">
                        <code className="font-mono text-xs break-all bg-amber-50 dark:bg-amber-900/20 px-2 py-1 rounded flex-1">
                          {verifyCode}
                        </code>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleCopyCode(verifyCode)}
                          className="shrink-0"
                        >
                          <Copy className="size-3.5 mr-1" />
                          Copy
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground flex items-start gap-2">
                  <HelpCircle className="size-3.5 mt-0.5 shrink-0" />
                  <span>
                    DNS changes can take a few minutes to propagate. The Name / Host is
                    usually &quot;@&quot; (apex domain) or your domain name, depending on
                    your DNS provider. The Value must be entered exactly as shown.
                  </span>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Button
                    onClick={handleVerify}
                    disabled={verifying}
                    className="bg-amber-600 hover:bg-amber-700 text-white"
                  >
                    {verifying ? (
                      <Loader2 className="size-4 mr-2 animate-spin" />
                    ) : (
                      <ShieldCheck className="size-4 mr-2" />
                    )}
                    {verifying ? 'Verifying...' : 'Verify Now'}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={fetchVerifyCode}
                    disabled={verifyLoading}
                  >
                    <RefreshCw className="size-4 mr-2" />
                    Reload Code
                  </Button>
                </div>
                {verifyInstructions && (
                  <div className="text-xs text-muted-foreground bg-amber-50/50 dark:bg-amber-900/10 rounded p-2 border border-amber-100 dark:border-amber-900">
                    {verifyInstructions}
                  </div>
                )}
              </>
            ) : (
              <div className="text-sm text-muted-foreground">
                No verification code available. Try reloading.
              </div>
            )}
          </CardContent>
        </Card>
      )}

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

      {/* Tabbed Detail Section */}
      <Tabs value={detailTab} onValueChange={setDetailTab}>
        <TabsList className="grid w-full grid-cols-3 max-w-md">
          <TabsTrigger value="dns">
            <Globe className="size-4 mr-2" />
            DNS
          </TabsTrigger>
          <TabsTrigger value="ssl">
            <Lock className="size-4 mr-2" />
            SSL
          </TabsTrigger>
          <TabsTrigger value="settings">
            <Server className="size-4 mr-2" />
            Settings
          </TabsTrigger>
        </TabsList>

        {/* ─── DNS Records Tab ─────────────────────────────────── */}
        <TabsContent value="dns" className="space-y-6 mt-6">

          {/* DNS Propagation Widget */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Radio className="size-5 text-emerald-600" />
                    DNS Propagation
                  </CardTitle>
                  <CardDescription>
                    Check how your DNS records have propagated across global resolvers
                  </CardDescription>
                </div>
                <Button
                  onClick={fetchPropagationData}
                  disabled={propagationLoading}
                  size="sm"
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  {propagationLoading ? (
                    <Loader2 className="size-4 mr-1 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4 mr-1" />
                  )}
                  {propagationLoading ? 'Checking...' : 'Check Propagation'}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {!propagationData && !propagationLoading ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Radio className="size-8 mx-auto mb-2 opacity-40" />
                  <p className="text-sm">Click &quot;Check Propagation&quot; to verify DNS across global servers</p>
                </div>
              ) : propagationLoading && !propagationData ? (
                <div className="text-center py-8">
                  <Loader2 className="size-8 mx-auto mb-2 text-emerald-500 animate-spin" />
                  <p className="text-sm text-muted-foreground">Checking propagation across global servers...</p>
                </div>
              ) : propagationData ? (
                <div className="space-y-4">
                  {/* Overall Propagation */}
                  <div className="flex items-center gap-6">
                    <PropagationRing percentage={propagationData.overallPropagation} size={80} />
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium">Overall Propagation</span>
                        <span className={`font-bold ${
                          propagationData.overallPropagation >= 80 ? 'text-emerald-600' :
                          propagationData.overallPropagation >= 50 ? 'text-yellow-600' :
                          'text-red-600'
                        }`}>
                          {propagationData.overallPropagation}%
                        </span>
                      </div>
                      <Progress
                        value={propagationData.overallPropagation}
                        className={`h-2 ${
                          propagationData.overallPropagation >= 80 ? '[&>[data-slot=progress-indicator]]:bg-emerald-500' :
                          propagationData.overallPropagation >= 50 ? '[&>[data-slot=progress-indicator]]:bg-yellow-500' :
                          '[&>[data-slot=progress-indicator]]:bg-red-500'
                        }`}
                      />
                      <div className="text-xs text-muted-foreground">
                        {propagationData.records.filter(r => r.propagation.overall >= 80).length} of {propagationData.records.length} records fully propagated
                      </div>
                    </div>
                  </div>

                  {/* Per-record propagation */}
                  {propagationData.records.length > 0 && (
                    <>
                      <Separator />
                      <div className="space-y-2">
                        <h4 className="text-sm font-medium">Record Propagation Status</h4>
                        <div className="space-y-2">
                          {propagationData.records.map((record) => (
                            <Collapsible
                              key={record.id}
                              open={expandedRecords.has(record.id)}
                              onOpenChange={() => toggleRecordExpanded(record.id)}
                            >
                              <CollapsibleTrigger asChild>
                                <div
                                  className={`flex items-center justify-between rounded-lg border p-3 cursor-pointer hover:bg-muted/50 transition-colors ${
                                    record.propagation.overall >= 80
                                      ? 'border-emerald-200 dark:border-emerald-800'
                                      : record.propagation.overall >= 50
                                      ? 'border-yellow-200 dark:border-yellow-800'
                                      : 'border-red-200 dark:border-red-800'
                                  }`}
                                >
                                  <div className="flex items-center gap-3 min-w-0">
                                    {/* Propagation indicator */}
                                    {record.propagation.overall >= 80 ? (
                                      <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />
                                    ) : record.propagation.overall >= 50 ? (
                                      <Clock className="size-4 text-yellow-500 shrink-0" />
                                    ) : (
                                      <XCircle className="size-4 text-red-500 shrink-0" />
                                    )}
                                    <Badge variant="outline" className="font-mono text-xs shrink-0">
                                      {record.type}
                                    </Badge>
                                    <span className="text-sm font-mono truncate">{record.name}</span>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    <span className={`text-xs font-medium ${
                                      record.propagation.overall >= 80 ? 'text-emerald-600' :
                                      record.propagation.overall >= 50 ? 'text-yellow-600' :
                                      'text-red-600'
                                    }`}>
                                      {record.propagation.overall}%
                                    </span>
                                    <svg
                                      className={`size-4 text-muted-foreground transition-transform ${
                                        expandedRecords.has(record.id) ? 'rotate-180' : ''
                                      }`}
                                      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                                    >
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                                    </svg>
                                  </div>
                                </div>
                              </CollapsibleTrigger>
                              <CollapsibleContent>
                                <div className="pl-4 pr-2 pt-2 pb-1 space-y-2">
                                  <div className="text-xs text-muted-foreground mb-2">
                                    Value: <span className="font-mono">{record.value}</span>
                                  </div>
                                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                    {record.propagation.checkers.map((checker, idx) => (
                                      <div
                                        key={idx}
                                        className={`flex items-center justify-between rounded-md border px-3 py-2 text-xs ${
                                          checker.status === 'propagated'
                                            ? 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-900/10'
                                            : checker.status === 'pending'
                                            ? 'border-yellow-200 bg-yellow-50/50 dark:border-yellow-800 dark:bg-yellow-900/10'
                                            : 'border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-900/10'
                                        }`}
                                      >
                                        <div className="flex items-center gap-2 min-w-0">
                                          <MapPin className="size-3 text-muted-foreground shrink-0" />
                                          <span className="truncate font-medium">{checker.location}</span>
                                        </div>
                                        <div className="flex items-center gap-1.5 shrink-0">
                                          {checker.status === 'propagated' ? (
                                            <CheckCircle2 className="size-3.5 text-emerald-500" />
                                          ) : checker.status === 'pending' ? (
                                            <Clock className="size-3.5 text-yellow-500" />
                                          ) : (
                                            <XCircle className="size-3.5 text-red-500" />
                                          )}
                                          {checker.latency && (
                                            <span className="text-muted-foreground">{checker.latency}ms</span>
                                          )}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </CollapsibleContent>
                            </Collapsible>
                          ))}
                        </div>
                      </div>
                    </>
                  )}

                  {/* Nameservers */}
                  {propagationData.nameservers.length > 0 && (
                    <>
                      <Separator />
                      <div className="space-y-2">
                        <h4 className="text-sm font-medium">Nameservers</h4>
                        <div className="flex flex-wrap gap-2">
                          {propagationData.nameservers.map((ns, i) => (
                            <Badge key={i} variant="outline" className="font-mono text-xs">
                              <Server className="size-3 mr-1" />
                              {ns}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* DNS Records Table */}
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
                      {domain.dnsRecords.map((record) => {
                        // Find propagation status for this record
                        const recordProp = propagationData?.records.find(r => r.id === record.id)
                        return (
                          <TableRow key={record.id}>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <Badge variant="outline" className="font-mono text-xs">
                                  {record.type}
                                </Badge>
                                {/* Small propagation indicator */}
                                {recordProp && (
                                  recordProp.propagation.overall >= 80 ? (
                                    <CheckCircle2 className="size-3.5 text-emerald-500" />
                                  ) : recordProp.propagation.overall >= 50 ? (
                                    <Clock className="size-3.5 text-yellow-500" />
                                  ) : (
                                    <XCircle className="size-3.5 text-red-500" />
                                  )
                                )}
                              </div>
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
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── SSL Certificate Tab ─────────────────────────────── */}
        <TabsContent value="ssl" className="space-y-6 mt-6">
          {sslLoading ? (
            <Card>
              <CardContent className="py-8">
                <div className="text-center">
                  <Loader2 className="size-8 mx-auto mb-2 text-emerald-500 animate-spin" />
                  <p className="text-sm text-muted-foreground">Loading SSL certificate information...</p>
                </div>
              </CardContent>
            </Card>
          ) : sslData ? (
            <>
              {/* Certificate Status Card */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Shield className="size-5 text-emerald-600" />
                    Certificate Status
                  </CardTitle>
                  <CardDescription>
                    SSL/TLS certificate details for {domain.name}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {/* Status Banner */}
                    <div
                      className={`flex items-center gap-3 rounded-xl border p-4 ${
                        sslData.status === 'active'
                          ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/20'
                          : sslData.status === 'expired'
                          ? 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20'
                          : sslData.status === 'renewing'
                          ? 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/20'
                          : 'border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-900/20'
                      }`}
                    >
                      {sslData.status === 'active' ? (
                        <Shield className="size-8 text-emerald-600 shrink-0" />
                      ) : sslData.status === 'expired' ? (
                        <AlertTriangle className="size-8 text-red-500 shrink-0" />
                      ) : sslData.status === 'renewing' ? (
                        <Loader2 className="size-8 text-blue-500 shrink-0 animate-spin" />
                      ) : (
                        <Lock className="size-8 text-yellow-500 shrink-0" />
                      )}
                      <div>
                        <div className="font-medium">
                          {sslData.status === 'active'
                            ? 'Certificate Active'
                            : sslData.status === 'expired'
                            ? 'Certificate Expired'
                            : sslData.status === 'renewing'
                            ? 'Certificate Renewing'
                            : 'Certificate Pending'}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {sslData.status === 'active'
                            ? 'Your site is securely served over HTTPS'
                            : sslData.status === 'expired'
                            ? 'Your certificate has expired — visitors may see security warnings'
                            : sslData.status === 'renewing'
                            ? 'Certificate renewal is in progress'
                            : 'Certificate is being provisioned'}
                        </div>
                      </div>
                    </div>

                    {/* Certificate Details Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <div className="text-xs text-muted-foreground">Certificate Type</div>
                        <div className="flex items-center gap-2">
                          <FileText className="size-4 text-muted-foreground" />
                          <span className="text-sm font-medium">
                            {sslData.type === 'auto' ? "Let's Encrypt (Auto)" : 'Custom'}
                          </span>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs text-muted-foreground">Issuer</div>
                        <div className="text-sm font-medium">{sslData.issuer}</div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs text-muted-foreground">Issued Date</div>
                        <div className="text-sm font-medium">{formatDate(sslData.issuedAt)}</div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs text-muted-foreground">Expiry Date</div>
                        <div className={`text-sm font-medium ${sslData.status === 'expired' ? 'text-red-600' : ''}`}>
                          {formatDate(sslData.expiresAt)}
                        </div>
                      </div>
                    </div>

                    {/* Days Remaining Progress Bar */}
                    {sslData.status !== 'renewing' && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-medium">Days Remaining</span>
                          <span className={`font-bold ${
                            sslData.daysRemaining > 30 ? 'text-emerald-600' :
                            sslData.daysRemaining > 15 ? 'text-yellow-600' :
                            'text-red-600'
                          }`}>
                            {sslData.daysRemaining} days
                          </span>
                        </div>
                        <Progress
                          value={Math.min(100, (sslData.daysRemaining / 90) * 100)}
                          className={`h-3 ${
                            sslData.daysRemaining > 30 ? '[&>[data-slot=progress-indicator]]:bg-emerald-500' :
                            sslData.daysRemaining > 15 ? '[&>[data-slot=progress-indicator]]:bg-yellow-500' :
                            '[&>[data-slot=progress-indicator]]:bg-red-500'
                          }`}
                        />
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>
                            {sslData.daysRemaining > 30 ? 'Certificate is healthy' :
                             sslData.daysRemaining > 15 ? 'Consider renewing soon' :
                             sslData.daysRemaining > 0 ? 'Renew immediately' :
                             'Certificate has expired'}
                          </span>
                          {sslData.daysRemaining <= 15 && sslData.daysRemaining > 0 && (
                            <span className="flex items-center gap-1 text-yellow-600">
                              <AlertTriangle className="size-3" />
                              Expiring soon
                            </span>
                          )}
                          {sslData.daysRemaining === 0 && (
                            <span className="flex items-center gap-1 text-red-600">
                              <AlertTriangle className="size-3" />
                              Expired
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Auto-renew indicator */}
                    <div className="flex items-center gap-2 text-sm">
                      <div className={`size-2 rounded-full ${sslData.autoRenew ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                      Auto-renew {sslData.autoRenew ? 'enabled' : 'disabled'}
                    </div>

                    <Separator />

                    {/* Actions */}
                    <div className="flex flex-col sm:flex-row gap-3">
                      {sslData.type === 'auto' && (
                        <Button
                          onClick={handleRenewSsl}
                          disabled={renewingSsl || sslData.status === 'renewing'}
                          className="bg-emerald-600 hover:bg-emerald-700 text-white"
                        >
                          {renewingSsl || sslData.status === 'renewing' ? (
                            <Loader2 className="size-4 mr-2 animate-spin" />
                          ) : (
                            <RefreshCw className="size-4 mr-2" />
                          )}
                          {sslData.status === 'renewing' ? 'Renewing...' : 'Renew Certificate'}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        onClick={() => setShowUploadCert(true)}
                        className="border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-400 dark:hover:bg-emerald-900/20"
                      >
                        <Upload className="size-4 mr-2" />
                        Upload Custom Certificate
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Security Info Card */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <FileCheck className="size-5 text-emerald-600" />
                    Security Details
                  </CardTitle>
                  <CardDescription>
                    Technical details about your SSL certificate
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <div className="text-xs text-muted-foreground">TLS Protocol</div>
                        <div className="flex items-center gap-2">
                          <Lock className="size-4 text-emerald-500" />
                          <span className="text-sm font-medium">{sslData.protocol}</span>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs text-muted-foreground">Key Size</div>
                        <div className="flex items-center gap-2">
                          <Shield className="size-4 text-muted-foreground" />
                          <span className="text-sm font-medium">{sslData.keySize}-bit RSA</span>
                        </div>
                      </div>
                    </div>

                    <Separator />

                    {/* Fingerprint */}
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground">SHA-256 Fingerprint</div>
                      <div className="text-xs font-mono text-muted-foreground break-all bg-muted/50 rounded-lg p-3">
                        {sslData.fingerprint}
                      </div>
                    </div>

                    <Separator />

                    {/* Subject Alternative Names */}
                    <div className="space-y-2">
                      <div className="text-xs text-muted-foreground">Subject Alternative Names (SANs)</div>
                      <div className="flex flex-wrap gap-2">
                        {sslData.sans.map((san, i) => (
                          <Badge key={i} variant="outline" className="font-mono text-xs">
                            <Globe className="size-3 mr-1" />
                            {san}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </>
          ) : (
            <Card>
              <CardContent className="py-8">
                <div className="text-center text-muted-foreground">
                  <Lock className="size-8 mx-auto mb-2 opacity-40" />
                  <p className="text-sm">No SSL certificate found</p>
                  <Button
                    variant="outline"
                    onClick={() => setShowUploadCert(true)}
                    className="mt-4 border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-400 dark:hover:bg-emerald-900/20"
                  >
                    <Upload className="size-4 mr-2" />
                    Upload Custom Certificate
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ─── Settings Tab ────────────────────────────────────── */}
        <TabsContent value="settings" className="space-y-6 mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Domain Settings</CardTitle>
              <CardDescription>
                Configure domain settings for {domain.name}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">Domain Name</div>
                    <div className="text-sm font-mono font-medium">{domain.name}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">Status</div>
                    <Badge variant="outline" className={domainStatusColor(domain.status)}>
                      {domain.status}
                    </Badge>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">Registrar</div>
                    <div className="text-sm font-medium">{domain.registrar || '-'}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">Created</div>
                    <div className="text-sm font-medium">{formatDate(domain.createdAt)}</div>
                  </div>
                </div>

                <Separator />

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium">Auto Renew</div>
                      <div className="text-xs text-muted-foreground">Automatically renew domain before expiry</div>
                    </div>
                    <Badge variant="outline" className={domain.autoRenew ? 'text-emerald-600' : 'text-muted-foreground'}>
                      {domain.autoRenew ? 'Enabled' : 'Disabled'}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium">WHOIS Privacy</div>
                      <div className="text-xs text-muted-foreground">Hide your contact information from WHOIS lookups</div>
                    </div>
                    <Badge variant="outline" className={domain.whoisPrivacy ? 'text-emerald-600' : 'text-muted-foreground'}>
                      {domain.whoisPrivacy ? 'Enabled' : 'Disabled'}
                    </Badge>
                  </div>
                </div>

                <Separator />

                <div className="space-y-2">
                  <div className="text-sm font-medium">Nameservers</div>
                  {domain.nameservers.length > 0 ? (
                    <div className="space-y-1">
                      {domain.nameservers.map((ns, i) => (
                        <div key={i} className="flex items-center gap-2 text-sm font-mono text-muted-foreground">
                          <Server className="size-3" />
                          {ns}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">Using default nameservers</div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Linked Project Settings */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Linked Project</CardTitle>
              <CardDescription>Project associated with this domain</CardDescription>
            </CardHeader>
            <CardContent>
              {domain.project ? (
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{domain.project.name}</div>
                    <div className="text-sm text-muted-foreground font-mono">{domain.project.subdomain}.deployhub.io</div>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => setShowLinkProject(true)}
                    size="sm"
                  >
                    Change Project
                  </Button>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div className="text-sm text-muted-foreground">No project linked</div>
                  <Button
                    onClick={() => setShowLinkProject(true)}
                    size="sm"
                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    <Link2 className="size-4 mr-2" />
                    Link Project
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

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

      {/* Upload Custom Certificate Dialog */}
      <Dialog open={showUploadCert} onOpenChange={(v) => !v && setShowUploadCert(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="size-5" />
              Upload Custom Certificate
            </DialogTitle>
            <DialogDescription>
              Upload your own SSL/TLS certificate and private key for {domain?.name}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="cert-pem">Certificate (PEM)</Label>
              <Textarea
                id="cert-pem"
                placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                value={certPem}
                onChange={(e) => setCertPem(e.target.value)}
                className="font-mono text-xs min-h-[120px]"
              />
              <p className="text-xs text-muted-foreground">
                Paste your full certificate chain in PEM format
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cert-key">Private Key (PEM)</Label>
              <Textarea
                id="cert-key"
                placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                value={certKey}
                onChange={(e) => setCertKey(e.target.value)}
                className="font-mono text-xs min-h-[120px]"
              />
              <p className="text-xs text-muted-foreground">
                Paste your private key in PEM format. This will be stored securely.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowUploadCert(false)} disabled={uploadingCert}>
              Cancel
            </Button>
            <Button
              onClick={handleUploadCert}
              disabled={uploadingCert || !certPem.trim() || !certKey.trim()}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {uploadingCert ? (
                <Loader2 className="size-4 mr-2 animate-spin" />
              ) : (
                <Upload className="size-4 mr-2" />
              )}
              {uploadingCert ? 'Uploading...' : 'Upload Certificate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

  // Custom-domain flow state
  const [showCustomDomain, setShowCustomDomain] = useState(false)
  const [customDomainInput, setCustomDomainInput] = useState('')

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

  // Add a custom domain the user already owns. They will need to verify
  // ownership by adding a DNS TXT record.
  const handleAddCustomDomain = async (domainName: string) => {
    setRegistering(true)
    try {
      const res = await fetch('/api/domains/register', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ name: domainName, provider: 'custom' }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to add custom domain')
        return
      }
      toast.success(`Custom domain ${domainName} added - verify via DNS to activate`)
      fetchDomains()
      setActiveTab('my-domains')
      setSearchResult(null)
      setSearchQuery('')
      setShowCustomDomain(false)
      setCustomDomainInput('')
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

              {/* Add custom domain */}
              <div className="mt-4 pt-4 border-t border-dashed">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-sm font-medium">Already own a domain?</div>
                    <div className="text-xs text-muted-foreground">
                      Add a custom domain and verify ownership via a DNS TXT record.
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowCustomDomain(true)}
                    className="border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-400 dark:hover:bg-amber-900/20"
                  >
                    <Plus className="size-4 mr-2" />
                    Add Custom Domain
                  </Button>
                </div>
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
                        <TableHead>Provider</TableHead>
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
                            <Badge variant="outline" className={providerColor(domain.provider)}>
                              {providerLabel(domain.provider)}
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

      {/* Add Custom Domain Dialog */}
      <Dialog open={showCustomDomain} onOpenChange={(v) => !v && setShowCustomDomain(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CloudUpload className="size-5 text-amber-600" />
              Add Custom Domain
            </DialogTitle>
            <DialogDescription>
              Add a domain you already own. You will need to verify ownership by
              adding a DNS TXT record at your registrar.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="custom-domain-input">Domain name</Label>
              <Input
                id="custom-domain-input"
                placeholder="e.g. myapp.com"
                value={customDomainInput}
                onChange={(e) => setCustomDomainInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customDomainInput.trim()) {
                    handleAddCustomDomain(customDomainInput.trim())
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                After adding the domain, you&apos;ll receive a verification code to
                add as a TXT record. The domain will be activated once verified.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCustomDomain(false)} disabled={registering}>
              Cancel
            </Button>
            <Button
              onClick={() => handleAddCustomDomain(customDomainInput.trim())}
              disabled={registering || !customDomainInput.trim()}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {registering ? (
                <Loader2 className="size-4 mr-2 animate-spin" />
              ) : (
                <Plus className="size-4 mr-2" />
              )}
              {registering ? 'Adding...' : 'Add Domain'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
