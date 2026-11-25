'use client'

/**
 * Email management — the native panel UI over Mailcow.
 *
 * Lives in its own file rather than inside website-management-tabs.tsx: that
 * file is already ~5k lines and is the one most often hot-patched in
 * production, so keeping this separate limits merge pain.
 *
 * Everything here talks to /api/hosting/[id]/email/*, which resolves the
 * project's own domains server-side — the UI never chooses which domains it
 * may touch.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { InlineError } from '@/components/hosting/site/shared'
import {
  Mail,
  Users,
  HardDrive,
  ShieldAlert,
  Inbox,
  Send,
  Plus,
  Trash2,
  Loader2,
  RefreshCw,
  AtSign,
  ShieldCheck,
  ShieldX,
  FileText,
  ArrowRight,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// ─── Brand ─────────────────────────────────────────────────────────────────
const BRAND = { primary: '#1E1A47', secondary: '#706FD3', accent: '#8888FF' }

// ─── Types (mirror the API) ────────────────────────────────────────────────

interface MailStats {
  mailboxes: number
  activeMailboxes: number
  suspendedMailboxes: number
  aliases: number
  quotaBytes: number
  usedBytes: number
  messages: number
  quarantined: number
  queued: number
  serverDiskUsedPercent: number | null
}

interface MailAlias {
  id: number
  address: string
  destinations: string[]
  active: boolean
  isCatchAll: boolean
  domain: string
}

interface SpamPolicy {
  score: string
  whitelist: Array<{ prefid: number; value: string }>
  blacklist: Array<{ prefid: number; value: string }>
}

interface QuarantineItem {
  id: number
  subject: string
  sender: string
  recipient: string
  score: number
  createdAt: string
}

interface LogEntry {
  time: string
  message: string
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** The httpOnly session cookie authenticates same-origin requests. */
function authHeaders(): HeadersInit {
  return { 'Content-Type': 'application/json' }
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
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`
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

// ─── Stat card ─────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  loading,
}: {
  icon: typeof Mail
  label: string
  value: string
  sub?: string
  loading: boolean
}) {
  return (
    <div className="rounded-xl border bg-card/70 backdrop-blur p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        <span
          className="rounded-lg p-1.5"
          style={{ background: `${BRAND.secondary}1a`, color: BRAND.secondary }}
        >
          <Icon className="size-4" />
        </span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      {loading ? (
        <Skeleton className="h-6 w-20" />
      ) : (
        <>
          <div className="text-2xl font-semibold tabular-nums leading-tight">{value}</div>
          {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
        </>
      )}
    </div>
  )
}

// ─── Main ──────────────────────────────────────────────────────────────────

export function EmailManagement({ projectId }: { projectId: string }) {
  const [stats, setStats] = useState<MailStats | null>(null)
  const [domains, setDomains] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [fatal, setFatal] = useState<string | null>(null)

  const loadStats = useCallback(async () => {
    setLoading(true)
    setFatal(null)
    try {
      const r = await api<{ stats: MailStats; domains: string[] }>(
        `/api/hosting/${projectId}/email/stats`
      )
      setStats(r.stats)
      setDomains(r.domains || [])
    } catch (e) {
      setFatal(e instanceof Error ? e.message : 'Could not load email statistics')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  const usedPct = useMemo(() => {
    if (!stats || !stats.quotaBytes) return 0
    return Math.min(100, Math.round((stats.usedBytes / stats.quotaBytes) * 100))
  }, [stats])

  if (fatal) {
    return (
      <Card>
        <CardContent className="py-10 text-center space-y-3">
          <ShieldAlert className="size-10 mx-auto text-muted-foreground" />
          <p className="font-medium">Email management unavailable</p>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">{fatal}</p>
          <Button variant="outline" onClick={loadStats}>
            <RefreshCw className="size-4 me-2" /> Retry
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* ── Dashboard ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={Mail}
          label="Mailboxes"
          value={String(stats?.mailboxes ?? 0)}
          sub={`${stats?.activeMailboxes ?? 0} active · ${stats?.suspendedMailboxes ?? 0} suspended`}
          loading={loading}
        />
        <StatCard
          icon={AtSign}
          label="Aliases & forwarders"
          value={String(stats?.aliases ?? 0)}
          loading={loading}
        />
        <StatCard
          icon={HardDrive}
          label="Storage used"
          value={formatBytes(stats?.usedBytes)}
          sub={stats?.quotaBytes ? `${usedPct}% of ${formatBytes(stats.quotaBytes)}` : undefined}
          loading={loading}
        />
        <StatCard
          icon={Inbox}
          label="Messages"
          value={String(stats?.messages ?? 0)}
          sub={`${stats?.quarantined ?? 0} quarantined · ${stats?.queued ?? 0} queued`}
          loading={loading}
        />
      </div>

      {stats?.quotaBytes ? (
        <div className="rounded-lg border p-3">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-muted-foreground">Mailbox storage</span>
            <span className="tabular-nums">
              {formatBytes(stats.usedBytes)} / {formatBytes(stats.quotaBytes)}
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${usedPct}%`,
                background:
                  usedPct > 90
                    ? '#dc2626'
                    : `linear-gradient(90deg, ${BRAND.secondary}, ${BRAND.accent})`,
              }}
            />
          </div>
        </div>
      ) : null}

      {/* ── Management ── shown only once email is confirmed available: the
          panels below load their own data, and mounting them while the
          status was still loading made each one pop an error toast when
          email turned out to be unavailable for this website. */}
      {!loading && stats && (
      <Tabs defaultValue="aliases">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="aliases">
            <AtSign className="size-3.5 me-1.5" /> Aliases & Forwarding
          </TabsTrigger>
          <TabsTrigger value="spam">
            <ShieldCheck className="size-3.5 me-1.5" /> Spam Protection
          </TabsTrigger>
          <TabsTrigger value="quarantine">
            <ShieldAlert className="size-3.5 me-1.5" /> Quarantine
          </TabsTrigger>
          <TabsTrigger value="logs">
            <FileText className="size-3.5 me-1.5" /> Activity Logs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="aliases" className="mt-3">
          <AliasesPanel projectId={projectId} domains={domains} onChanged={loadStats} />
        </TabsContent>
        <TabsContent value="spam" className="mt-3">
          <SpamPanel projectId={projectId} domains={domains} />
        </TabsContent>
        <TabsContent value="quarantine" className="mt-3">
          <QuarantinePanel projectId={projectId} onChanged={loadStats} />
        </TabsContent>
        <TabsContent value="logs" className="mt-3">
          <LogsPanel projectId={projectId} />
        </TabsContent>
      </Tabs>
      )}
    </div>
  )
}

// ─── Aliases / forwarding / catch-all ──────────────────────────────────────

function AliasesPanel({
  projectId,
  domains,
  onChanged,
}: {
  projectId: string
  domains: string[]
  onChanged: () => void
}) {
  const [aliases, setAliases] = useState<MailAlias[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [localPart, setLocalPart] = useState('')
  const [domain, setDomain] = useState('')
  const [dests, setDests] = useState('')
  const [saving, setSaving] = useState(false)

  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const r = await api<{ aliases: MailAlias[] }>(`/api/hosting/${projectId}/email/aliases`)
      setAliases(r.aliases || [])
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load aliases')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])
  useEffect(() => {
    if (domains.length && !domain) setDomain(domains[0])
  }, [domains, domain])

  const create = async () => {
    const destinations = dests
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (!localPart.trim() || !domain || destinations.length === 0) {
      toast.error('Enter an address and at least one destination')
      return
    }
    setSaving(true)
    try {
      await api(`/api/hosting/${projectId}/email/aliases`, {
        method: 'POST',
        body: JSON.stringify({ address: `${localPart.trim()}@${domain}`, destinations }),
      })
      toast.success('Alias created')
      setOpen(false)
      setLocalPart('')
      setDests('')
      load()
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create alias')
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (a: MailAlias) => {
    setBusy(a.id)
    try {
      await api(`/api/hosting/${projectId}/email/aliases/${a.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !a.active }),
      })
      setAliases((prev) =>
        prev.map((x) => (x.id === a.id ? { ...x, active: !x.active } : x))
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setBusy(null)
    }
  }

  const remove = async (a: MailAlias) => {
    setBusy(a.id)
    try {
      await api(`/api/hosting/${projectId}/email/aliases/${a.id}`, { method: 'DELETE' })
      toast.success('Alias removed')
      load()
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusy(null)
    }
  }

  const catchAlls = aliases.filter((a) => a.isCatchAll)
  const normal = aliases.filter((a) => !a.isCatchAll)

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Aliases & Forwarding</CardTitle>
          <CardDescription>
            An alias delivers to one mailbox; add several destinations to forward a copy to each.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" style={{ background: BRAND.secondary }}>
                <Plus className="size-4 me-1.5" /> New alias
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create alias</DialogTitle>
                <DialogDescription>
                  Mail sent to this address is delivered to the destinations below.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="grid gap-1.5">
                  <Label>Address</Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="sales"
                      value={localPart}
                      onChange={(e) => setLocalPart(e.target.value)}
                    />
                    <Select value={domain} onValueChange={setDomain}>
                      <SelectTrigger className="w-[190px]">
                        <SelectValue placeholder="Domain" />
                      </SelectTrigger>
                      <SelectContent>
                        {domains.map((d) => (
                          <SelectItem key={d} value={d}>
                            @{d}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label>Destinations</Label>
                  <Input
                    placeholder="you@example.com, team@example.com"
                    value={dests}
                    onChange={(e) => setDests(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Separate multiple addresses with commas.
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={create} disabled={saving} style={{ background: BRAND.secondary }}>
                  {saving ? <Loader2 className="size-4 me-2 animate-spin" /> : null}
                  Create
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : loadError ? (
          <InlineError title="Could not load the aliases" message={loadError} onRetry={() => load()} />
        ) : aliases.length === 0 ? (
          <div className="text-center py-10">
            <AtSign className="size-8 mx-auto text-muted-foreground mb-2" />
            <p className="font-medium text-sm">No aliases yet</p>
            <p className="text-xs text-muted-foreground">
              Create one to route mail to an existing mailbox.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Address</TableHead>
                  <TableHead>Delivers to</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-end">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {normal.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono text-sm">{a.address}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5 flex-wrap text-xs">
                        <ArrowRight className="size-3 text-muted-foreground" />
                        {a.destinations.map((d) => (
                          <span key={d} className="font-mono">
                            {d}
                          </span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      {a.active ? (
                        <Badge variant="outline" className="text-emerald-600 border-emerald-200">
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">
                          Disabled
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-end">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={busy === a.id}
                          onClick={() => toggle(a)}
                        >
                          {a.active ? 'Disable' : 'Enable'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-red-600 hover:text-red-700"
                          disabled={busy === a.id}
                          onClick={() => remove(a)}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <CatchAllRow
          projectId={projectId}
          domains={domains}
          current={catchAlls}
          onChanged={() => {
            load()
            onChanged()
          }}
        />
      </CardContent>
    </Card>
  )
}

function CatchAllRow({
  projectId,
  domains,
  current,
  onChanged,
}: {
  projectId: string
  domains: string[]
  current: MailAlias[]
  onChanged: () => void
}) {
  const [domain, setDomain] = useState(domains[0] || '')
  const [dest, setDest] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (domains.length && !domain) setDomain(domains[0])
  }, [domains, domain])

  const existing = current.find((c) => c.address === `@${domain}`)

  const save = async (clear = false) => {
    setSaving(true)
    try {
      await api(`/api/hosting/${projectId}/email/catch-all`, {
        method: 'POST',
        body: JSON.stringify({ domain, destination: clear ? null : dest }),
      })
      toast.success(clear ? 'Catch-all disabled' : 'Catch-all enabled')
      setDest('')
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update catch-all')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Inbox className="size-4" style={{ color: BRAND.secondary }} />
        <span className="text-sm font-medium">Catch-all</span>
        <span className="text-xs text-muted-foreground">
          Delivers mail sent to any unknown address on the domain.
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={domain} onValueChange={setDomain}>
          <SelectTrigger className="w-[190px] h-9">
            <SelectValue placeholder="Domain" />
          </SelectTrigger>
          <SelectContent>
            {domains.map((d) => (
              <SelectItem key={d} value={d}>
                @{d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {existing ? (
          <>
            <Badge variant="outline" className="text-emerald-600 border-emerald-200">
              → {existing.destinations.join(', ')}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => save(true)}
            >
              Disable
            </Button>
          </>
        ) : (
          <>
            <Input
              className="h-9 max-w-xs"
              placeholder="deliver to mailbox@domain"
              value={dest}
              onChange={(e) => setDest(e.target.value)}
            />
            <Button
              size="sm"
              disabled={saving || !dest.trim()}
              onClick={() => save(false)}
              style={{ background: BRAND.secondary }}
            >
              {saving ? <Loader2 className="size-4 me-2 animate-spin" /> : null}
              Enable
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Spam ──────────────────────────────────────────────────────────────────

function SpamPanel({ projectId, domains }: { projectId: string; domains: string[] }) {
  const [policy, setPolicy] = useState<SpamPolicy | null>(null)
  const [loading, setLoading] = useState(true)
  const [list, setList] = useState<'wl' | 'bl'>('wl')
  const [domain, setDomain] = useState(domains[0] || '')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const r = await api<{ policy: SpamPolicy }>(`/api/hosting/${projectId}/email/spam`)
      setPolicy(r.policy)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load spam settings')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])
  useEffect(() => {
    if (domains.length && !domain) setDomain(domains[0])
  }, [domains, domain])

  const add = async () => {
    if (!value.trim() || !domain) return
    setSaving(true)
    try {
      await api(`/api/hosting/${projectId}/email/spam`, {
        method: 'POST',
        body: JSON.stringify({ list, domain, value: value.trim() }),
      })
      toast.success(list === 'wl' ? 'Added to allow list' : 'Added to block list')
      setValue('')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add entry')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (kind: 'wl' | 'bl', prefid: number) => {
    try {
      await api(`/api/hosting/${projectId}/email/spam`, {
        method: 'DELETE',
        body: JSON.stringify({ list: kind, prefid }),
      })
      toast.success('Entry removed')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove entry')
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Spam Protection</CardTitle>
        <CardDescription>
          Always accept mail from senders you trust, or reject senders outright.
          {policy?.score ? (
            <> Current server spam threshold: <span className="font-mono">{policy.score}</span>.</>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label className="text-xs">List</Label>
            <Select value={list} onValueChange={(v) => setList(v as 'wl' | 'bl')}>
              <SelectTrigger className="w-[150px] h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="wl">Allow list</SelectItem>
                <SelectItem value="bl">Block list</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Domain</Label>
            <Select value={domain} onValueChange={setDomain}>
              <SelectTrigger className="w-[190px] h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {domains.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5 flex-1 min-w-[220px]">
            <Label className="text-xs">Sender or domain</Label>
            <Input
              className="h-9"
              placeholder="sender@example.com or example.com"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            className="h-9"
            disabled={saving || !value.trim()}
            onClick={add}
            style={{ background: BRAND.secondary }}
          >
            {saving ? <Loader2 className="size-4 me-2 animate-spin" /> : <Plus className="size-4 me-1.5" />}
            Add
          </Button>
        </div>

        {loadError ? (
          <InlineError title="Could not load the spam settings" message={loadError} onRetry={() => load()} />
        ) : (
        <div className="grid md:grid-cols-2 gap-3">
          <PolicyList
            title="Allow list"
            icon={ShieldCheck}
            tone="emerald"
            loading={loading}
            entries={policy?.whitelist || []}
            onRemove={(id) => remove('wl', id)}
          />
          <PolicyList
            title="Block list"
            icon={ShieldX}
            tone="red"
            loading={loading}
            entries={policy?.blacklist || []}
            onRemove={(id) => remove('bl', id)}
          />
        </div>
        )}
      </CardContent>
    </Card>
  )
}

function PolicyList({
  title,
  icon: Icon,
  tone,
  entries,
  loading,
  onRemove,
}: {
  title: string
  icon: typeof ShieldCheck
  tone: 'emerald' | 'red'
  entries: Array<{ prefid: number; value: string }>
  loading: boolean
  onRemove: (prefid: number) => void
}) {
  return (
    <div className="rounded-lg border">
      <div className="flex items-center gap-2 px-3 py-2 border-b">
        <Icon className={`size-4 ${tone === 'emerald' ? 'text-emerald-600' : 'text-red-600'}`} />
        <span className="text-sm font-medium">{title}</span>
        <Badge variant="outline" className="ms-auto text-[10px]">
          {entries.length}
        </Badge>
      </div>
      {loading ? (
        <div className="p-3 space-y-2">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-2/3" />
        </div>
      ) : entries.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">Nothing here yet</p>
      ) : (
        <ul className="divide-y">
          {entries.map((e) => (
            <li key={e.prefid} className="flex items-center gap-2 px-3 py-1.5">
              <span className="font-mono text-xs truncate">{e.value}</span>
              <Button
                variant="ghost"
                size="sm"
                className="ms-auto h-6 text-xs text-red-600 hover:text-red-700"
                onClick={() => onRemove(e.prefid)}
              >
                <Trash2 className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─── Quarantine ────────────────────────────────────────────────────────────

function QuarantinePanel({
  projectId,
  onChanged,
}: {
  projectId: string
  onChanged: () => void
}) {
  const [items, setItems] = useState<QuarantineItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<number | null>(null)

  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const r = await api<{ messages: QuarantineItem[] }>(
        `/api/hosting/${projectId}/email/quarantine`
      )
      setItems(r.messages || [])
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load quarantine')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])

  const act = async (action: 'release' | 'delete', id: number) => {
    setBusy(id)
    try {
      await api(`/api/hosting/${projectId}/email/quarantine`, {
        method: 'POST',
        body: JSON.stringify({ action, ids: [id] }),
      })
      toast.success(action === 'release' ? 'Message released' : 'Message deleted')
      load()
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Quarantine</CardTitle>
          <CardDescription>
            Messages held as spam. Release the ones that were caught by mistake.
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : loadError ? (
          <InlineError title="Could not load the quarantine" message={loadError} onRetry={() => load()} />
        ) : items.length === 0 ? (
          <div className="text-center py-10">
            <CheckCircle2 className="size-8 mx-auto text-emerald-500 mb-2" />
            <p className="font-medium text-sm">Nothing in quarantine</p>
            <p className="text-xs text-muted-foreground">No messages are being held.</p>
          </div>
        ) : (
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Score</TableHead>
                  <TableHead className="text-end">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="max-w-xs truncate text-sm">{m.subject}</TableCell>
                    <TableCell className="font-mono text-xs">{m.sender}</TableCell>
                    <TableCell className="font-mono text-xs">{m.recipient}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{m.score}</Badge>
                    </TableCell>
                    <TableCell className="text-end">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={busy === m.id}
                          onClick={() => act('release', m.id)}
                        >
                          <Send className="size-3 me-1" /> Release
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-red-600 hover:text-red-700"
                          disabled={busy === m.id}
                          onClick={() => act('delete', m.id)}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Logs ──────────────────────────────────────────────────────────────────

const LOG_KINDS = [
  { value: 'postfix', label: 'Delivery' },
  { value: 'dovecot', label: 'Mailbox logins' },
  { value: 'rspamd-history', label: 'Spam decisions' },
  { value: 'sogo', label: 'Webmail' },
] as const

function LogsPanel({ projectId }: { projectId: string }) {
  const [kind, setKind] = useState<string>('postfix')
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)

  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const r = await api<{ entries: LogEntry[] }>(
        `/api/hosting/${projectId}/email/logs?kind=${kind}&limit=200`
      )
      setEntries(r.entries || [])
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load logs')
    } finally {
      setLoading(false)
    }
  }, [projectId, kind])

  useEffect(() => {
    load()
  }, [load])

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Activity Logs</CardTitle>
          <CardDescription>Recent mail activity for your domains.</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger className="w-[170px] h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOG_KINDS.map((k) => (
                <SelectItem key={k.value} value={k.value}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : loadError ? (
          <InlineError title="Could not load the activity logs" message={loadError} onRetry={() => load()} />
        ) : entries.length === 0 ? (
          <div className="text-center py-10">
            <XCircle className="size-8 mx-auto text-muted-foreground mb-2" />
            <p className="font-medium text-sm">No recent activity</p>
            <p className="text-xs text-muted-foreground">
              Nothing in the last batch of server logs mentions your domains.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border max-h-[420px] overflow-auto">
            <ul className="divide-y text-xs font-mono">
              {entries.map((e, i) => (
                <li key={i} className="px-3 py-1.5 flex gap-3">
                  <span className="text-muted-foreground whitespace-nowrap">
                    {e.time ? new Date(e.time).toLocaleString() : '—'}
                  </span>
                  <span className="break-all">{e.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
