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
  ExternalLink,
  AlertTriangle,
  ArrowLeft,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
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

// ─── Helpers ───────────────────────────────────────────────────────────────

function authHeaders(): HeadersInit {
  const t = typeof window !== 'undefined' ? localStorage.getItem('apsamo_token') : ''
  return { Authorization: `Bearer ${t || ''}`, 'Content-Type': 'application/json' }
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
    throw new Error((data as { error?: string })?.error || `Request failed (${res.status})`)
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

function PlanLineup() {
  const [plans, setPlans] = useState<EmailPlan[] | null>(null)

  useEffect(() => {
    api<{ plans: EmailPlan[] }>('/api/billing/plans?type=email')
      .then((d) => setPlans(d.plans || []))
      .catch(() => setPlans([]))
  }, [])

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
                  onClick={() =>
                    toast.info(
                      'Choose this plan from Billing → Plans to complete checkout.'
                    )
                  }
                >
                  Choose {p.name}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
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

  const [pwTarget, setPwTarget] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState('')

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

  useEffect(() => {
    void load()
  }, [load])

  const usage = detail?.usage
  const atLimit = usage?.atMailboxLimit ?? false

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
          <TabsTrigger value="dns">DNS setup</TabsTrigger>
        </TabsList>

        {/* ── Mailboxes ── */}
        <TabsContent value="mailboxes" className="space-y-4 pt-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {atLimit
                ? 'Every mailbox in your plan is in use. Upgrade to add more.'
                : `You can create ${detail.limits.mailboxLimit - (usage?.mailboxes ?? 0)} more mailbox(es).`}
            </p>
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
        <PlanLineup />
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
