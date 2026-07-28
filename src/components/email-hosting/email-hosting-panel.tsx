'use client'

/**
 * Email Hosting — the customer-facing dashboard for standalone email.
 *
 * This is email sold on its own, without web hosting, so it is a top-level
 * panel rather than a tab inside a website. It talks only to
 * /api/email-hosting/*, which resolves ownership server-side; the UI never
 * decides which domain or mailbox it may touch.
 *
 * Plan limits are displayed here but enforced by the API — the create button
 * disables at the limit purely as a courtesy, and a customer who calls the
 * endpoint directly still gets refused.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Mail,
  Plus,
  Trash2,
  Loader2,
  RefreshCw,
  HardDrive,
  Users,
  Globe,
  Copy,
  Check,
  KeyRound,
  AtSign,
  Download,
  ExternalLink,
  AlertTriangle,
  ArrowLeft,
  ShieldCheck,
  Sparkles,
  Settings2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// ─── Types (mirror the API) ────────────────────────────────────────────────

interface Limits {
  mailboxLimit: number
  storagePerMailboxGB: number
  totalStorageGB: number
}

interface Usage {
  mailboxes: number
  mailboxLimit: number
  usedBytes: number
  totalStorageBytes: number
  storagePerMailboxGB: number
  atMailboxLimit: boolean
  percentStorage: number
}

interface PlanRef {
  name: string
  slug: string
  price: number
  currency: string
}

interface EmailServiceRow {
  id: string
  domain: string
  status: string
  plan: PlanRef | null
  limits: Limits
  provisioned: boolean
  dkimGenerated: boolean
  createdAt: string
}

interface DnsRecord {
  type: 'MX' | 'TXT' | 'CNAME'
  host: string
  value: string
  priority?: number
  label: string
  required: boolean
  note?: string
}

interface ServiceDetail {
  service: {
    id: string
    domain: string
    status: string
    provisioned: boolean
    dkimGenerated: boolean
    createdAt: string
  }
  plan: (PlanRef & { id: string }) | null
  limits: Limits
  usage: Usage | null
  dns: DnsRecord[]
  webmail: string
}

interface MailboxRow {
  address: string
  name: string
  active: boolean
  quota: number
  usedQuota: number
}

interface EmailPlan {
  id: string
  slug: string
  name: string
  tagline: string | null
  description: string | null
  price: number
  currency: string
  popular: boolean
  badge: string | null
  emailMailboxes: number | null
  emailStoragePerMailboxGB: number | null
  emailTotalStorageGB: number | null
}

interface PayAccount {
  label: string | null
  type: string | null
  accountName: string | null
  accountNumber: string | null
  iban: string | null
  swift: string | null
  phone: string | null
  note: string | null
}

interface CheckoutResult {
  status: string
  method: string
  redirectUrl?: string | null
  paymentDetails?: {
    reference: string | null
    instructions: string | null
    accounts: PayAccount[]
  }
  message?: string
}

interface PayMethod {
  method: string
  displayName: string
}

interface VerificationRecord {
  type: string
  host: string
  name: string
  value: string
}

interface AddonInfo {
  pricing: {
    extraMailbox: { label: string; price: number; unit: string }
    extraStorage: { label: string; price: number; blockGB: number }
  }
  current: { extraMailboxes: number; extraStorageGB: number; monthlyCost: number }
}

interface AutoReplyState {
  enabled: boolean
  subject: string
  message: string
  startDate: string | null
  endDate: string | null
  intervalDays: number
}

interface AppPasswordRow {
  id: number
  name: string
  active: boolean
  createdAt?: string
}

interface MailAliasRow {
  id: number
  address: string
  destinations: string[]
  active: boolean
}

interface AddonOrder {
  amount: number
  addMailboxes: number
  addStorageGB: number
  message?: string
  redirectUrl?: string | null
  status?: string
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function authHeaders(): HeadersInit {
  const t = typeof window !== 'undefined' ? localStorage.getItem('apsamo_token') : ''
  return { Authorization: `Bearer ${t || ''}`, 'Content-Type': 'application/json' }
}

/** Carries the API's structured error body so callers can branch on `code`. */
class ApiError extends Error {
  status: number
  code?: string
  body: Record<string, unknown>
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message)
    this.status = status
    this.body = body
    this.code = typeof body.code === 'string' ? body.code : undefined
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: authHeaders(), cache: 'no-store' })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const body = (data || {}) as Record<string, unknown>
    throw new ApiError(
      (body.error as string) || `Request failed (${res.status})`,
      res.status,
      body
    )
  }
  return data as T
}

function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`
}

function statusBadge(status: string) {
  const map: Record<string, { label: string; className: string }> = {
    active: { label: 'Active', className: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30' },
    suspended: { label: 'Suspended', className: 'bg-amber-500/15 text-amber-600 border-amber-500/30' },
    pending: { label: 'Setting up', className: 'bg-blue-500/15 text-blue-600 border-blue-500/30' },
    cancelled: { label: 'Cancelled', className: 'bg-muted text-muted-foreground' },
  }
  const s = map[status] || map.pending
  return (
    <Badge variant="outline" className={s.className}>
      {s.label}
    </Badge>
  )
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 w-7 p-0 shrink-0"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          toast.error('Could not copy to clipboard')
        }
      }}
      aria-label="Copy value"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  )
}

// ─── Empty state: the plan line-up ─────────────────────────────────────────

function PlanLineup({ onPurchased }: { onPurchased: () => void }) {
  const [plans, setPlans] = useState<EmailPlan[] | null>(null)
  const [methods, setMethods] = useState<PayMethod[]>([])
  const [chosen, setChosen] = useState<EmailPlan | null>(null)
  const [domain, setDomain] = useState('')
  const [method, setMethod] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CheckoutResult | null>(null)
  const [verify, setVerify] = useState<VerificationRecord | null>(null)
  const [verifyNote, setVerifyNote] = useState<string | null>(null)

  useEffect(() => {
    api<{ plans: EmailPlan[] }>('/api/billing/plans?type=email')
      .then((d) => setPlans(d.plans || []))
      .catch(() => setPlans([]))
    api<{ methods: PayMethod[] }>('/api/billing/methods')
      .then((d) => {
        const list = d.methods || []
        setMethods(list)
        if (list[0]) setMethod(list[0].method)
      })
      .catch(() => setMethods([]))
  }, [])

  const buy = async () => {
    if (!chosen) return
    setBusy(true)
    try {
      const res = await api<CheckoutResult>('/api/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({
          planId: chosen.id,
          type: 'email',
          domainName: domain.trim().toLowerCase(),
          method,
        }),
      })
      // A redirect method (card/wallet) hands off to the provider; an offline
      // method returns instructions to pay against instead.
      if (res.status === 'redirect_required' && res.redirectUrl) {
        window.location.href = res.redirectUrl
        return
      }
      setResult(res)
      onPurchased()
    } catch (e) {
      // 428 means "prove you control this domain first" — show the record to
      // publish rather than a bare error the customer can do nothing about.
      if (e instanceof ApiError && e.code === 'DOMAIN_UNVERIFIED') {
        setVerify((e.body.verification as VerificationRecord) || null)
        setVerifyNote(e.message)
        return
      }
      toast.error(e instanceof Error ? e.message : 'Checkout failed')
    } finally {
      setBusy(false)
    }
  }

  const recheck = async () => {
    setBusy(true)
    try {
      const res = await api<{ verified: boolean; reason?: string }>(
        '/api/email-hosting/verify-domain',
        { method: 'POST', body: JSON.stringify({ domain: domain.trim().toLowerCase() }) }
      )
      if (res.verified) {
        setVerify(null)
        setVerifyNote(null)
        toast.success('Domain verified')
        await buy()
      } else {
        setVerifyNote(res.reason || 'Not found yet')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Check failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2 max-w-2xl mx-auto">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-1">
          <Mail className="h-6 w-6 text-primary" />
        </div>
        <h2 className="text-2xl font-semibold tracking-tight">Professional email on your own domain</h2>
        <p className="text-muted-foreground">
          Get <span className="font-medium text-foreground">you@yourdomain.com</span> without buying web
          hosting. Ad-free, with webmail plus IMAP, SMTP and mobile sync.
        </p>
      </div>

      {plans === null ? (
        <div className="grid gap-4 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-64 w-full" />
          ))}
        </div>
      ) : plans.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            Email plans aren&apos;t available right now. Please check back shortly.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {plans.map((p) => (
            <Card
              key={p.id}
              className={`relative flex flex-col ${p.popular ? 'border-primary shadow-lg md:scale-[1.03]' : ''}`}
            >
              {p.popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <Badge className="gap-1 shadow">
                    <Sparkles className="h-3 w-3" />
                    {p.badge || 'Most Popular'}
                  </Badge>
                </div>
              )}
              <CardHeader>
                <CardTitle>{p.name}</CardTitle>
                <CardDescription>{p.tagline || p.description}</CardDescription>
                <div className="pt-2">
                  <span className="text-3xl font-bold">
                    ${p.price.toFixed(2)}
                  </span>
                  <span className="text-muted-foreground text-sm"> /mailbox /month</span>
                </div>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col gap-3">
                <ul className="space-y-2 text-sm flex-1">
                  <li className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-primary shrink-0" />
                    {p.emailMailboxes ?? '—'} mailboxes
                  </li>
                  <li className="flex items-center gap-2">
                    <HardDrive className="h-4 w-4 text-primary shrink-0" />
                    {p.emailStoragePerMailboxGB ?? '—'} GB per mailbox
                  </li>
                  <li className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-primary shrink-0" />
                    Spam filtering, SPF, DKIM &amp; DMARC
                  </li>
                </ul>
                <Button
                  className="w-full"
                  variant={p.popular ? 'default' : 'outline'}
                  onClick={() => {
                    setChosen(p)
                    setResult(null)
                    setDomain('')
                  }}
                >
                  Choose {p.name}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ── Checkout ── */}
      <Dialog
        open={chosen !== null}
        onOpenChange={(o) => {
          if (!o) {
            setChosen(null)
            setResult(null)
          }
        }}
      >
        <DialogContent>
          {result ? (
            <>
              <DialogHeader>
                <DialogTitle>Almost there</DialogTitle>
                <DialogDescription>
                  {result.message ||
                    'Your order has been placed and is awaiting confirmation.'}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                {result.paymentDetails?.reference && (
                  <div className="flex items-center justify-between gap-2 rounded-md border p-3">
                    <div>
                      <p className="text-muted-foreground text-xs">Payment reference</p>
                      <p className="font-mono font-medium">
                        {result.paymentDetails.reference}
                      </p>
                    </div>
                    <CopyButton value={result.paymentDetails.reference} />
                  </div>
                )}
                {result.paymentDetails?.instructions && (
                  <p className="text-muted-foreground">
                    {result.paymentDetails.instructions}
                  </p>
                )}
                {result.paymentDetails?.accounts?.map((a, i) => (
                  <div key={i} className="rounded-md border p-3 space-y-1">
                    <p className="font-medium">{a.label}</p>
                    {a.accountName && (
                      <p className="text-muted-foreground text-xs">{a.accountName}</p>
                    )}
                    {(a.accountNumber || a.phone) && (
                      <div className="flex items-center justify-between gap-2">
                        <code className="text-sm">{a.accountNumber || a.phone}</code>
                        <CopyButton value={(a.accountNumber || a.phone) as string} />
                      </div>
                    )}
                    {a.iban && <p className="text-xs">IBAN: {a.iban}</p>}
                    {a.note && <p className="text-xs text-muted-foreground">{a.note}</p>}
                  </div>
                ))}
                <p className="text-muted-foreground text-xs">
                  Your mailboxes are created automatically as soon as the payment is
                  confirmed — you&apos;ll be notified, and {domain} will appear here.
                </p>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => {
                    setChosen(null)
                    setResult(null)
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : verify ? (
            <>
              <DialogHeader>
                <DialogTitle>Verify you own {domain}</DialogTitle>
                <DialogDescription>
                  Add this TXT record at your DNS provider, then check again. This
                  proves the domain is yours before we start accepting its mail.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <div className="rounded-md border divide-y">
                  <div className="p-3">
                    <p className="text-xs text-muted-foreground">Type</p>
                    <p className="font-mono">{verify.type}</p>
                  </div>
                  <div className="p-3">
                    <p className="text-xs text-muted-foreground">Name / Host</p>
                    <div className="flex items-center justify-between gap-2">
                      <code className="break-all">{verify.name}</code>
                      <CopyButton value={verify.name} />
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Some providers want the full name: {verify.host}
                    </p>
                  </div>
                  <div className="p-3">
                    <p className="text-xs text-muted-foreground">Value</p>
                    <div className="flex items-start justify-between gap-2">
                      <code className="break-all">{verify.value}</code>
                      <CopyButton value={verify.value} />
                    </div>
                  </div>
                </div>
                {verifyNote && (
                  <p className="flex items-start gap-2 text-amber-600">
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                    {verifyNote}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  DNS changes usually appear within a few minutes, but can take up to
                  an hour. Nothing has been charged.
                </p>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setVerify(null)
                    setVerifyNote(null)
                  }}
                  disabled={busy}
                >
                  Back
                </Button>
                <Button onClick={() => void recheck()} disabled={busy}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                  Check again
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{chosen?.name}</DialogTitle>
                <DialogDescription>
                  ${chosen?.price.toFixed(2)} per month — {chosen?.emailMailboxes} mailboxes,{' '}
                  {chosen?.emailStoragePerMailboxGB} GB each.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="eh-domain">Your domain</Label>
                  <Input
                    id="eh-domain"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder="yourcompany.com"
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    The domain you already own and want email on. You&apos;ll get DNS
                    records to publish once it&apos;s set up.
                  </p>
                </div>
                {methods.length > 1 && (
                  <div className="space-y-2">
                    <Label htmlFor="eh-method">Payment method</Label>
                    <select
                      id="eh-method"
                      className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                      value={method}
                      onChange={(e) => setMethod(e.target.value)}
                    >
                      {methods.map((m) => (
                        <option key={m.method} value={m.method}>
                          {m.displayName}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {methods.length === 0 && (
                  <p className="text-sm text-amber-600">
                    No payment method is currently available. Please contact support.
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setChosen(null)} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  onClick={() => void buy()}
                  disabled={busy || domain.trim().length < 3 || methods.length === 0}
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                  Continue
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Service detail ────────────────────────────────────────────────────────

function ServiceDetailView({
  serviceId,
  onBack,
}: {
  serviceId: string
  onBack: () => void
}) {
  const [detail, setDetail] = useState<ServiceDetail | null>(null)
  const [mailboxes, setMailboxes] = useState<MailboxRow[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  const [localPart, setLocalPart] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')

  const [aliases, setAliases] = useState<MailAliasRow[] | null>(null)
  const [aliasOpen, setAliasOpen] = useState(false)
  const [aliasLocal, setAliasLocal] = useState('')
  const [aliasDests, setAliasDests] = useState('')
  const [catchAll, setCatchAll] = useState('')

  const [pwTarget, setPwTarget] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState('')

  const [upgradeOpen, setUpgradeOpen] = useState(false)
  const [upgradePlans, setUpgradePlans] = useState<EmailPlan[]>([])
  const [upgradePlanId, setUpgradePlanId] = useState('')
  const [upgradeResult, setUpgradeResult] = useState<CheckoutResult | null>(null)

  // Per-mailbox settings (auto-reply + app passwords)
  const [settingsFor, setSettingsFor] = useState<string | null>(null)
  const [autoReply, setAutoReply] = useState<AutoReplyState | null>(null)
  const [appPasswords, setAppPasswords] = useState<AppPasswordRow[] | null>(null)
  const [newAppName, setNewAppName] = useState('')
  const [newAppSecret, setNewAppSecret] = useState('')

  const [addonOpen, setAddonOpen] = useState(false)
  const [addonInfo, setAddonInfo] = useState<AddonInfo | null>(null)
  const [addBoxes, setAddBoxes] = useState(0)
  const [addBlocks, setAddBlocks] = useState(0)
  const [addonResult, setAddonResult] = useState<AddonOrder | null>(null)

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      const [d, m] = await Promise.all([
        api<ServiceDetail>(`/api/email-hosting/${serviceId}`),
        api<{ mailboxes: MailboxRow[] }>(`/api/email-hosting/${serviceId}/mailboxes`),
      ])
      setDetail(d)
      setMailboxes(m.mailboxes || [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load this service')
    } finally {
      setRefreshing(false)
    }
  }, [serviceId])

  const loadAliases = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([
        api<{ aliases: MailAliasRow[] }>(`/api/email-hosting/${serviceId}/aliases`),
        api<{ catchAll: { destinations: string[] } | null }>(
          `/api/email-hosting/${serviceId}/catch-all`
        ),
      ])
      setAliases(a.aliases || [])
      setCatchAll(c.catchAll?.destinations?.[0] || '')
    } catch {
      setAliases([])
    }
  }, [serviceId])

  useEffect(() => {
    void loadAliases()
  }, [loadAliases])

  const createAliasRow = async () => {
    setBusy(true)
    try {
      // One address per line or comma-separated — people paste both.
      const destinations = aliasDests
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean)
      await api(`/api/email-hosting/${serviceId}/aliases`, {
        method: 'POST',
        body: JSON.stringify({ localPart: aliasLocal.trim(), destinations }),
      })
      toast.success(`${aliasLocal}@${detail?.service.domain} created`)
      setAliasOpen(false)
      setAliasLocal('')
      setAliasDests('')
      await loadAliases()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the alias')
    } finally {
      setBusy(false)
    }
  }

  const toggleAlias = async (a: MailAliasRow) => {
    setBusy(true)
    try {
      await api(`/api/email-hosting/${serviceId}/aliases`, {
        method: 'PATCH',
        body: JSON.stringify({ id: a.id, active: !a.active }),
      })
      await loadAliases()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update the alias')
    } finally {
      setBusy(false)
    }
  }

  const removeAlias = async (a: MailAliasRow) => {
    setBusy(true)
    try {
      await api(`/api/email-hosting/${serviceId}/aliases`, {
        method: 'DELETE',
        body: JSON.stringify({ id: a.id }),
      })
      toast.success(`${a.address} deleted`)
      await loadAliases()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete the alias')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Download the configuration snapshot. Fetched rather than linked so the
   * Authorization header is sent — a plain <a> would hit the endpoint
   * unauthenticated and get a 401 JSON file.
   */
  const exportConfig = async () => {
    setBusy(true)
    try {
      const res = await fetch(`/api/email-hosting/${serviceId}/export`, {
        headers: authHeaders(),
        cache: 'no-store',
      })
      if (!res.ok) throw new Error('Export failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `apsamo-email-${detail?.service.domain || 'export'}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success('Configuration exported')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  const saveCatchAll = async (destination: string | null) => {
    setBusy(true)
    try {
      await api(`/api/email-hosting/${serviceId}/catch-all`, {
        method: 'PUT',
        body: JSON.stringify({ destination }),
      })
      toast.success(destination ? 'Catch-all saved' : 'Catch-all turned off')
      if (!destination) setCatchAll('')
      await loadAliases()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the catch-all')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!upgradeOpen || upgradePlans.length) return
    api<{ plans: EmailPlan[] }>('/api/billing/plans?type=email')
      .then((d) => setUpgradePlans(d.plans || []))
      .catch(() => setUpgradePlans([]))
  }, [upgradeOpen, upgradePlans.length])

  useEffect(() => {
    if (!addonOpen) return
    api<AddonInfo>(`/api/email-hosting/${serviceId}/addons`)
      .then(setAddonInfo)
      .catch(() => setAddonInfo(null))
  }, [addonOpen, serviceId])

  useEffect(() => {
    if (!settingsFor) return
    const enc = encodeURIComponent(settingsFor)
    setAutoReply(null)
    setAppPasswords(null)
    api<{ autoReply: AutoReplyState }>(
      `/api/email-hosting/${serviceId}/mailboxes/${enc}/autoreply`
    )
      .then((d) => setAutoReply(d.autoReply))
      .catch(() => setAutoReply(null))
    api<{ appPasswords: AppPasswordRow[] }>(
      `/api/email-hosting/${serviceId}/mailboxes/${enc}/app-passwords`
    )
      .then((d) => setAppPasswords(d.appPasswords || []))
      .catch(() => setAppPasswords([]))
  }, [settingsFor, serviceId])

  const saveAutoReply = async () => {
    if (!settingsFor || !autoReply) return
    setBusy(true)
    try {
      const d = await api<{ autoReply: AutoReplyState }>(
        `/api/email-hosting/${serviceId}/mailboxes/${encodeURIComponent(settingsFor)}/autoreply`,
        { method: 'PUT', body: JSON.stringify(autoReply) }
      )
      setAutoReply(d.autoReply)
      toast.success(autoReply.enabled ? 'Auto-reply is on' : 'Auto-reply turned off')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the auto-reply')
    } finally {
      setBusy(false)
    }
  }

  const addAppPassword = async () => {
    if (!settingsFor) return
    setBusy(true)
    try {
      await api(
        `/api/email-hosting/${serviceId}/mailboxes/${encodeURIComponent(settingsFor)}/app-passwords`,
        {
          method: 'POST',
          body: JSON.stringify({ name: newAppName.trim(), password: newAppSecret }),
        }
      )
      toast.success(`"${newAppName.trim()}" created — save the password now, it is not shown again`)
      setNewAppName('')
      setNewAppSecret('')
      const d = await api<{ appPasswords: AppPasswordRow[] }>(
        `/api/email-hosting/${serviceId}/mailboxes/${encodeURIComponent(settingsFor)}/app-passwords`
      )
      setAppPasswords(d.appPasswords || [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the app password')
    } finally {
      setBusy(false)
    }
  }

  const revokeAppPassword = async (id: number) => {
    if (!settingsFor) return
    setBusy(true)
    try {
      await api(
        `/api/email-hosting/${serviceId}/mailboxes/${encodeURIComponent(settingsFor)}/app-passwords`,
        { method: 'DELETE', body: JSON.stringify({ id }) }
      )
      setAppPasswords((prev) => (prev || []).filter((p) => p.id !== id))
      toast.success('App password revoked')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not revoke it')
    } finally {
      setBusy(false)
    }
  }

  const addonPrice = addonInfo
    ? Math.round(
        (addBoxes * addonInfo.pricing.extraMailbox.price +
          addBlocks * addonInfo.pricing.extraStorage.price) *
          100
      ) / 100
    : 0

  const orderAddons = async () => {
    setBusy(true)
    try {
      const res = await api<AddonOrder>(`/api/email-hosting/${serviceId}/addons`, {
        method: 'POST',
        body: JSON.stringify({
          extraMailboxes: addBoxes,
          extraStorageBlocks: addBlocks,
          method: 'manual',
        }),
      })
      if (res.status === 'redirect_required' && res.redirectUrl) {
        window.location.href = res.redirectUrl
        return
      }
      setAddonResult(res)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not order add-ons')
    } finally {
      setBusy(false)
    }
  }

  const usage = detail?.usage
  const atLimit = usage?.atMailboxLimit ?? false

  /**
   * A plan change is a purchase, so it goes through checkout exactly like the
   * first one. Provisioning applies the new allowance to the existing service
   * (and pushes it to the mail server) once the payment is confirmed.
   */
  const changePlan = async () => {
    if (!detail || !upgradePlanId) return
    setBusy(true)
    try {
      const res = await api<CheckoutResult>('/api/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({
          planId: upgradePlanId,
          type: 'email',
          domainName: detail.service.domain,
          method: 'manual',
        }),
      })
      if (res.status === 'redirect_required' && res.redirectUrl) {
        window.location.href = res.redirectUrl
        return
      }
      setUpgradeResult(res)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start the plan change')
    } finally {
      setBusy(false)
    }
  }

  const createMailbox = async () => {
    setBusy(true)
    try {
      await api(`/api/email-hosting/${serviceId}/mailboxes`, {
        method: 'POST',
        body: JSON.stringify({
          localPart: localPart.trim(),
          password,
          name: displayName.trim() || undefined,
        }),
      })
      toast.success(`${localPart}@${detail?.service.domain} created`)
      setCreateOpen(false)
      setLocalPart('')
      setPassword('')
      setDisplayName('')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the mailbox')
    } finally {
      setBusy(false)
    }
  }

  const changePassword = async () => {
    if (!pwTarget) return
    setBusy(true)
    try {
      await api(
        `/api/email-hosting/${serviceId}/mailboxes/${encodeURIComponent(pwTarget)}`,
        { method: 'PATCH', body: JSON.stringify({ password: newPassword }) }
      )
      toast.success(`Password updated for ${pwTarget}`)
      setPwTarget(null)
      setNewPassword('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update the password')
    } finally {
      setBusy(false)
    }
  }

  const removeMailbox = async () => {
    if (!deleteTarget) return
    setBusy(true)
    try {
      await api(
        `/api/email-hosting/${serviceId}/mailboxes/${encodeURIComponent(deleteTarget)}`,
        { method: 'DELETE' }
      )
      toast.success(`${deleteTarget} deleted`)
      setDeleteTarget(null)
      setDeleteConfirm('')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete the mailbox')
    } finally {
      setBusy(false)
    }
  }

  if (!detail) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1">
          <ArrowLeft className="h-4 w-4" />
          All services
        </Button>
        <div className="flex items-center gap-2 min-w-0">
          <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="font-semibold truncate">{detail.service.domain}</span>
          {statusBadge(detail.service.status)}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing}>
            {refreshing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setUpgradeOpen(true)}>
            Change plan
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={() => void exportConfig()}
            disabled={busy}
          >
            <Download className="h-4 w-4" />
            Export
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={detail.webmail} target="_blank" rel="noopener noreferrer" className="gap-1">
              Open webmail
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        </div>
      </div>

      {detail.service.status === 'suspended' && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-start gap-3 py-4">
            <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium">This service is suspended</p>
              <p className="text-muted-foreground">
                Incoming mail is being refused and sign-in is disabled. Settle the outstanding
                invoice in Billing to restore service — nothing has been deleted.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Usage summary */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Users className="h-4 w-4" /> Mailboxes
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">
              {usage?.mailboxes ?? 0}
              <span className="text-base font-normal text-muted-foreground">
                {' '}/ {detail.limits.mailboxLimit}
              </span>
            </div>
            <Progress
              className="mt-2 h-1.5"
              value={
                detail.limits.mailboxLimit
                  ? Math.min(100, ((usage?.mailboxes ?? 0) / detail.limits.mailboxLimit) * 100)
                  : 0
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <HardDrive className="h-4 w-4" /> Storage used
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">
              {formatBytes(usage?.usedBytes)}
              <span className="text-base font-normal text-muted-foreground">
                {' '}/ {detail.limits.totalStorageGB} GB
              </span>
            </div>
            <Progress className="mt-2 h-1.5" value={usage?.percentStorage ?? 0} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Mail className="h-4 w-4" /> Plan
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold truncate">{detail.plan?.name || '—'}</div>
            <p className="text-sm text-muted-foreground">
              {detail.plan ? `$${detail.plan.price.toFixed(2)} / month` : ''}
              {detail.limits.storagePerMailboxGB
                ? ` · ${detail.limits.storagePerMailboxGB} GB per mailbox`
                : ''}
            </p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="mailboxes">
        <TabsList>
          <TabsTrigger value="mailboxes">Mailboxes</TabsTrigger>
          <TabsTrigger value="aliases">Aliases &amp; lists</TabsTrigger>
          <TabsTrigger value="dns">DNS setup</TabsTrigger>
        </TabsList>

        {/* ── Mailboxes ── */}
        <TabsContent value="mailboxes" className="space-y-4 pt-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {atLimit
                ? 'Every mailbox in your plan is in use — buy an extra one or change plan.'
                : `You can create ${detail.limits.mailboxLimit - (usage?.mailboxes ?? 0)} more mailbox(es).`}
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="gap-1"
                disabled={detail.service.status !== 'active'}
                onClick={() => {
                  setAddonOpen(true)
                  setAddonResult(null)
                  setAddBoxes(atLimit ? 1 : 0)
                  setAddBlocks(0)
                }}
              >
                <Plus className="h-4 w-4" />
                Buy add-ons
              </Button>
              <Button
                size="sm"
                className="gap-1"
                disabled={atLimit || detail.service.status !== 'active'}
                onClick={() => setCreateOpen(true)}
              >
                <Plus className="h-4 w-4" />
                New mailbox
              </Button>
            </div>
          </div>

          <Card>
            <CardContent className="p-0">
              {mailboxes === null ? (
                <div className="p-6 space-y-2">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : mailboxes.length === 0 ? (
                <div className="py-12 text-center">
                  <Mail className="h-8 w-8 mx-auto text-muted-foreground/50 mb-3" />
                  <p className="font-medium">No mailboxes yet</p>
                  <p className="text-sm text-muted-foreground">
                    Create your first address, for example info@{detail.service.domain}.
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Address</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Storage</TableHead>
                      <TableHead className="w-[1%]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mailboxes.map((b) => (
                      <TableRow key={b.address}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            {b.address}
                            {!b.active && (
                              <Badge variant="outline" className="text-xs">
                                Disabled
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{b.name || '—'}</TableCell>
                        <TableCell className="text-muted-foreground whitespace-nowrap">
                          {formatBytes(b.usedQuota)} / {formatBytes(b.quota)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 gap-1"
                              onClick={() => setSettingsFor(b.address)}
                            >
                              <Settings2 className="h-3.5 w-3.5" />
                              Settings
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 gap-1"
                              onClick={() => {
                                setPwTarget(b.address)
                                setNewPassword('')
                              }}
                            >
                              <KeyRound className="h-3.5 w-3.5" />
                              Password
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                              onClick={() => {
                                setDeleteTarget(b.address)
                                setDeleteConfirm('')
                              }}
                              aria-label={`Delete ${b.address}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Aliases & distribution lists ── */}
        <TabsContent value="aliases" className="space-y-4 pt-4">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm text-muted-foreground max-w-xl">
              An alias delivers to somewhere else without using up a mailbox. Give it
              one destination to forward, or several to make a distribution list —
              mail to <span className="font-mono text-xs">team@{detail.service.domain}</span>{' '}
              reaching everyone on it.
            </p>
            <Button
              size="sm"
              className="gap-1 shrink-0"
              disabled={detail.service.status !== 'active'}
              onClick={() => {
                setAliasOpen(true)
                setAliasLocal('')
                setAliasDests('')
              }}
            >
              <Plus className="h-4 w-4" />
              New alias
            </Button>
          </div>

          <Card>
            <CardContent className="p-0">
              {aliases === null ? (
                <div className="p-6 space-y-2">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : aliases.length === 0 ? (
                <div className="py-12 text-center">
                  <AtSign className="h-8 w-8 mx-auto text-muted-foreground/50 mb-3" />
                  <p className="font-medium">No aliases yet</p>
                  <p className="text-sm text-muted-foreground">
                    Try sales@{detail.service.domain} forwarding to your own inbox.
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Address</TableHead>
                      <TableHead>Delivers to</TableHead>
                      <TableHead className="w-[1%]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {aliases.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            {a.address}
                            {!a.active && (
                              <Badge variant="outline" className="text-xs">
                                Disabled
                              </Badge>
                            )}
                            {a.destinations.length > 1 && (
                              <Badge variant="secondary" className="text-xs">
                                list · {a.destinations.length}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {a.destinations.join(', ')}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8"
                              disabled={busy}
                              onClick={() => void toggleAlias(a)}
                            >
                              {a.active ? 'Disable' : 'Enable'}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                              disabled={busy}
                              onClick={() => void removeAlias(a)}
                              aria-label={`Delete ${a.address}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Catch-all */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Catch-all</CardTitle>
              <CardDescription>
                Where mail to any address that doesn&apos;t exist should go. Leave it
                off unless you need it — it accepts everything, so spam usually rises
                sharply.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2">
              <Input
                value={catchAll}
                onChange={(e) => setCatchAll(e.target.value)}
                placeholder={`owner@${detail.service.domain}`}
                className="max-w-xs"
              />
              <Button
                size="sm"
                disabled={busy || detail.service.status !== 'active'}
                onClick={() => void saveCatchAll(catchAll.trim() || null)}
              >
                Save
              </Button>
              {catchAll && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void saveCatchAll(null)}
                >
                  Turn off
                </Button>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── DNS ── */}
        <TabsContent value="dns" className="space-y-4 pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Publish these records at your DNS provider</CardTitle>
              <CardDescription>
                Mail can&apos;t be delivered until the MX record points here. SPF, DKIM and DMARC are
                what keep your messages out of recipients&apos; spam folders.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[90px]">Type</TableHead>
                    <TableHead className="w-[190px]">Host</TableHead>
                    <TableHead>Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.dns.map((r, i) => (
                    <TableRow key={`${r.type}-${r.host}-${i}`}>
                      <TableCell>
                        <Badge variant="outline">{r.type}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <div>{r.host}</div>
                        <div className="text-muted-foreground font-sans text-[11px] mt-0.5">
                          {r.label}
                          {r.required ? '' : ' (optional)'}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-start gap-1">
                          <code className="text-xs break-all flex-1 leading-relaxed">
                            {r.priority !== undefined ? `${r.priority} ` : ''}
                            {r.value}
                          </code>
                          <CopyButton
                            value={r.priority !== undefined ? `${r.priority} ${r.value}` : r.value}
                          />
                        </div>
                        {r.note && (
                          <p className="text-[11px] text-amber-600 mt-1 flex items-start gap-1">
                            <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                            {r.note}
                          </p>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Create mailbox dialog ── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New mailbox</DialogTitle>
            <DialogDescription>
              Creates an address on {detail.service.domain} with{' '}
              {detail.limits.storagePerMailboxGB} GB of storage.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="eh-local">Address</Label>
              <div className="flex items-center">
                <Input
                  id="eh-local"
                  value={localPart}
                  onChange={(e) => setLocalPart(e.target.value)}
                  placeholder="info"
                  className="rounded-r-none"
                  autoComplete="off"
                />
                <span className="border border-l-0 rounded-r-md px-3 h-9 flex items-center text-sm text-muted-foreground bg-muted whitespace-nowrap">
                  @{detail.service.domain}
                </span>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="eh-name">Display name (optional)</Label>
              <Input
                id="eh-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Sales Team"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="eh-pw">Password</Label>
              <Input
                id="eh-pw"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={() => void createMailbox()}
              disabled={busy || localPart.trim().length === 0 || password.length < 8}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Create mailbox
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Change password dialog ── */}
      <Dialog open={pwTarget !== null} onOpenChange={(o) => !o && setPwTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>
              Sets a new password for {pwTarget}. Any device signed in with the old one will need
              updating.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="eh-newpw">New password</Label>
            <Input
              id="eh-newpw"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPwTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void changePassword()} disabled={busy || newPassword.length < 8}>
              {busy && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Update password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Mailbox settings: auto-reply + app passwords ── */}
      <Dialog open={settingsFor !== null} onOpenChange={(o) => !o && setSettingsFor(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{settingsFor}</DialogTitle>
            <DialogDescription>
              Auto-reply and the app passwords this mailbox can sign in with.
            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="autoreply">
            <TabsList>
              <TabsTrigger value="autoreply">Auto-reply</TabsTrigger>
              <TabsTrigger value="apps">App passwords</TabsTrigger>
            </TabsList>

            {/* Auto-reply */}
            <TabsContent value="autoreply" className="space-y-4 pt-4">
              {!autoReply ? (
                <Skeleton className="h-56 w-full" />
              ) : (
                <>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div>
                      <p className="font-medium text-sm">Send an automatic reply</p>
                      <p className="text-xs text-muted-foreground">
                        Replies once per sender every {autoReply.intervalDays} day
                        {autoReply.intervalDays === 1 ? '' : 's'}.
                      </p>
                    </div>
                    <Switch
                      checked={autoReply.enabled}
                      onCheckedChange={(v) =>
                        setAutoReply({ ...autoReply, enabled: v })
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="ar-subject">Subject</Label>
                    <Input
                      id="ar-subject"
                      value={autoReply.subject}
                      onChange={(e) =>
                        setAutoReply({ ...autoReply, subject: e.target.value })
                      }
                      placeholder="Out of office"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="ar-message">Message</Label>
                    <Textarea
                      id="ar-message"
                      rows={5}
                      value={autoReply.message}
                      onChange={(e) =>
                        setAutoReply({ ...autoReply, message: e.target.value })
                      }
                      placeholder={`Hi,\n\nI'm away until 10 August and will reply when I'm back.\nFor anything urgent, please contact a colleague.`}
                    />
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-2">
                      <Label htmlFor="ar-start">Start (optional)</Label>
                      <Input
                        id="ar-start"
                        type="date"
                        value={autoReply.startDate || ''}
                        onChange={(e) =>
                          setAutoReply({
                            ...autoReply,
                            startDate: e.target.value || null,
                          })
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="ar-end">End (optional)</Label>
                      <Input
                        id="ar-end"
                        type="date"
                        value={autoReply.endDate || ''}
                        onChange={(e) =>
                          setAutoReply({
                            ...autoReply,
                            endDate: e.target.value || null,
                          })
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="ar-days">Repeat after (days)</Label>
                      <Input
                        id="ar-days"
                        type="number"
                        min={1}
                        max={30}
                        value={autoReply.intervalDays}
                        onChange={(e) =>
                          setAutoReply({
                            ...autoReply,
                            intervalDays: Math.max(1, Number(e.target.value) || 1),
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <Button onClick={() => void saveAutoReply()} disabled={busy}>
                      {busy && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                      Save auto-reply
                    </Button>
                  </div>
                </>
              )}
            </TabsContent>

            {/* App passwords */}
            <TabsContent value="apps" className="space-y-4 pt-4">
              <p className="text-sm text-muted-foreground">
                Give a phone or mail app its own password so you never type the
                account password into it — and can revoke just that device later.
              </p>

              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <div className="space-y-2">
                  <Label htmlFor="ap-name">Name</Label>
                  <Input
                    id="ap-name"
                    value={newAppName}
                    onChange={(e) => setNewAppName(e.target.value)}
                    placeholder="iPhone Mail"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ap-secret">Password</Label>
                  <Input
                    id="ap-secret"
                    value={newAppSecret}
                    onChange={(e) => setNewAppSecret(e.target.value)}
                    placeholder="At least 12 characters"
                  />
                </div>
                <Button
                  onClick={() => void addAppPassword()}
                  disabled={busy || !newAppName.trim() || newAppSecret.length < 12}
                >
                  Create
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Choose something long and random — it is stored hashed and cannot be
                shown to you again.
              </p>

              {appPasswords === null ? (
                <Skeleton className="h-20 w-full" />
              ) : appPasswords.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No app passwords yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-[1%]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {appPasswords.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">{p.name}</TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {p.active ? 'Active' : 'Disabled'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 text-destructive hover:text-destructive"
                            disabled={busy}
                            onClick={() => void revokeAppPassword(p.id)}
                          >
                            Revoke
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* ── New alias dialog ── */}
      <Dialog open={aliasOpen} onOpenChange={setAliasOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New alias</DialogTitle>
            <DialogDescription>
              Mail sent to this address is delivered to the destinations below. It
              does not use up one of your mailboxes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="al-local">Address</Label>
              <div className="flex items-center">
                <Input
                  id="al-local"
                  value={aliasLocal}
                  onChange={(e) => setAliasLocal(e.target.value)}
                  placeholder="sales"
                  className="rounded-r-none"
                  autoComplete="off"
                />
                <span className="border border-l-0 rounded-r-md px-3 h-9 flex items-center text-sm text-muted-foreground bg-muted whitespace-nowrap">
                  @{detail.service.domain}
                </span>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="al-dest">Deliver to</Label>
              <textarea
                id="al-dest"
                value={aliasDests}
                onChange={(e) => setAliasDests(e.target.value)}
                placeholder={`you@${detail.service.domain}\ncolleague@example.com`}
                rows={4}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
              />
              <p className="text-xs text-muted-foreground">
                One address per line. Add several to make it a distribution list.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAliasOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={() => void createAliasRow()}
              disabled={busy || !aliasLocal.trim() || !aliasDests.trim()}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Create alias
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Add-ons dialog ── */}
      <Dialog
        open={addonOpen}
        onOpenChange={(o) => {
          setAddonOpen(o)
          if (!o) setAddonResult(null)
        }}
      >
        <DialogContent>
          {addonResult ? (
            <>
              <DialogHeader>
                <DialogTitle>Add-ons ordered</DialogTitle>
                <DialogDescription>{addonResult.message}</DialogDescription>
              </DialogHeader>
              <div className="rounded-md border p-3 text-sm space-y-1">
                {addonResult.addMailboxes > 0 && (
                  <p>{addonResult.addMailboxes} extra mailbox(es)</p>
                )}
                {addonResult.addStorageGB > 0 && (
                  <p>{addonResult.addStorageGB} GB extra storage</p>
                )}
                <p className="font-medium pt-1">
                  ${addonResult.amount.toFixed(2)} per month
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Pay using the reference on your invoice in Billing. The extra
                allowance is applied automatically once it clears.
              </p>
              <DialogFooter>
                <Button
                  onClick={() => {
                    setAddonOpen(false)
                    setAddonResult(null)
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Buy add-ons</DialogTitle>
                <DialogDescription>
                  Extra capacity on top of your plan, billed monthly alongside it.
                </DialogDescription>
              </DialogHeader>
              {!addonInfo ? (
                <Skeleton className="h-32 w-full" />
              ) : (
                <div className="space-y-4">
                  {(addonInfo.current.extraMailboxes > 0 ||
                    addonInfo.current.extraStorageGB > 0) && (
                    <p className="text-sm text-muted-foreground">
                      You already have {addonInfo.current.extraMailboxes} extra
                      mailbox(es) and {addonInfo.current.extraStorageGB} GB extra
                      storage (${addonInfo.current.monthlyCost.toFixed(2)}/mo).
                    </p>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="ao-boxes">
                      Extra mailboxes — ${addonInfo.pricing.extraMailbox.price.toFixed(2)} each
                      per month
                    </Label>
                    <Input
                      id="ao-boxes"
                      type="number"
                      min={0}
                      value={addBoxes}
                      onChange={(e) => setAddBoxes(Math.max(0, Number(e.target.value) || 0))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ao-storage">
                      Extra storage — ${addonInfo.pricing.extraStorage.price.toFixed(2)} per{' '}
                      {addonInfo.pricing.extraStorage.blockGB} GB per month
                    </Label>
                    <Input
                      id="ao-storage"
                      type="number"
                      min={0}
                      value={addBlocks}
                      onChange={(e) => setAddBlocks(Math.max(0, Number(e.target.value) || 0))}
                    />
                    {addBlocks > 0 && (
                      <p className="text-xs text-muted-foreground">
                        = {addBlocks * addonInfo.pricing.extraStorage.blockGB} GB
                      </p>
                    )}
                  </div>
                  <div className="rounded-md border p-3 flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Added to your bill</span>
                    <span className="font-semibold">${addonPrice.toFixed(2)}/mo</span>
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setAddonOpen(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  onClick={() => void orderAddons()}
                  disabled={busy || addonPrice <= 0}
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                  Order
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Change plan dialog ── */}
      <Dialog
        open={upgradeOpen}
        onOpenChange={(o) => {
          setUpgradeOpen(o)
          if (!o) setUpgradeResult(null)
        }}
      >
        <DialogContent>
          {upgradeResult ? (
            <>
              <DialogHeader>
                <DialogTitle>Plan change ordered</DialogTitle>
                <DialogDescription>
                  {upgradeResult.message ||
                    'Your order is awaiting confirmation.'}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                {upgradeResult.paymentDetails?.reference && (
                  <div className="flex items-center justify-between gap-2 rounded-md border p-3">
                    <div>
                      <p className="text-muted-foreground text-xs">Payment reference</p>
                      <p className="font-mono font-medium">
                        {upgradeResult.paymentDetails.reference}
                      </p>
                    </div>
                    <CopyButton value={upgradeResult.paymentDetails.reference} />
                  </div>
                )}
                {upgradeResult.paymentDetails?.instructions && (
                  <p className="text-muted-foreground">
                    {upgradeResult.paymentDetails.instructions}
                  </p>
                )}
                {upgradeResult.paymentDetails?.accounts?.map((a, i) => (
                  <div key={i} className="rounded-md border p-3 space-y-1">
                    <p className="font-medium">{a.label}</p>
                    {(a.accountNumber || a.phone) && (
                      <div className="flex items-center justify-between gap-2">
                        <code className="text-sm">{a.accountNumber || a.phone}</code>
                        <CopyButton value={(a.accountNumber || a.phone) as string} />
                      </div>
                    )}
                  </div>
                ))}
                <p className="text-muted-foreground text-xs">
                  Your new allowance is applied automatically once the payment is
                  confirmed. Nothing changes until then.
                </p>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => {
                    setUpgradeOpen(false)
                    setUpgradeResult(null)
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Change plan</DialogTitle>
                <DialogDescription>
                  Pick a plan for {detail.service.domain}. Moving to a smaller plan is
                  refused if you have more mailboxes than it allows — delete some
                  first.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                {upgradePlans.length === 0 ? (
                  <Skeleton className="h-24 w-full" />
                ) : (
                  upgradePlans.map((p) => {
                    const current = p.name === detail.plan?.name
                    return (
                      <button
                        key={p.id}
                        type="button"
                        disabled={current}
                        onClick={() => setUpgradePlanId(p.id)}
                        className={`w-full text-left rounded-md border p-3 transition-colors ${
                          upgradePlanId === p.id
                            ? 'border-primary bg-primary/5'
                            : 'hover:border-primary/50'
                        } ${current ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium">
                            {p.name}
                            {current && (
                              <Badge variant="outline" className="ml-2 text-xs">
                                Current
                              </Badge>
                            )}
                          </span>
                          <span className="font-semibold">${p.price.toFixed(2)}/mo</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {p.emailMailboxes} mailboxes · {p.emailStoragePerMailboxGB} GB
                          each
                        </p>
                      </button>
                    )
                  })
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setUpgradeOpen(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button onClick={() => void changePlan()} disabled={busy || !upgradePlanId}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                  Continue
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Delete mailbox dialog ── */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this mailbox?</DialogTitle>
            <DialogDescription>
              Every message stored in {deleteTarget} is permanently removed. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="eh-confirm">
              Type the address to confirm
            </Label>
            <Input
              id="eh-confirm"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder={deleteTarget || ''}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void removeMailbox()}
              disabled={busy || deleteConfirm.trim().toLowerCase() !== (deleteTarget || '').toLowerCase()}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export default function EmailHostingPanel() {
  const [services, setServices] = useState<EmailServiceRow[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await api<{ services: EmailServiceRow[] }>('/api/email-hosting')
      setServices(d.services || [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your email services')
      setServices([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const totals = useMemo(() => {
    const list = services || []
    return {
      count: list.length,
      mailboxes: list.reduce((s, x) => s + (x.limits?.mailboxLimit || 0), 0),
    }
  }, [services])

  if (selected) {
    return <ServiceDetailView serviceId={selected} onBack={() => setSelected(null)} />
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Mail className="h-6 w-6 text-primary" />
            Email Hosting
          </h1>
          <p className="text-muted-foreground text-sm">
            Professional email on your own domain — no website required.
          </p>
        </div>
        {services && services.length > 0 && (
          <div className="text-sm text-muted-foreground">
            {totals.count} domain{totals.count === 1 ? '' : 's'} · {totals.mailboxes} mailboxes
            included
          </div>
        )}
      </div>

      {error && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="flex items-center gap-3 py-4 text-sm">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
            {error}
          </CardContent>
        </Card>
      )}

      {services === null ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : services.length === 0 ? (
        <PlanLineup onPurchased={() => void load()} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {services.map((s) => (
            <Card
              key={s.id}
              className="cursor-pointer transition-colors hover:border-primary/60"
              onClick={() => setSelected(s.id)}
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base flex items-center gap-2 min-w-0">
                    <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="truncate">{s.domain}</span>
                  </CardTitle>
                  {statusBadge(s.status)}
                </div>
                <CardDescription>
                  {s.plan?.name || 'Email hosting'}
                  {s.plan ? ` · $${s.plan.price.toFixed(2)}/mo` : ''}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex items-center gap-4 text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Users className="h-4 w-4" />
                  {s.limits.mailboxLimit} mailboxes
                </span>
                <span className="flex items-center gap-1.5">
                  <HardDrive className="h-4 w-4" />
                  {s.limits.totalStorageGB} GB
                </span>
                {!s.dkimGenerated && (
                  <Badge variant="outline" className="ml-auto text-amber-600 border-amber-500/40">
                    DNS setup needed
                  </Badge>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
