'use client'

/**
 * ServersPanel — comprehensive admin Server Management UI.
 *
 * Features:
 *  1. Server list (card grid with status / health / resource bars / software
 *     badges / OS info / project count / relative timestamps / action buttons)
 *  2. Add/Edit Server dialog (basic info + SSH connection + AES-256-GCM notice)
 *  3. Test SSH dialog (success/failure + OS/Docker/Caddy info + troubleshooting)
 *  4. Provision dialog (7-step pipeline with running/success/failed indicators)
 *  5. Server Stats dialog (live CPU/mem/disk/load/uptime + Docker container list)
 *  6. Caddyfile dialog (monospace viewer + copy + reload)
 *  7. Delete confirmation (disabled when projectCount > 0)
 *
 * Uses the same `apiFetch` pattern as the rest of the project — bearer token
 * pulled from localStorage and passed as an Authorization header. All API
 * paths are relative (Caddy gateway handles routing).
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
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
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Server as ServerIcon,
  Globe,
  Cpu,
  HardDrive,
  MemoryStick,
  Shield,
  ShieldCheck,
  Terminal,
  RefreshCw,
  Trash2,
  Edit,
  Plus,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Activity,
  Network,
  Lock,
  Key,
  FileCode,
  Play,
  RotateCcw,
  Eye,
  EyeOff,
  Copy,
  Zap,
  MapPin,
  Loader2,
  Clock,
  Container,
} from 'lucide-react'

// ─── Types ──────────────────────────────────────────────────────────────

interface Server {
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
  sshHost: string
  sshPort: number
  sshUser: string
  hasSshKey: boolean
  hasSshPassword: boolean
  sshFingerprint: string | null
  dockerInstalled: boolean
  caddyInstalled: boolean
  firewallConfigured: boolean
  caddyVersion: string | null
  dockerVersion: string | null
  osInfo: string | null
  lastProvisionedAt: string | null
  lastHealthCheckAt: string | null
  healthStatus: string
  deployedPublicKey: string | null
  projectCount: number
  ramUsagePercent: number
  storageUsagePercent: number
  createdAt: string
  updatedAt: string
}

interface ProvisionStepResult {
  step: string
  status: 'success' | 'failed' | 'skipped'
  message: string
  logs: string
  durationMs: number
}

interface ProvisionResult {
  ok: boolean
  steps: ProvisionStepResult[]
  finalStatus: string
  dockerVersion?: string
  caddyVersion?: string
  osInfo?: string
  detectedCpuCores?: number
  detectedRamGB?: number
  detectedStorageGB?: number
  error?: string
}

interface TestResult {
  ok: boolean
  info?: {
    host: string
    port: number
    username: string
    authMethod: string
    osInfo: string
    dockerVersion: string
    caddyVersion: string
  }
  error?: string
}

interface ServerStats {
  serverId: string
  demo: boolean
  timestamp: string
  cpu: {
    cpuCount: number
    busyPercent: number
    userPercent: number
    systemPercent: number
    idlePercent: number
  }
  memory: {
    totalMB: number
    usedMB: number
    freeMB: number
    availableMB: number
    usedPercent: number
  }
  disk: {
    filesystem: string
    size: string
    used: string
    available: string
    usePercent: number
    mountedOn: string
  }
  loadAvg: {
    load1: number
    load5: number
    load15: number
  }
  uptime: {
    uptimeString: string
    users: number
  }
  containers: Array<{ name: string; status: string; ports: string }>
  containerStats?: Array<{
    name: string
    cpuPercent: number
    memUsage: string
    memPercent: number
  }>
  error?: string
}

// ─── API helper ─────────────────────────────────────────────────────────
/** The httpOnly session cookie authenticates same-origin requests. */
function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' }
}

// ─── Helpers ────────────────────────────────────────────────────────────

const PROVIDERS = [
  'netcup',
  'hetzner',
  'digitalocean',
  'vultr',
  'linode',
  'ovh',
  'contabo',
  'aws',
  'gcp',
  'azure',
  'other',
] as const

const PROVISION_STEPS: Array<{
  name: string
  label: string
  icon: React.ElementType
}> = [
  { name: 'connect', label: 'SSH Connect', icon: Network },
  { name: 'system_update', label: 'System Update', icon: RefreshCw },
  { name: 'install_docker', label: 'Install Docker', icon: Container },
  { name: 'install_caddy', label: 'Install Caddy', icon: Globe },
  { name: 'configure_firewall', label: 'Configure Firewall', icon: Shield },
  { name: 'setup_directories', label: 'Setup Directories', icon: HardDrive },
  { name: 'detect_resources', label: 'Detect Resources', icon: Cpu },
]

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'never'
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 0) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString()
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '—'
  try {
    return new Date(dateStr).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return dateStr
  }
}

// ─── Status badges ──────────────────────────────────────────────────────

function ServerStatusBadge({ status }: { status: string }) {
  const map: Record<string, { className: string; dot?: string }> = {
    active: {
      className: 'bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400',
    },
    provisioning: {
      className: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400',
      dot: 'animate-pulse',
    },
    maintenance: {
      className: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400',
    },
    offline: {
      className: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-400',
    },
  }
  const cfg = map[status] || {
    className: 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-800/30 dark:text-gray-400',
  }
  return (
    <Badge variant="outline" className={cfg.className}>
      {cfg.dot && (
        <span className={`size-1.5 rounded-full bg-current mr-1.5 ${cfg.dot}`} />
      )}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  )
}

function HealthDot({ status }: { status: string }) {
  const map: Record<string, string> = {
    healthy: 'bg-indigo-500',
    degraded: 'bg-amber-500',
    down: 'bg-red-500',
    unknown: 'bg-gray-400',
  }
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-block size-2 rounded-full ${map[status] || map.unknown} ${
              status === 'degraded' ? 'animate-pulse' : ''
            }`}
            aria-label={`Health: ${status}`}
          />
        </TooltipTrigger>
        <TooltipContent>
          <span className="capitalize">Health: {status}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function ResourceBar({
  icon: Icon,
  label,
  value,
  sublabel,
  percent,
}: {
  icon: React.ElementType
  label: string
  value: string
  sublabel?: string
  percent: number
}) {
  const color =
    percent >= 85
      ? 'bg-red-500'
      : percent >= 65
        ? 'bg-amber-500'
        : 'bg-indigo-500'
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1 text-muted-foreground">
          <Icon className="size-3" />
          {label}
        </span>
        <span className="font-medium tabular-nums">
          {value}
          {sublabel && (
            <span className="text-muted-foreground ml-1">{sublabel}</span>
          )}
        </span>
      </div>
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`absolute left-0 top-0 h-full rounded-full ${color} transition-all`}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
    </div>
  )
}

function SoftwareBadge({
  installed,
  label,
  version,
  icon: Icon,
}: {
  installed: boolean
  label: string
  version?: string | null
  icon: React.ElementType
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium ${
              installed
                ? 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-900/50 dark:bg-indigo-900/20 dark:text-indigo-400'
                : 'border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-800 dark:bg-gray-800/30 dark:text-gray-400'
            }`}
          >
            <Icon className="size-3" />
            {label}
            {installed && version && (
              <span className="font-mono text-[9px] opacity-70">
                {version.split(' ')[0]}
              </span>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {installed
            ? version
              ? `${label}: ${version}`
              : `${label} installed`
            : `${label} not installed`}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// ─── Main component ─────────────────────────────────────────────────────

export function ServersPanel() {
  const [servers, setServers] = useState<Server[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  // Dialogs
  const [editOpen, setEditOpen] = useState(false)
  const [editingServer, setEditingServer] = useState<Server | null>(null)
  const [testDialog, setTestDialog] = useState<Server | null>(null)
  const [provisionDialog, setProvisionDialog] = useState<Server | null>(null)
  const [statsDialog, setStatsDialog] = useState<Server | null>(null)
  const [caddyDialog, setCaddyDialog] = useState<Server | null>(null)
  const [deleteServer, setDeleteServer] = useState<Server | null>(null)

  const fetchServers = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/servers', { headers: authHeaders() })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to load servers')
        return
      }
      setServers(data.servers || [])
    } catch {
      toast.error('Network error')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchServers()
  }, [fetchServers])

  const handleRefresh = () => {
    setRefreshing(true)
    fetchServers()
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <ServerIcon className="size-5 text-indigo-600" />
            Servers
          </h3>
          <p className="text-sm text-muted-foreground">
            {servers.length} server{servers.length !== 1 ? 's' : ''} ·{' '}
            {servers.reduce((sum, s) => sum + s.projectCount, 0)} projects
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            <RefreshCw
              className={`size-4 mr-1.5 ${refreshing ? 'animate-spin' : ''}`}
            />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setEditingServer(null)
              setEditOpen(true)
            }}
            className="bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            <Plus className="size-4 mr-1.5" />
            Add Server
          </Button>
        </div>
      </div>

      {/* Server list */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-72 rounded-xl" />
          ))}
        </div>
      ) : servers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="size-14 rounded-full bg-indigo-50 dark:bg-indigo-900/20 flex items-center justify-center mb-3">
              <ServerIcon className="size-7 text-indigo-600" />
            </div>
            <p className="text-sm font-medium">No servers configured</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm">
              Add your first VPS to start hosting projects. Each server runs Docker + Caddy
              for zero-config deployments.
            </p>
            <Button
              size="sm"
              onClick={() => {
                setEditingServer(null)
                setEditOpen(true)
              }}
              className="mt-4 bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              <Plus className="size-4 mr-1.5" />
              Add Your First Server
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {servers.map((server) => (
            <ServerCard
              key={server.id}
              server={server}
              onTest={() => setTestDialog(server)}
              onProvision={() => setProvisionDialog(server)}
              onStats={() => setStatsDialog(server)}
              onCaddy={() => setCaddyDialog(server)}
              onEdit={() => {
                setEditingServer(server)
                setEditOpen(true)
              }}
              onDelete={() => setDeleteServer(server)}
            />
          ))}
        </div>
      )}

      {/* Dialogs */}
      <EditServerDialog
        open={editOpen}
        server={editingServer}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false)
          fetchServers()
        }}
      />

      <TestSshDialog server={testDialog} onClose={() => setTestDialog(null)} />

      <ProvisionDialog
        server={provisionDialog}
        onClose={() => setProvisionDialog(null)}
        onCompleted={fetchServers}
      />

      <StatsDialog server={statsDialog} onClose={() => setStatsDialog(null)} />

      <CaddyfileDialog
        server={caddyDialog}
        onClose={() => setCaddyDialog(null)}
      />

      <DeleteServerDialog
        server={deleteServer}
        onClose={() => setDeleteServer(null)}
        onDeleted={() => {
          setDeleteServer(null)
          fetchServers()
        }}
      />
    </div>
  )
}

// ─── Server Card ────────────────────────────────────────────────────────

function ServerCard({
  server,
  onTest,
  onProvision,
  onStats,
  onCaddy,
  onEdit,
  onDelete,
}: {
  server: Server
  onTest: () => void
  onProvision: () => void
  onStats: () => void
  onCaddy: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="size-9 rounded-lg bg-indigo-50 dark:bg-indigo-900/20 flex items-center justify-center shrink-0">
              <ServerIcon className="size-5 text-indigo-600" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base flex items-center gap-1.5 truncate">
                {server.name}
                <HealthDot status={server.healthStatus} />
              </CardTitle>
              <CardDescription className="flex items-center gap-2 text-xs font-mono">
                <span>{server.ip}</span>
              </CardDescription>
            </div>
          </div>
          <ServerStatusBadge status={server.status} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground mt-1">
          <span className="flex items-center gap-1">
            <Network className="size-3" />
            {server.provider}
          </span>
          {server.region && (
            <span className="flex items-center gap-1">
              <MapPin className="size-3" />
              {server.region}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Container className="size-3" />
            {server.projectCount} project{server.projectCount !== 1 ? 's' : ''}
          </span>
        </div>
      </CardHeader>

      <CardContent className="flex-1 space-y-3">
        {/* Resource bars */}
        <div className="space-y-2">
          <ResourceBar
            icon={Cpu}
            label="CPU"
            value={`${server.cpuCores} vCPU`}
            percent={0}
          />
          <ResourceBar
            icon={MemoryStick}
            label="RAM"
            value={`${server.usedRamGB}/${server.ramGB} GB`}
            percent={server.ramUsagePercent}
          />
          <ResourceBar
            icon={HardDrive}
            label="Storage"
            value={`${server.usedStorageGB}/${server.storageGB} GB`}
            percent={server.storageUsagePercent}
          />
        </div>

        {/* Software badges */}
        <div className="flex flex-wrap gap-1.5 pt-1">
          <SoftwareBadge
            installed={server.dockerInstalled}
            label="Docker"
            version={server.dockerVersion}
            icon={Container}
          />
          <SoftwareBadge
            installed={server.caddyInstalled}
            label="Caddy"
            version={server.caddyVersion}
            icon={Globe}
          />
          <SoftwareBadge
            installed={server.firewallConfigured}
            label="Firewall"
            icon={ShieldCheck}
          />
        </div>

        {/* OS info */}
        {server.osInfo && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground truncate">
            <Terminal className="size-3 shrink-0" />
            <span className="truncate font-mono">{server.osInfo}</span>
          </div>
        )}

        {/* Timestamps */}
        <div className="grid grid-cols-2 gap-2 pt-1 border-t text-[10px] text-muted-foreground">
          <div>
            <span className="block opacity-70">Provisioned</span>
            <span className="flex items-center gap-1">
              <Clock className="size-2.5" />
              {timeAgo(server.lastProvisionedAt)}
            </span>
          </div>
          <div>
            <span className="block opacity-70">Health check</span>
            <span className="flex items-center gap-1">
              <Activity className="size-2.5" />
              {timeAgo(server.lastHealthCheckAt)}
            </span>
          </div>
        </div>

        {/* Actions */}
        <Separator />
        <div className="grid grid-cols-3 gap-1.5">
          <TooltipButton
            icon={Zap}
            label="Test SSH"
            onClick={onTest}
            variant="outline"
          />
          <TooltipButton
            icon={Play}
            label="Provision"
            onClick={onProvision}
            variant="outline"
          />
          <TooltipButton
            icon={Activity}
            label="Stats"
            onClick={onStats}
            variant="outline"
          />
          <TooltipButton
            icon={FileCode}
            label="Caddyfile"
            onClick={onCaddy}
            variant="outline"
          />
          <TooltipButton
            icon={Edit}
            label="Edit"
            onClick={onEdit}
            variant="outline"
          />
          <TooltipButton
            icon={Trash2}
            label="Delete"
            onClick={onDelete}
            variant="outline"
            disabled={server.projectCount > 0}
            danger
          />
        </div>
      </CardContent>
    </Card>
  )
}

function TooltipButton({
  icon: Icon,
  label,
  onClick,
  variant = 'outline',
  disabled = false,
  danger = false,
}: {
  icon: React.ElementType
  label: string
  onClick: () => void
  variant?: 'outline' | 'default'
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={variant}
            size="sm"
            onClick={onClick}
            disabled={disabled}
            className={`h-8 px-2 text-xs ${
              danger
                ? 'hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20'
                : ''
            }`}
          >
            <Icon className="size-3.5 mr-1" />
            <span className="hidden sm:inline">{label}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// ─── Add/Edit Server Dialog ─────────────────────────────────────────────

function EditServerDialog({
  open,
  server,
  onClose,
  onSaved,
}: {
  open: boolean
  server: Server | null
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = !!server
  const [saving, setSaving] = useState(false)

  // Form state
  const [name, setName] = useState('')
  const [ip, setIp] = useState('')
  const [provider, setProvider] = useState<string>('hetzner')
  const [region, setRegion] = useState('')
  const [cpuCores, setCpuCores] = useState('2')
  const [ramGB, setRamGB] = useState('4')
  const [storageGB, setStorageGB] = useState('80')
  const [bandwidthGB, setBandwidthGB] = useState('1000')
  const [sshHost, setSshHost] = useState('')
  const [sshPort, setSshPort] = useState('22')
  const [sshUser, setSshUser] = useState('root')
  const [sshPassword, setSshPassword] = useState('')
  const [sshPrivateKey, setSshPrivateKey] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showKey, setShowKey] = useState(false)

  // Sync form whenever dialog opens or target server changes
  useEffect(() => {
    if (open) {
      if (server) {
        setName(server.name)
        setIp(server.ip)
        setProvider(server.provider || 'hetzner')
        setRegion(server.region || '')
        setCpuCores(String(server.cpuCores))
        setRamGB(String(server.ramGB))
        setStorageGB(String(server.storageGB))
        setBandwidthGB(String(server.bandwidthGB))
        setSshHost(server.sshHost || server.ip)
        setSshPort(String(server.sshPort || 22))
        setSshUser(server.sshUser || 'root')
      } else {
        // Reset for "create"
        setName('')
        setIp('')
        setProvider('hetzner')
        setRegion('')
        setCpuCores('2')
        setRamGB('4')
        setStorageGB('80')
        setBandwidthGB('1000')
        setSshHost('')
        setSshPort('22')
        setSshUser('root')
      }
      setSshPassword('')
      setSshPrivateKey('')
      setShowPassword(false)
      setShowKey(false)
    }
  }, [open, server])

  // Auto-default sshHost to ip when creating
  useEffect(() => {
    if (!isEdit && !sshHost && ip) {
      setSshHost(ip)
    }
  }, [ip, sshHost, isEdit])

  const handleSave = async () => {
    // Validation per spec: name + ip + cpuCores + ramGB + storageGB required
    if (!name.trim()) return toast.error('Server name is required')
    if (!ip.trim()) return toast.error('IP address is required')
    const cpu = parseInt(cpuCores, 10)
    const ram = parseFloat(ramGB)
    const storage = parseFloat(storageGB)
    if (!Number.isFinite(cpu) || cpu <= 0) return toast.error('CPU cores must be a positive number')
    if (!Number.isFinite(ram) || ram <= 0) return toast.error('RAM (GB) must be a positive number')
    if (!Number.isFinite(storage) || storage <= 0) return toast.error('Storage (GB) must be a positive number')

    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        ip: ip.trim(),
        provider,
        region: region.trim() || 'unknown',
        cpuCores: cpu,
        ramGB: ram,
        storageGB: storage,
        bandwidthGB: parseFloat(bandwidthGB) || 1000,
        sshHost: sshHost.trim() || ip.trim(),
        sshPort: parseInt(sshPort, 10) || 22,
        sshUser: sshUser.trim() || 'root',
      }
      if (sshPassword) body.sshPassword = sshPassword
      if (sshPrivateKey) body.sshPrivateKey = sshPrivateKey

      const url = isEdit
        ? `/api/admin/servers/${server!.id}`
        : '/api/admin/servers'
      const method = isEdit ? 'PATCH' : 'POST'

      const res = await fetch(url, {
        method,
        headers: authHeaders(),
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || `Failed to ${isEdit ? 'update' : 'create'} server`)
        return
      }
      toast.success(isEdit ? 'Server updated' : 'Server created successfully')
      onSaved()
    } catch {
      toast.error('Network error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ServerIcon className="size-5 text-indigo-600" />
            {isEdit ? 'Edit Server' : 'Add New Server'}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? `Update configuration for ${server?.name}`
              : 'Register a new VPS to host projects. SSH credentials are encrypted at rest.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-2">
          {/* Basic Info */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Globe className="size-4 text-indigo-600" />
              Basic Information
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="srv-name">Name *</Label>
                <Input
                  id="srv-name"
                  placeholder="prod-web-01"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="srv-ip">IP Address *</Label>
                <Input
                  id="srv-ip"
                  placeholder="203.0.113.10"
                  value={ip}
                  onChange={(e) => setIp(e.target.value)}
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="srv-provider">Provider</Label>
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger id="srv-provider">
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map((p) => (
                      <SelectItem key={p} value={p} className="capitalize">
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="srv-region">Region</Label>
                <Input
                  id="srv-region"
                  placeholder="fra1 / nyc3 / eu-central"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="srv-cpu">CPU Cores *</Label>
                <Input
                  id="srv-cpu"
                  type="number"
                  min="1"
                  placeholder="2"
                  value={cpuCores}
                  onChange={(e) => setCpuCores(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="srv-ram">RAM (GB) *</Label>
                <Input
                  id="srv-ram"
                  type="number"
                  min="0.5"
                  step="0.5"
                  placeholder="4"
                  value={ramGB}
                  onChange={(e) => setRamGB(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="srv-storage">Storage (GB) *</Label>
                <Input
                  id="srv-storage"
                  type="number"
                  min="1"
                  placeholder="80"
                  value={storageGB}
                  onChange={(e) => setStorageGB(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="srv-bw">Bandwidth (GB/mo)</Label>
                <Input
                  id="srv-bw"
                  type="number"
                  min="0"
                  placeholder="1000"
                  value={bandwidthGB}
                  onChange={(e) => setBandwidthGB(e.target.value)}
                />
              </div>
            </div>
          </div>

          <Separator />

          {/* SSH Connection */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Key className="size-4 text-indigo-600" />
              SSH Connection
            </div>

            {isEdit && (server?.hasSshKey || server?.hasSshPassword) && (
              <div className="flex items-start gap-2 rounded-md border border-indigo-200 bg-indigo-50 dark:border-indigo-900/50 dark:bg-indigo-900/10 px-3 py-2 text-xs">
                <Lock className="size-3.5 text-indigo-600 mt-0.5 shrink-0" />
                <p className="text-indigo-700 dark:text-indigo-400">
                  This server already has{' '}
                  {server.hasSshKey && server.hasSshPassword
                    ? 'an SSH key + password'
                    : server.hasSshKey
                      ? 'an SSH key'
                      : 'an SSH password'}{' '}
                  on file. Leave the fields below blank to keep the existing
                  credentials, or enter new values to replace them.
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="srv-ssh-host">SSH Host</Label>
                <Input
                  id="srv-ssh-host"
                  placeholder="defaults to IP"
                  value={sshHost}
                  onChange={(e) => setSshHost(e.target.value)}
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="srv-ssh-port">SSH Port</Label>
                <Input
                  id="srv-ssh-port"
                  type="number"
                  min="1"
                  max="65535"
                  placeholder="22"
                  value={sshPort}
                  onChange={(e) => setSshPort(e.target.value)}
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="srv-ssh-user">SSH User</Label>
                <Input
                  id="srv-ssh-user"
                  placeholder="root"
                  value={sshUser}
                  onChange={(e) => setSshUser(e.target.value)}
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="srv-ssh-pass">SSH Password</Label>
                <div className="relative">
                  <Input
                    id="srv-ssh-pass"
                    type={showPassword ? 'text' : 'password'}
                    placeholder={
                      isEdit && server?.hasSshPassword
                        ? '•••••••• (leave blank to keep current)'
                        : 'Enter password'
                    }
                    value={sshPassword}
                    onChange={(e) => setSshPassword(e.target.value)}
                    className="font-mono text-sm pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="srv-ssh-key">SSH Private Key (PEM)</Label>
                <div className="relative">
                  <Textarea
                    id="srv-ssh-key"
                    placeholder={
                      isEdit && server?.hasSshKey
                        ? '-----BEGIN OPENSSH PRIVATE KEY-----\n••• (leave blank to keep current)\n-----END OPENSSH PRIVATE KEY-----'
                        : '-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----'
                    }
                    value={sshPrivateKey}
                    onChange={(e) => setSshPrivateKey(e.target.value)}
                    className="font-mono text-xs min-h-[120px] max-h-[200px] pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
                    aria-label={showKey ? 'Hide key' : 'Show key'}
                  >
                    {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Paste the full PEM contents including the BEGIN/END markers.
                </p>
              </div>
            </div>
          </div>

          {/* Encryption notice */}
          <div className="flex items-start gap-2 rounded-md border border-indigo-200 bg-indigo-50 dark:border-indigo-900/50 dark:bg-indigo-900/10 px-3 py-2.5 text-xs">
            <Lock className="size-4 text-indigo-600 mt-0.5 shrink-0" />
            <p className="text-indigo-700 dark:text-indigo-400">
              <span className="font-medium">
                SSH credentials are encrypted at rest with AES-256-GCM
              </span>{' '}
              and never displayed again after saving. Only boolean presence
              flags are returned by the API.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 mr-2 animate-spin" />
                {isEdit ? 'Saving...' : 'Creating...'}
              </>
            ) : (
              <>
                <CheckCircle2 className="size-4 mr-2" />
                {isEdit ? 'Save Changes' : 'Create Server'}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Test SSH Dialog ────────────────────────────────────────────────────

function TestSshDialog({
  server,
  onClose,
}: {
  server: Server | null
  onClose: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)

  const runTest = useCallback(async () => {
    if (!server) return
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch(`/api/admin/servers/${server.id}/test`, {
        method: 'POST',
        headers: authHeaders(),
      })
      const data = await res.json()
      setResult(data)
    } catch {
      setResult({ ok: false, error: 'Network error' })
    } finally {
      setLoading(false)
    }
  }, [server])

  useEffect(() => {
    if (server) {
      setResult(null)
      runTest()
    }
  }, [server, runTest])

  return (
    <Dialog open={!!server} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="size-5 text-indigo-600" />
            Test SSH Connection
          </DialogTitle>
          <DialogDescription>
            {server && (
              <>
                Connecting to <span className="font-mono">{server.name}</span>{' '}
                ({server.sshHost}:{server.sshPort})
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          {loading && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Loader2 className="size-8 text-indigo-600 animate-spin mb-3" />
              <p className="text-sm text-muted-foreground">
                Testing SSH connection...
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                This can take up to 20 seconds.
              </p>
            </div>
          )}

          {!loading && result && (
            <div className="space-y-4">
              {/* Success / Failure banner */}
              <div
                className={`flex items-start gap-3 rounded-lg border p-4 ${
                  result.ok
                    ? 'border-indigo-200 bg-indigo-50 dark:border-indigo-900/50 dark:bg-indigo-900/10'
                    : 'border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-900/10'
                }`}
              >
                {result.ok ? (
                  <CheckCircle2 className="size-6 text-indigo-600 shrink-0" />
                ) : (
                  <XCircle className="size-6 text-red-600 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p
                    className={`text-sm font-medium ${
                      result.ok
                        ? 'text-indigo-700 dark:text-indigo-400'
                        : 'text-red-700 dark:text-red-400'
                    }`}
                  >
                    {result.ok ? 'Connection successful' : 'Connection failed'}
                  </p>
                  {result.error && (
                    <p className="text-xs text-red-700 dark:text-red-400 mt-1 break-all">
                      {result.error}
                    </p>
                  )}
                </div>
              </div>

              {/* Success details */}
              {result.ok && result.info && (
                <div className="space-y-2 text-sm">
                  <DetailRow
                    icon={Network}
                    label="Host"
                    value={`${result.info.host}:${result.info.port}`}
                    mono
                  />
                  <DetailRow
                    icon={Key}
                    label="User"
                    value={result.info.username}
                    mono
                  />
                  <DetailRow
                    icon={Lock}
                    label="Auth Method"
                    value={
                      result.info.authMethod === 'private-key'
                        ? 'Private Key'
                        : result.info.authMethod === 'password'
                          ? 'Password'
                          : 'SSH Agent'
                    }
                  />
                  <DetailRow
                    icon={Terminal}
                    label="OS"
                    value={result.info.osInfo || 'Unknown'}
                  />
                  <DetailRow
                    icon={Container}
                    label="Docker"
                    value={result.info.dockerVersion || 'Not installed'}
                    mono
                  />
                  <DetailRow
                    icon={Globe}
                    label="Caddy"
                    value={result.info.caddyVersion || 'Not installed'}
                    mono
                  />
                </div>
              )}

              {/* Failure troubleshooting */}
              {!result.ok && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-900/10 p-3 text-xs">
                  <p className="font-medium text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                    <AlertTriangle className="size-3.5" />
                    Troubleshooting tips
                  </p>
                  <ul className="mt-2 space-y-1 text-amber-700 dark:text-amber-400 list-disc list-inside">
                    <li>Verify the IP/host and SSH port are correct.</li>
                    <li>Ensure the SSH service is running on the server.</li>
                    <li>Check that the user has shell access (not sftp-only).</li>
                    <li>If using a key, make sure it has correct permissions (chmod 600).</li>
                    <li>Confirm UFW/firewall allows inbound on port 22.</li>
                  </ul>
                </div>
              )}

              <Button
                variant="outline"
                size="sm"
                onClick={runTest}
                disabled={loading}
                className="w-full"
              >
                <RefreshCw className="size-4 mr-2" />
                Retry Test
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DetailRow({
  icon: Icon,
  label,
  value,
  mono = false,
}: {
  icon: React.ElementType
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-start gap-2 py-1">
      <Icon className="size-3.5 text-muted-foreground mt-0.5 shrink-0" />
      <span className="text-xs text-muted-foreground w-24 shrink-0">{label}</span>
      <span className={`text-xs flex-1 break-all ${mono ? 'font-mono' : ''}`}>
        {value}
      </span>
    </div>
  )
}

// ─── Provision Dialog ───────────────────────────────────────────────────

function ProvisionDialog({
  server,
  onClose,
  onCompleted,
}: {
  server: Server | null
  onClose: () => void
  onCompleted: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ProvisionResult | null>(null)
  const [elapsed, setElapsed] = useState(0)

  // Reset state whenever a new server is selected
  useEffect(() => {
    if (server) {
      setResult(null)
      setLoading(false)
      setElapsed(0)
    }
  }, [server])

  // Tick elapsed timer while provisioning
  useEffect(() => {
    if (!loading) return
    setElapsed(0)
    const start = Date.now()
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [loading])

  const runProvision = useCallback(async () => {
    if (!server) return
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch(`/api/admin/servers/${server.id}/provision`, {
        method: 'POST',
        headers: authHeaders(),
      })
      const data = await res.json()
      setResult(data as ProvisionResult)
      if (data.ok) {
        toast.success('Provisioning complete')
      } else {
        toast.error('Provisioning failed — see dialog for details')
      }
      onCompleted()
    } catch {
      setResult({
        ok: false,
        error: 'Network error during provisioning',
        steps: [],
        finalStatus: 'failed',
      })
      toast.error('Network error during provisioning')
    } finally {
      setLoading(false)
    }
  }, [server, onCompleted])

  // Auto-start provisioning on open
  useEffect(() => {
    if (server && !loading && !result) {
      runProvision()
    }
    // runProvision is intentionally omitted from deps — we only want to fire
    // provisioning when the user opens the dialog (server changes), not on
    // every render where runProvision's identity might shift.
  }, [server])

  // Build the step → status map from the result
  const stepStatusMap = new Map<string, ProvisionStepResult>()
  if (result?.steps) {
    for (const s of result.steps) stepStatusMap.set(s.step, s)
  }

  return (
    <Dialog open={!!server} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play className="size-5 text-indigo-600" />
            Provisioning {server?.name}
          </DialogTitle>
          <DialogDescription>
            Installing Docker, Caddy, and the hosting stack on{' '}
            <span className="font-mono">{server?.ip}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="py-2 space-y-4">
          {/* Indeterminate progress while running */}
          {loading && (
            <div className="space-y-3">
              <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="absolute inset-y-0 left-0 w-1/3 bg-indigo-500 rounded-full animate-[indeterminate_1.5s_ease-in-out_infinite]" />
              </div>
              <style>{`
                @keyframes indeterminate {
                  0% { left: -33%; }
                  100% { left: 100%; }
                }
              `}</style>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Loader2 className="size-3.5 animate-spin text-indigo-600" />
                  Running pipeline...
                </span>
                <span className="font-mono tabular-nums">
                  {Math.floor(elapsed / 60)}m {elapsed % 60}s
                </span>
              </div>
              <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-900/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400 flex items-start gap-2">
                <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                <span>
                  Provisioning can take 5-10 minutes on a fresh VPS. The dialog
                  will update when complete.
                </span>
              </div>
            </div>
          )}

          {/* Step list */}
          <div className="space-y-1">
            {PROVISION_STEPS.map((step, idx) => {
              const result = stepStatusMap.get(step.name)
              const isLast = idx === PROVISION_STEPS.length - 1
              const StepIcon = step.icon

              let status: 'pending' | 'running' | 'success' | 'failed' | 'skipped' = 'pending'
              if (result) status = result.status
              else if (loading) status = 'pending' // not started yet

              let iconWrapClass = 'bg-muted text-muted-foreground'
              if (status === 'success')
                iconWrapClass = 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
              else if (status === 'failed')
                iconWrapClass = 'bg-red-500/10 text-red-600 dark:text-red-400'
              else if (status === 'skipped')
                iconWrapClass = 'bg-muted/60 text-muted-foreground/60'
              else if (loading && idx === (result ? stepStatusMap.size : 0))
                iconWrapClass = 'bg-amber-500/10 text-amber-600 dark:text-amber-400'

              const connectorClass =
                status === 'success'
                  ? 'bg-indigo-500/50'
                  : 'bg-border'

              return (
                <div key={step.name} className="relative">
                  {!isLast && (
                    <div
                      className={`absolute left-[18px] top-9 w-0.5 h-[calc(100%-12px)] ${connectorClass}`}
                    />
                  )}
                  <div className="relative flex items-start gap-3 p-2 rounded-lg">
                    <div
                      className={`size-9 rounded-full flex items-center justify-center shrink-0 ${iconWrapClass}`}
                    >
                      {status === 'success' ? (
                        <CheckCircle2 className="size-4" />
                      ) : status === 'failed' ? (
                        <XCircle className="size-4" />
                      ) : status === 'skipped' ? (
                        <StepIcon className="size-4 opacity-60" />
                      ) : loading &&
                        idx ===
                          (result ? stepStatusMap.size : 0) ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <StepIcon className="size-4 opacity-60" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0 pt-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{step.label}</span>
                        {result && (
                          <Badge
                            variant="outline"
                            className={
                              status === 'success'
                                ? 'text-[10px] bg-indigo-50 text-indigo-700 border-indigo-200'
                                : status === 'failed'
                                  ? 'text-[10px] bg-red-50 text-red-700 border-red-200'
                                  : 'text-[10px] bg-gray-50 text-gray-600 border-gray-200'
                            }
                          >
                            {status}
                          </Badge>
                        )}
                        {result?.durationMs != null && (
                          <span className="text-[10px] text-muted-foreground inline-flex items-center gap-0.5">
                            <Clock className="size-2.5" />
                            {(result.durationMs / 1000).toFixed(1)}s
                          </span>
                        )}
                      </div>
                      {result?.message && (
                        <p className="text-xs text-muted-foreground mt-0.5 break-all">
                          {result.message}
                        </p>
                      )}
                      {!result && loading && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Queued — waiting for previous step.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Final result */}
          {result && !loading && (
            <div
              className={`rounded-lg border p-4 ${
                result.ok
                  ? 'border-indigo-200 bg-indigo-50 dark:border-indigo-900/50 dark:bg-indigo-900/10'
                  : 'border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-900/10'
              }`}
            >
              <div className="flex items-center gap-2 mb-3">
                {result.ok ? (
                  <CheckCircle2 className="size-5 text-indigo-600" />
                ) : (
                  <XCircle className="size-5 text-red-600" />
                )}
                <p
                  className={`text-sm font-medium ${
                    result.ok
                      ? 'text-indigo-700 dark:text-indigo-400'
                      : 'text-red-700 dark:text-red-400'
                  }`}
                >
                  {result.ok
                    ? `Provisioning completed — server status: ${result.finalStatus}`
                    : `Provisioning failed — server status: ${result.finalStatus}`}
                </p>
              </div>
              {result.ok && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  {result.osInfo && (
                    <div>
                      <span className="text-muted-foreground">OS: </span>
                      <span className="font-mono">{result.osInfo}</span>
                    </div>
                  )}
                  {result.dockerVersion && (
                    <div>
                      <span className="text-muted-foreground">Docker: </span>
                      <span className="font-mono">{result.dockerVersion}</span>
                    </div>
                  )}
                  {result.caddyVersion && (
                    <div>
                      <span className="text-muted-foreground">Caddy: </span>
                      <span className="font-mono">{result.caddyVersion}</span>
                    </div>
                  )}
                  {result.detectedCpuCores != null && (
                    <div>
                      <span className="text-muted-foreground">Detected CPU: </span>
                      <span className="font-mono">{result.detectedCpuCores} cores</span>
                    </div>
                  )}
                  {result.detectedRamGB != null && (
                    <div>
                      <span className="text-muted-foreground">Detected RAM: </span>
                      <span className="font-mono">{result.detectedRamGB} GB</span>
                    </div>
                  )}
                  {result.detectedStorageGB != null && (
                    <div>
                      <span className="text-muted-foreground">Detected Disk: </span>
                      <span className="font-mono">{result.detectedStorageGB} GB</span>
                    </div>
                  )}
                </div>
              )}
              {!result.ok && result.error && (
                <p className="text-xs text-red-700 dark:text-red-400 mt-2 break-all">
                  {result.error}
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            {loading ? 'Cancel' : 'Close'}
          </Button>
          {!loading && result && !result.ok && (
            <Button
              onClick={runProvision}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              <RotateCcw className="size-4 mr-2" />
              Retry Provisioning
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Stats Dialog (auto-refresh 5s) ─────────────────────────────────────

function StatsDialog({
  server,
  onClose,
}: {
  server: Server | null
  onClose: () => void
}) {
  const [stats, setStats] = useState<ServerStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const mountedRef = useRef(true)

  const fetchStats = useCallback(async () => {
    if (!server) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/servers/${server.id}/stats`, {
        headers: authHeaders(),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Failed to fetch stats')
      } else {
        setStats(data)
      }
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }, [server])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Initial fetch
  useEffect(() => {
    if (server) {
      setStats(null)
      fetchStats()
    }
  }, [server, fetchStats])

  // Auto-refresh every 5s
  useEffect(() => {
    if (!server || !autoRefresh) return
    const interval = setInterval(() => {
      if (mountedRef.current) fetchStats()
    }, 5000)
    return () => clearInterval(interval)
  }, [server, autoRefresh, fetchStats])

  return (
    <Dialog open={!!server} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="size-5 text-indigo-600" />
            Live Stats — {server?.name}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2 flex-wrap">
            <span className="font-mono">{server?.ip}</span>
            {stats?.demo && (
              <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200">
                Simulated (demo mode)
              </Badge>
            )}
            {stats?.timestamp && (
              <span className="text-[10px] text-muted-foreground">
                Updated {new Date(stats.timestamp).toLocaleTimeString()}
              </span>
            )}
            <label className="ml-auto flex items-center gap-1.5 text-xs cursor-pointer">
              <Switch
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
                className="scale-75"
              />
              Auto-refresh (5s)
            </label>
          </DialogDescription>
        </DialogHeader>

        <div className="py-2 space-y-4">
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-900/10 p-3 text-xs text-red-700 dark:text-red-400 flex items-start gap-2">
              <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {loading && !stats && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-6 text-indigo-600 animate-spin" />
            </div>
          )}

          {stats && (
            <>
              {/* CPU / Memory / Disk */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <MetricCard
                  icon={Cpu}
                  label="CPU Usage"
                  value={`${stats.cpu.busyPercent.toFixed(1)}%`}
                  percent={stats.cpu.busyPercent}
                  sublabel={`${stats.cpu.cpuCount} cores · ${stats.cpu.userPercent}% user / ${stats.cpu.systemPercent}% sys`}
                />
                <MetricCard
                  icon={MemoryStick}
                  label="Memory"
                  value={`${(stats.memory.usedMB / 1024).toFixed(2)} / ${(stats.memory.totalMB / 1024).toFixed(2)} GB`}
                  percent={stats.memory.usedPercent}
                  sublabel={`${stats.memory.usedPercent}% used`}
                />
                <MetricCard
                  icon={HardDrive}
                  label="Disk (/)"
                  value={`${stats.disk.used} / ${stats.disk.size}`}
                  percent={stats.disk.usePercent}
                  sublabel={`${stats.disk.usePercent}% used · ${stats.disk.available} avail`}
                />
              </div>

              {/* Load Avg + Uptime */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription className="flex items-center gap-1.5">
                      <Activity className="size-3.5" />
                      Load Average
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div>
                        <div className="text-lg font-bold tabular-nums">
                          {stats.loadAvg.load1.toFixed(2)}
                        </div>
                        <div className="text-[10px] text-muted-foreground">1 min</div>
                      </div>
                      <div>
                        <div className="text-lg font-bold tabular-nums">
                          {stats.loadAvg.load5.toFixed(2)}
                        </div>
                        <div className="text-[10px] text-muted-foreground">5 min</div>
                      </div>
                      <div>
                        <div className="text-lg font-bold tabular-nums">
                          {stats.loadAvg.load15.toFixed(2)}
                        </div>
                        <div className="text-[10px] text-muted-foreground">15 min</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription className="flex items-center gap-1.5">
                      <Clock className="size-3.5" />
                      Uptime
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="text-lg font-bold">{stats.uptime.uptimeString}</div>
                    <div className="text-[10px] text-muted-foreground mt-1">
                      {stats.uptime.users} user{stats.uptime.users !== 1 ? 's' : ''} logged in
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Docker Containers */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Container className="size-4 text-indigo-600" />
                    Docker Containers
                    <Badge variant="secondary" className="text-[10px] h-5">
                      {stats.containers.length}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  {stats.containers.length === 0 ? (
                    <div className="text-center py-6 text-sm text-muted-foreground">
                      <Container className="size-8 mx-auto mb-2 opacity-30" />
                      No running containers
                    </div>
                  ) : (
                    <div className="max-h-64 overflow-y-auto rounded-md border [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
                      <table className="w-full text-xs">
                        <thead className="bg-muted/50 sticky top-0">
                          <tr>
                            <th className="text-left p-2 font-medium">Name</th>
                            <th className="text-left p-2 font-medium">Status</th>
                            <th className="text-left p-2 font-medium">Ports</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.containers.map((c) => {
                            const cs = stats.containerStats?.find(
                              (s) => s.name === c.name
                            )
                            return (
                              <tr key={c.name} className="border-t">
                                <td className="p-2 font-mono">{c.name}</td>
                                <td className="p-2">
                                  <span
                                    className={`inline-flex items-center gap-1 ${
                                      c.status.toLowerCase().startsWith('up')
                                        ? 'text-indigo-600'
                                        : 'text-gray-500'
                                    }`}
                                  >
                                    <span
                                      className={`size-1.5 rounded-full ${
                                        c.status.toLowerCase().startsWith('up')
                                          ? 'bg-indigo-500'
                                          : 'bg-gray-400'
                                      }`}
                                    />
                                    {c.status}
                                  </span>
                                  {cs && (
                                    <span className="block text-[10px] text-muted-foreground mt-0.5">
                                      {cs.cpuPercent.toFixed(2)}% CPU · {cs.memUsage}
                                    </span>
                                  )}
                                </td>
                                <td className="p-2 font-mono text-[10px] break-all max-w-[200px]">
                                  {c.ports || '—'}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={fetchStats} disabled={loading}>
            <RefreshCw className={`size-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh Now
          </Button>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MetricCard({
  icon: Icon,
  label,
  value,
  percent,
  sublabel,
}: {
  icon: React.ElementType
  label: string
  value: string
  percent: number
  sublabel?: string
}) {
  const color =
    percent >= 85 ? 'text-red-600' : percent >= 65 ? 'text-amber-600' : 'text-indigo-600'
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-1.5">
          <Icon className="size-3.5" />
          {label}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        <div className={`text-lg font-bold ${color} tabular-nums`}>{value}</div>
        <Progress
          value={Math.min(100, Math.max(0, percent))}
          className="h-1.5"
        />
        {sublabel && (
          <p className="text-[10px] text-muted-foreground">{sublabel}</p>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Caddyfile Dialog ───────────────────────────────────────────────────

function CaddyfileDialog({
  server,
  onClose,
}: {
  server: Server | null
  onClose: () => void
}) {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [copied, setCopied] = useState(false)

  const fetchCaddyfile = useCallback(async () => {
    if (!server) return
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/servers/${server.id}/caddyfile`, {
        headers: authHeaders(),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to load Caddyfile')
        setContent('# Failed to load Caddyfile')
      } else {
        setContent(data.caddyfile || '# Caddyfile is empty')
      }
    } catch {
      toast.error('Network error')
      setContent('# Network error')
    } finally {
      setLoading(false)
    }
  }, [server])

  useEffect(() => {
    if (server) fetchCaddyfile()
  }, [server, fetchCaddyfile])

  const handleReload = async () => {
    if (!server) return
    setReloading(true)
    try {
      const res = await fetch(`/api/admin/servers/${server.id}/caddyfile`, {
        method: 'POST',
        headers: authHeaders(),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Caddy reload failed')
      } else {
        toast.success(data.message || 'Caddy reloaded')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setReloading(false)
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      toast.success('Caddyfile copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Copy failed')
    }
  }

  return (
    <Dialog open={!!server} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileCode className="size-5 text-indigo-600" />
            Caddyfile — {server?.name}
          </DialogTitle>
          <DialogDescription className="font-mono">
            /etc/caddy/Caddyfile
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-6 text-indigo-600 animate-spin" />
            </div>
          ) : (
            <div className="relative rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 bg-zinc-900 border-b border-zinc-800">
                <div className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-red-500/80" />
                  <span className="size-2.5 rounded-full bg-amber-500/80" />
                  <span className="size-2.5 rounded-full bg-indigo-500/80" />
                  <span className="ml-2 text-[10px] text-zinc-500 font-mono">
                    Caddyfile
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleCopy}
                  className="h-7 text-[10px] text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
                >
                  {copied ? (
                    <>
                      <CheckCircle2 className="size-3 mr-1 text-indigo-500" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="size-3 mr-1" />
                      Copy
                    </>
                  )}
                </Button>
              </div>
              <pre className="p-4 text-xs font-mono text-zinc-200 overflow-x-auto max-h-[60vh] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700">
                <code>{content}</code>
              </pre>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={fetchCaddyfile}
            disabled={loading}
          >
            <RefreshCw className={`size-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            Reload Content
          </Button>
          <Button
            onClick={handleReload}
            disabled={reloading || loading}
            className="bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            {reloading ? (
              <>
                <Loader2 className="size-4 mr-2 animate-spin" />
                Reloading Caddy...
              </>
            ) : (
              <>
                <RotateCcw className="size-4 mr-2" />
                Reload Caddy
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Delete Server Dialog ───────────────────────────────────────────────

function DeleteServerDialog({
  server,
  onClose,
  onDeleted,
}: {
  server: Server | null
  onClose: () => void
  onDeleted: () => void
}) {
  const [deleting, setDeleting] = useState(false)

  const handleDelete = async () => {
    if (!server) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/admin/servers/${server.id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to delete server')
        return
      }
      toast.success('Server deleted')
      onDeleted()
    } catch {
      toast.error('Network error')
    } finally {
      setDeleting(false)
    }
  }

  // Block deletion if server has projects attached (mirrors API 409)
  const hasProjects = (server?.projectCount ?? 0) > 0

  return (
    <AlertDialog
      open={!!server}
      onOpenChange={(v) => !v && !deleting && onClose()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-red-500" />
            Delete Server
          </AlertDialogTitle>
          <AlertDialogDescription>
            {hasProjects ? (
              <>
                This server currently hosts{' '}
                <strong className="text-red-700 dark:text-red-400">
                  {server?.projectCount} project
                  {(server?.projectCount ?? 0) !== 1 ? 's' : ''}
                </strong>
                . You must migrate or delete those projects before this server
                can be removed. This prevents accidental service outages.
              </>
            ) : (
              <>
                This will permanently delete the server{' '}
                <strong>{server?.name}</strong> ({server?.ip}). Any projects
                hosted on it must be migrated first. This action cannot be
                undone.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={deleting || hasProjects}
            className="bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {deleting ? (
              <>
                <Loader2 className="size-4 mr-2 animate-spin" />
                Deleting...
              </>
            ) : hasProjects ? (
              'Cannot Delete (projects attached)'
            ) : (
              <>
                <Trash2 className="size-4 mr-2" />
                Delete Permanently
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
