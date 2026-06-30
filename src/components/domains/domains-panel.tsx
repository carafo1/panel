'use client'

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiFetch, useAuthStore } from '@/store/auth-store'
import {
  Search, Globe, Plus, Trash2, RefreshCw, Shield, Clock, CheckCircle2,
  XCircle, Tag, Lock, Unlock, Copy, Loader2, AlertTriangle, ArrowLeft,
  FileText, Database, Server, Mail, KeyRound, Power, Send, Eye, EyeOff,
  ShieldCheck, ShieldOff, Sparkles, Download, ShoppingBag, Wallet,
  TrendingUp, Calendar, ExternalLink, ChevronRight, Zap, BadgeDollarSign,
} from 'lucide-react'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'

// ─── Types ────────────────────────────────────────────────────────────────────

interface SearchResult {
  domain: string
  available: boolean
  premium: boolean
  registrationPrice: number | null
  renewalPrice: number | null
  transferPrice: number | null
  currency: string
  suggestions?: Array<{ domain: string; available: boolean; premium: boolean; registrationPrice: number }>
}

interface Domain {
  id: string
  name: string
  status: string
  registrar: string
  provider: string
  registeredAt?: string
  expiresAt?: string
  autoRenew: boolean
  whoisPrivacy: boolean
  locked: boolean
  premium: boolean
  nameservers?: string | null
  dnsRecords?: DnsRecord[]
  projectId?: string | null
}

interface DnsRecord {
  id?: string
  type: string
  name: string
  value: string
  ttl: number
  priority?: number | null
  proxied?: boolean
}

interface TldPrice {
  tld: string
  wholesale: number
  markup: number
  registration: number
  renewal: number
  transfer: number
  currency: string
  active: boolean
}

interface Invoice {
  id: string
  number: string
  domainName?: string | null
  total: number
  currency: string
  status: string
  paidAt?: string
  createdAt: string
  items?: Array<{ description: string; quantity: number; unitPrice: number; total: number }>
}

interface DomainLog {
  id: string
  action: string
  status: string
  message: string
  createdAt: string
}

type Tab = 'search' | 'domains' | 'invoices' | 'pricing' | 'admin'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusColor(status: string): string {
  switch (status) {
    case 'active': return 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border-indigo-500/30'
    case 'pending': case 'pending_verification': return 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
    case 'transferring': return 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border-indigo-500/30'
    case 'expired': case 'suspended': case 'deleted': return 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30'
    default: return 'bg-gray-500/15 text-gray-600 dark:text-gray-400 border-gray-500/30'
  }
}

function daysUntil(dateStr?: string): number | null {
  if (!dateStr) return null
  const diff = new Date(dateStr).getTime() - Date.now()
  return Math.ceil(diff / (24 * 60 * 60 * 1000))
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export default function DomainsPanel() {
  const [tab, setTab] = useState<Tab>('search')
  const [selectedDomainId, setSelectedDomainId] = useState<string | null>(null)
  const [transferOpen, setTransferOpen] = useState(false)
  const [globalMarkup, setGlobalMarkup] = useState<number | null>(null)
  const { user } = useAuthStore()
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin'

  // Fetch the current global markup once on mount so the badge can show it.
  useEffect(() => {
    apiFetch('/pricing/markup')
      .then((data) => setGlobalMarkup(typeof data.data?.markup === 'number' ? data.data.markup : null))
      .catch(() => setGlobalMarkup(null))
  }, [])

  if (selectedDomainId) {
    return (
      <DomainDetail
        domainId={selectedDomainId}
        onBack={() => setSelectedDomainId(null)}
        isAdmin={isAdmin}
      />
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Globe className="h-6 w-6 text-indigo-500" />
            Domain Reseller
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Search, register, renew, transfer &amp; manage domains via Apsamo
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="w-fit" title="Editable in the Pricing tab">
            <Sparkles className="h-3 w-3 mr-1 text-amber-500" />
            {globalMarkup !== null
              ? `$${globalMarkup.toFixed(2)} markup applied`
              : 'markup loading…'}
          </Badge>
          <Button variant="outline" size="sm" onClick={() => setTransferOpen(true)}>
            <Send className="h-4 w-4 mr-1.5" />
            Transfer Domain
          </Button>
        </div>
      </div>

      {transferOpen && (
        <TransferDomainDialog
          onClose={() => setTransferOpen(false)}
          onTransferred={() => setTab('domains')}
        />
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="grid w-full grid-cols-2 sm:grid-cols-5 h-auto">
          <TabsTrigger value="search" className="flex items-center gap-1.5">
            <Search className="h-4 w-4" /> Search
          </TabsTrigger>
          <TabsTrigger value="domains" className="flex items-center gap-1.5">
            <Globe className="h-4 w-4" /> My Domains
          </TabsTrigger>
          <TabsTrigger value="invoices" className="flex items-center gap-1.5">
            <FileText className="h-4 w-4" /> Invoices
          </TabsTrigger>
          <TabsTrigger value="pricing" className="flex items-center gap-1.5">
            <BadgeDollarSign className="h-4 w-4" /> Pricing
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="admin" className="flex items-center gap-1.5">
              <Shield className="h-4 w-4" /> Admin
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="search" className="mt-6">
          <SearchTab onRegistered={() => setTab('domains')} />
        </TabsContent>
        <TabsContent value="domains" className="mt-6">
          <DomainsListTab onSelect={setSelectedDomainId} />
        </TabsContent>
        <TabsContent value="invoices" className="mt-6">
          <InvoicesTab />
        </TabsContent>
        <TabsContent value="pricing" className="mt-6">
          <PricingTab
            isAdmin={isAdmin}
            globalMarkup={globalMarkup}
            onMarkupChanged={(m) => setGlobalMarkup(m)}
          />
        </TabsContent>
        {isAdmin && (
          <TabsContent value="admin" className="mt-6">
            <AdminTab onSelect={setSelectedDomainId} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}

// ─── Search Tab ───────────────────────────────────────────────────────────────

function SearchTab({ onRegistered }: { onRegistered: () => void }) {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [bulkMode, setBulkMode] = useState(false)
  const [bulkQuery, setBulkQuery] = useState('')
  const [bulkResults, setBulkResults] = useState<SearchResult[]>([])
  const [registering, setRegistering] = useState<string | null>(null)
  const [registerDialog, setRegisterDialog] = useState<{ domain: string; price: number } | null>(null)

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return
    setLoading(true)
    setResult(null)
    try {
      const data = await apiFetch(`/domains/search?domain=${encodeURIComponent(query.trim())}`)
      setResult(data.data)
    } catch (err) {
      toast.error('Search failed', { description: (err as Error).message })
    } finally {
      setLoading(false)
    }
  }, [query])

  const handleBulkSearch = useCallback(async () => {
    const domains = bulkQuery.split('\n').map((d) => d.trim()).filter(Boolean)
    if (domains.length === 0) return
    setLoading(true)
    try {
      const data = await apiFetch('/domains/search', {
        method: 'POST',
        body: JSON.stringify({ domains }),
      })
      setBulkResults(data.data || [])
    } catch (err) {
      toast.error('Bulk search failed', { description: (err as Error).message })
    } finally {
      setLoading(false)
    }
  }, [bulkQuery])

  const handleRegister = async (domain: string, duration: number) => {
    setRegistering(domain)
    try {
      await apiFetch('/domains/register', {
        method: 'POST',
        body: JSON.stringify({ name: domain, duration, provider: 'dynadot' }),
      })
      toast.success('Domain registered!', {
        description: `${domain} is now active. Invoice generated.`,
      })
      setRegisterDialog(null)
      onRegistered()
    } catch (err) {
      toast.error('Registration failed', { description: (err as Error).message })
    } finally {
      setRegistering(null)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Search className="h-5 w-5 text-indigo-500" />
                Domain Search
              </CardTitle>
              <CardDescription>Instant availability with registration, renewal &amp; transfer pricing</CardDescription>
            </div>
            <Button
              variant={bulkMode ? 'default' : 'outline'}
              size="sm"
              onClick={() => { setBulkMode(!bulkMode); setResult(null); setBulkResults([]) }}
            >
              {bulkMode ? 'Single Search' : 'Bulk Search'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!bulkMode ? (
            <>
              <div className="flex gap-2">
                <Input
                  placeholder="example.com"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  className="text-base"
                />
                <Button onClick={handleSearch} disabled={loading || !query.trim()}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  Search
                </Button>
              </div>

              {loading && <SearchSkeleton />}

              {result && (
                <SearchResultCard
                  result={result}
                  onRegister={(domain, price) => setRegisterDialog({ domain, price })}
                  registering={registering}
                />
              )}
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Enter one domain per line (max 50)</Label>
                <Textarea
                  placeholder={'example.com\nmybrand.net\nawesome.io'}
                  value={bulkQuery}
                  onChange={(e) => setBulkQuery(e.target.value)}
                  rows={6}
                  className="font-mono text-sm"
                />
                <Button onClick={handleBulkSearch} disabled={loading || !bulkQuery.trim()}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  Search {bulkQuery.split('\n').filter(Boolean).length} Domains
                </Button>
              </div>

              {bulkResults.length > 0 && (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Domain</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Register</TableHead>
                        <TableHead className="text-right">Renew</TableHead>
                        <TableHead className="text-right">Transfer</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {bulkResults.map((r) => (
                        <TableRow key={r.domain}>
                          <TableCell className="font-medium flex items-center gap-2">
                            {r.premium && <Sparkles className="h-3 w-3 text-amber-500" />}
                            {r.domain}
                          </TableCell>
                          <TableCell>
                            {r.available ? (
                              <Badge className="bg-indigo-500/15 text-indigo-600 border-indigo-500/30">Available</Badge>
                            ) : (
                              <Badge variant="secondary">Taken</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {r.registrationPrice ? `$${r.registrationPrice}` : '—'}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {r.renewalPrice ? `$${r.renewalPrice}` : '—'}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {r.transferPrice ? `$${r.transferPrice}` : '—'}
                          </TableCell>
                          <TableCell>
                            {r.available && r.registrationPrice && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setRegisterDialog({ domain: r.domain, price: r.registrationPrice! })}
                              >
                                <ShoppingBag className="h-3 w-3 mr-1" /> Buy
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {registerDialog && (
        <RegisterDialog
          domain={registerDialog.domain}
          price={registerDialog.price}
          loading={registering === registerDialog.domain}
          onClose={() => setRegisterDialog(null)}
          onConfirm={(duration) => handleRegister(registerDialog.domain, duration)}
        />
      )}
    </div>
  )
}

function SearchSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  )
}

function SearchResultCard({
  result, onRegister, registering,
}: {
  result: SearchResult
  onRegister: (domain: string, price: number) => void
  registering: string | null
}) {
  const copy = (text: string) => {
    navigator.clipboard.writeText(text)
    toast.success('Copied to clipboard')
  }

  return (
    <div className="space-y-4">
      <div className={`rounded-lg border p-4 ${result.available ? 'border-indigo-500/30 bg-indigo-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h3 className="text-xl font-bold">{result.domain}</h3>
              {result.premium && (
                <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30">
                  <Sparkles className="h-3 w-3 mr-1" /> Premium
                </Badge>
              )}
            </div>
            {result.available ? (
              <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400">
                <CheckCircle2 className="h-4 w-4" />
                <span className="text-sm font-medium">Available</span>
                <Badge variant="outline" className="ml-2">{result.provider}</Badge>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
                <XCircle className="h-4 w-4" />
                <span className="text-sm font-medium">Not Available</span>
              </div>
            )}
          </div>
          {result.available && result.registrationPrice && (
            <div className="text-right">
              <div className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">
                ${result.registrationPrice}
              </div>
              <div className="text-xs text-muted-foreground">/year</div>
            </div>
          )}
        </div>

        {result.available && (
          <div className="grid grid-cols-3 gap-3 mt-4">
            <div className="rounded-md bg-background/60 p-2 text-center">
              <div className="text-xs text-muted-foreground">Register</div>
              <div className="font-semibold">${result.registrationPrice}</div>
            </div>
            <div className="rounded-md bg-background/60 p-2 text-center">
              <div className="text-xs text-muted-foreground">Renew</div>
              <div className="font-semibold">${result.renewalPrice}</div>
            </div>
            <div className="rounded-md bg-background/60 p-2 text-center">
              <div className="text-xs text-muted-foreground">Transfer</div>
              <div className="font-semibold">${result.transferPrice}</div>
            </div>
          </div>
        )}

        {result.available && result.registrationPrice && (
          <div className="flex gap-2 mt-4">
            <Button
              onClick={() => onRegister(result.domain, result.registrationPrice!)}
              disabled={registering === result.domain}
              className="flex-1"
            >
              {registering === result.domain ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <ShoppingBag className="h-4 w-4 mr-2" />
              )}
              Register Now
            </Button>
            <Button variant="outline" size="icon" onClick={() => copy(result.domain)}>
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      {result.suggestions && result.suggestions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-amber-500" />
              Alternative TLDs
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {result.suggestions.map((s) => (
                <div
                  key={s.domain}
                  className="flex items-center justify-between rounded-md border p-2 hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    {s.available ? (
                      <CheckCircle2 className="h-4 w-4 text-indigo-500" />
                    ) : (
                      <XCircle className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="font-medium text-sm">{s.domain}</span>
                    {s.premium && <Sparkles className="h-3 w-3 text-amber-500" />}
                  </div>
                  <div className="flex items-center gap-2">
                    {s.available && (
                      <span className="text-sm font-mono text-indigo-600">${s.registrationPrice}</span>
                    )}
                    {s.available && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onRegister(s.domain, s.registrationPrice)}
                      >
                        Buy
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function RegisterDialog({
  domain, price, loading, onClose, onConfirm,
}: {
  domain: string
  price: number
  loading: boolean
  onClose: () => void
  onConfirm: (duration: number) => void
}) {
  const [duration, setDuration] = useState(1)
  const total = (price * duration).toFixed(2)

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShoppingBag className="h-5 w-5 text-indigo-500" />
            Register {domain}
          </DialogTitle>
          <DialogDescription>
            Register this domain through Apsamo. A paid invoice and activity log will be generated automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Registration Period</Label>
            <Select value={String(duration)} onValueChange={(v) => setDuration(Number(v))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 5, 10].map((y) => (
                  <SelectItem key={y} value={String(y)}>{y} year{y > 1 ? 's' : ''}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="rounded-md bg-muted/50 p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Domain</span>
              <span className="font-medium">{domain}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Price / year</span>
              <span className="font-mono">${price}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Duration</span>
              <span>{duration} year{duration > 1 ? 's' : ''}</span>
            </div>
            <Separator />
            <div className="flex justify-between font-semibold">
              <span>Total</span>
              <span className="text-indigo-600">${total}</span>
            </div>
          </div>
          <div className="rounded-md border border-indigo-500/30 bg-indigo-500/5 p-3 text-xs text-muted-foreground">
            After payment, the system will: register via Apsamo → configure nameservers →
            set DNS records → save to database → create invoice → generate audit log → send confirmation email.
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={() => onConfirm(duration)} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Zap className="h-4 w-4 mr-2" />}
            Complete Purchase (${total})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Transfer Domain Dialog (standalone — opens from main panel header) ───────

function TransferDomainDialog({
  onClose,
  onTransferred,
}: {
  onClose: () => void
  onTransferred: () => void
}) {
  const [domain, setDomain] = useState('')
  const [authCode, setAuthCode] = useState('')
  const [transferring, setTransferring] = useState(false)

  const submit = async () => {
    if (!domain.trim() || !authCode.trim()) {
      toast.error('Domain and auth code are required')
      return
    }
    setTransferring(true)
    try {
      const data = await apiFetch('/domains/transfer', {
        method: 'POST',
        body: JSON.stringify({ domain: domain.trim(), authCode: authCode.trim() }),
      })
      toast.success('Transfer initiated!', {
        description: `${data.data?.domain || domain} — invoice ${data.data?.invoiceNumber || 'created'}`,
      })
      onTransferred()
      onClose()
    } catch (err) {
      toast.error('Transfer failed', { description: (err as Error).message })
    } finally {
      setTransferring(false)
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5 text-indigo-500" />
            Transfer Domain
          </DialogTitle>
          <DialogDescription>
            Bring a domain from another registrar to your account. You&apos;ll need
            the EPP authorization code from your current registrar.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Domain to transfer</Label>
            <Input
              placeholder="example.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="font-mono"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label>EPP / Auth code</Label>
            <Input
              placeholder="Authorization code from current registrar"
              value={authCode}
              onChange={(e) => setAuthCode(e.target.value)}
              type="password"
              className="font-mono"
            />
          </div>
          <div className="rounded-md border border-indigo-500/30 bg-indigo-500/5 p-3 text-xs text-muted-foreground space-y-1">
            <div className="flex items-center gap-1.5 font-medium text-indigo-700 dark:text-indigo-400">
              <AlertTriangle className="h-3.5 w-3.5" />
              Before transferring
            </div>
            <ul className="list-disc list-inside space-y-0.5 ml-1">
              <li>Unlock the domain at your current registrar</li>
              <li>Disable WHOIS privacy if enabled</li>
              <li>Ensure the domain has 7+ days until expiry</li>
              <li>Transfers typically take 5–7 days to complete</li>
            </ul>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={transferring}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={transferring || !domain.trim() || !authCode.trim()}>
            {transferring ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Send className="h-4 w-4 mr-2" />
            )}
            Initiate Transfer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Domains List Tab ─────────────────────────────────────────────────────────

function DomainsListTab({ onSelect }: { onSelect: (id: string) => void }) {
  const [domains, setDomains] = useState<Domain[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/domains')
      // Handle both array and envelope responses
      const list = Array.isArray(data) ? data : data.data || data.domains || []
      setDomains(list)
    } catch (err) {
      toast.error('Failed to load domains', { description: (err as Error).message })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-40" />)}
      </div>
    )
  }

  if (domains.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <Globe className="h-12 w-12 text-muted-foreground mb-3" />
          <h3 className="font-semibold text-lg">No domains yet</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">
            Search for a domain and register it to get started. All your domains will appear here.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {domains.map((d) => {
        const days = daysUntil(d.expiresAt)
        const expiringSoon = days !== null && days < 30 && days >= 0
        return (
          <Card
            key={d.id}
            className="cursor-pointer hover:border-indigo-500/40 hover:shadow-md transition-all"
            onClick={() => onSelect(d.id)}
          >
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <CardTitle className="text-base truncate flex items-center gap-2">
                    <Globe className="h-4 w-4 text-indigo-500 flex-shrink-0" />
                    <span className="truncate">{d.name}</span>
                  </CardTitle>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <Badge className={statusColor(d.status)} variant="outline">
                      {d.status}
                    </Badge>
                    {d.premium && (
                      <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30" variant="outline">
                        <Sparkles className="h-3 w-3 mr-1" />Premium
                      </Badge>
                    )}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              </div>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground flex items-center gap-1">
                  <Calendar className="h-3 w-3" /> Expires
                </span>
                <span className={expiringSoon ? 'text-amber-600 font-medium' : ''}>
                  {d.expiresAt ? new Date(d.expiresAt).toLocaleDateString() : '—'}
                  {expiringSoon && ` (${days}d)`}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground flex items-center gap-1">
                  {d.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                  Lock
                </span>
                <span>{d.locked ? 'Locked' : 'Unlocked'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground flex items-center gap-1">
                  <Shield className="h-3 w-3" /> Privacy
                </span>
                <span>{d.whoisPrivacy ? 'On' : 'Off'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground flex items-center gap-1">
                  <RefreshCw className="h-3 w-3" /> Auto-renew
                </span>
                <span>{d.autoRenew ? 'On' : 'Off'}</span>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

// ─── Domain Detail ────────────────────────────────────────────────────────────

function DomainDetail({
  domainId, onBack, isAdmin,
}: {
  domainId: string
  onBack: () => void
  isAdmin: boolean
}) {
  const [domain, setDomain] = useState<Domain | null>(null)
  const [logs, setLogs] = useState<DomainLog[]>([])
  const [loading, setLoading] = useState(true)
  const [section, setSection] = useState<'overview' | 'nameservers' | 'dns' | 'security' | 'renew' | 'logs'>('overview')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch(`/domains/${domainId}`)
      setDomain(data.data || data.domain || data)
      try {
        const logData = await apiFetch(`/domains/${domainId}/logs`)
        setLogs(logData.data || [])
      } catch { /* logs optional */ }
    } catch (err) {
      toast.error('Failed to load domain', { description: (err as Error).message })
    } finally {
      setLoading(false)
    }
  }, [domainId])

  useEffect(() => { load() }, [load])

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (!domain) {
    return (
      <Card>
        <CardContent className="py-16 text-center">
          <AlertTriangle className="h-10 w-10 text-amber-500 mx-auto mb-3" />
          <p>Domain not found.</p>
          <Button variant="outline" onClick={onBack} className="mt-4">Back to Domains</Button>
        </CardContent>
      </Card>
    )
  }

  const days = daysUntil(domain.expiresAt)

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <CardTitle className="text-2xl flex items-center gap-2">
                <Globe className="h-6 w-6 text-indigo-500" />
                {domain.name}
              </CardTitle>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <Badge className={statusColor(domain.status)} variant="outline">{domain.status}</Badge>
                <Badge variant="outline">{domain.registrar}</Badge>
                {domain.premium && (
                  <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30" variant="outline">
                    <Sparkles className="h-3 w-3 mr-1" />Premium
                  </Badge>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-md bg-muted/50 px-3 py-2">
                <div className="text-xs text-muted-foreground">Expires</div>
                <div className="font-medium">
                  {domain.expiresAt ? new Date(domain.expiresAt).toLocaleDateString() : '—'}
                </div>
                {days !== null && (
                  <div className={`text-xs ${days < 30 ? 'text-amber-600' : 'text-muted-foreground'}`}>
                    {days > 0 ? `${days} days left` : 'Expired'}
                  </div>
                )}
              </div>
              <div className="rounded-md bg-muted/50 px-3 py-2">
                <div className="text-xs text-muted-foreground">Registered</div>
                <div className="font-medium">
                  {domain.registeredAt ? new Date(domain.registeredAt).toLocaleDateString() : '—'}
                </div>
              </div>
            </div>
          </div>
        </CardHeader>
      </Card>

      <Tabs value={section} onValueChange={(v) => setSection(v as typeof section)}>
        <TabsList className="grid w-full grid-cols-3 sm:grid-cols-6 h-auto">
          <TabsTrigger value="overview" className="text-xs">Overview</TabsTrigger>
          <TabsTrigger value="nameservers" className="text-xs">Nameservers</TabsTrigger>
          <TabsTrigger value="dns" className="text-xs">DNS</TabsTrigger>
          <TabsTrigger value="security" className="text-xs">Security</TabsTrigger>
          <TabsTrigger value="renew" className="text-xs">Renew/Transfer</TabsTrigger>
          <TabsTrigger value="logs" className="text-xs">Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <OverviewSection domain={domain} />
        </TabsContent>
        <TabsContent value="nameservers" className="mt-4">
          <NameserversSection domain={domain} onUpdated={load} />
        </TabsContent>
        <TabsContent value="dns" className="mt-4">
          <DnsSection domain={domain} onUpdated={load} />
        </TabsContent>
        <TabsContent value="security" className="mt-4">
          <SecuritySection domain={domain} onUpdated={load} />
        </TabsContent>
        <TabsContent value="renew" className="mt-4">
          <RenewTransferSection domain={domain} onUpdated={load} />
        </TabsContent>
        <TabsContent value="logs" className="mt-4">
          <LogsSection logs={logs} />
        </TabsContent>
      </Tabs>
      {isAdmin && <div className="text-xs text-muted-foreground">Admin mode: full access to this domain.</div>}
    </div>
  )
}

function OverviewSection({ domain }: { domain: Domain }) {
  const stats = [
    { label: 'Status', value: domain.status, icon: Globe, color: 'text-indigo-500' },
    { label: 'Registrar', value: domain.registrar, icon: Server, color: 'text-indigo-500' },
    { label: 'Auto-Renew', value: domain.autoRenew ? 'Enabled' : 'Disabled', icon: RefreshCw, color: domain.autoRenew ? 'text-indigo-500' : 'text-muted-foreground' },
    { label: 'WHOIS Privacy', value: domain.whoisPrivacy ? 'Enabled' : 'Disabled', icon: Shield, color: domain.whoisPrivacy ? 'text-indigo-500' : 'text-muted-foreground' },
    { label: 'Registrar Lock', value: domain.locked ? 'Locked' : 'Unlocked', icon: Lock, color: domain.locked ? 'text-indigo-500' : 'text-amber-500' },
    { label: 'Premium', value: domain.premium ? 'Yes' : 'No', icon: Sparkles, color: domain.premium ? 'text-amber-500' : 'text-muted-foreground' },
  ]
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {stats.map((s) => (
        <Card key={s.label}>
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{s.label}</span>
              <s.icon className={`h-4 w-4 ${s.color}`} />
            </div>
            <div className="text-lg font-semibold mt-1">{s.value}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function NameserversSection({ domain, onUpdated }: { domain: Domain; onUpdated: () => void }) {
  const [nameservers, setNameservers] = useState<string[]>(['', ''])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    try {
      const ns = domain.nameservers ? JSON.parse(domain.nameservers) : []
      setNameservers(ns.length >= 2 ? ns : [...ns, '', ''].slice(0, 2))
    } catch {
      setNameservers(['', ''])
    }
  }, [domain.nameservers])

  const update = (i: number, val: string) => {
    const next = [...nameservers]
    next[i] = val
    setNameservers(next)
  }

  const add = () => setNameservers([...nameservers, ''])
  const remove = (i: number) => nameservers.length > 2 && setNameservers(nameservers.filter((_, idx) => idx !== i))

  const save = async () => {
    const clean = nameservers.map((n) => n.trim()).filter(Boolean)
    if (clean.length < 2) { toast.error('At least 2 nameservers required'); return }
    setSaving(true)
    try {
      await apiFetch(`/domains/${domain.id}/nameservers`, {
        method: 'PUT',
        body: JSON.stringify({ nameservers: clean }),
      })
      toast.success('Nameservers updated', {
        description: `${clean.length} nameservers configured via Apsamo`,
      })
      onUpdated()
    } catch (err) {
      toast.error('Failed to update nameservers', { description: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Server className="h-5 w-5 text-indigo-500" />
          Custom Nameservers
        </CardTitle>
        <CardDescription>Set the authoritative nameservers for this domain (2–13 allowed)</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {nameservers.map((ns, i) => (
          <div key={i} className="flex gap-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground w-8">ns{i + 1}</div>
            <Input
              placeholder={`ns${i + 1}.example.com`}
              value={ns}
              onChange={(e) => update(i, e.target.value)}
              className="font-mono"
            />
            {nameservers.length > 2 && (
              <Button variant="outline" size="icon" onClick={() => remove(i)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}
        <div className="flex gap-2">
          {nameservers.length < 13 && (
            <Button variant="outline" size="sm" onClick={add}>
              <Plus className="h-4 w-4 mr-1" /> Add Nameserver
            </Button>
          )}
          <Button onClick={save} disabled={saving} className="ml-auto">
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Save Nameservers
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function DnsSection({ domain, onUpdated }: { domain: Domain; onUpdated: () => void }) {
  const [records, setRecords] = useState<DnsRecord[]>([])
  const [saving, setSaving] = useState(false)
  const [showEmailGen, setShowEmailGen] = useState(false)
  const [mxTarget, setMxTarget] = useState('mail.deployhub.io')

  useEffect(() => {
    setRecords(domain.dnsRecords || [])
  }, [domain.dnsRecords])

  const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS']

  const addRecord = () => {
    setRecords([...records, { type: 'A', name: '@', value: '', ttl: 3600, priority: null }])
  }
  const updateRecord = (i: number, field: keyof DnsRecord, val: string | number) => {
    const next = [...records]
    next[i] = { ...next[i], [field]: val }
    setRecords(next)
  }
  const removeRecord = (i: number) => setRecords(records.filter((_, idx) => idx !== i))

  const generateEmailDns = () => {
    const emailRecords: DnsRecord[] = [
      { type: 'MX', name: '@', value: mxTarget, ttl: 3600, priority: 10 },
      { type: 'TXT', name: '@', value: `v=spf1 mx a:${mxTarget} ~all`, ttl: 3600 },
      { type: 'TXT', name: '_dmarc', value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain.name}`, ttl: 3600 },
      { type: 'TXT', name: 'mail._domainkey', value: 'v=DKIM1; k=rsa; p=PLACEHOLDER_REPLACE_WITH_DKIM_KEY', ttl: 3600 },
    ]
    setRecords([...records.filter((r) => !(r.type === 'MX' || r.name === '_dmarc' || r.name === 'mail._domainkey' || (r.type === 'TXT' && r.name === '@' && r.value?.startsWith('v=spf1')))), ...emailRecords])
    setShowEmailGen(false)
    toast.success('Email DNS records added', { description: 'SPF, DKIM, DMARC & MX generated' })
  }

  const save = async () => {
    setSaving(true)
    try {
      // Save via the DNS endpoint (existing route handles upsert)
      await apiFetch(`/domains/${domain.id}/dns`, {
        method: 'PUT',
        body: JSON.stringify({ records }),
      })
      toast.success('DNS records saved', { description: `${records.length} records synced to Apsamo` })
      onUpdated()
    } catch (err) {
      toast.error('Failed to save DNS', { description: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Database className="h-5 w-5 text-indigo-500" />
              DNS Records
            </CardTitle>
            <CardDescription>A, AAAA, CNAME, MX, TXT, SRV, CAA, NS</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setShowEmailGen(true)}>
            <Mail className="h-4 w-4 mr-1" /> Email DNS
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border max-h-96 overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                <TableHead className="w-24">Type</TableHead>
                <TableHead className="w-28">Name</TableHead>
                <TableHead>Value</TableHead>
                <TableHead className="w-20">TTL</TableHead>
                <TableHead className="w-16">Prio</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((r, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <Select value={r.type} onValueChange={(v) => updateRecord(i, 'type', v)}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {RECORD_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Input className="h-8 text-xs font-mono" value={r.name} onChange={(e) => updateRecord(i, 'name', e.target.value)} />
                  </TableCell>
                  <TableCell>
                    <Input className="h-8 text-xs font-mono" value={r.value} onChange={(e) => updateRecord(i, 'value', e.target.value)} />
                  </TableCell>
                  <TableCell>
                    <Input className="h-8 text-xs font-mono" type="number" value={r.ttl} onChange={(e) => updateRecord(i, 'ttl', Number(e.target.value))} />
                  </TableCell>
                  <TableCell>
                    <Input className="h-8 text-xs font-mono" type="number" value={r.priority || ''} onChange={(e) => updateRecord(i, 'priority', Number(e.target.value))} />
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => removeRecord(i)}>
                      <Trash2 className="h-3 w-3 text-red-500" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={addRecord}>
            <Plus className="h-4 w-4 mr-1" /> Add Record
          </Button>
          <Button onClick={save} disabled={saving} className="ml-auto">
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Save All Records
          </Button>
        </div>

        <Dialog open={showEmailGen} onOpenChange={setShowEmailGen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Mail className="h-5 w-5 text-indigo-500" /> Generate Email DNS Records
              </DialogTitle>
              <DialogDescription>
                Automatically adds SPF, DKIM, DMARC &amp; MX records for email delivery.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="space-y-2">
                <Label>Mail Server (MX target)</Label>
                <Input value={mxTarget} onChange={(e) => setMxTarget(e.target.value)} className="font-mono" />
              </div>
              <div className="rounded-md bg-muted/50 p-3 text-xs space-y-1">
                <div><strong>MX</strong> → {mxTarget} (priority 10)</div>
                <div><strong>SPF</strong> → v=spf1 mx a:{mxTarget} ~all</div>
                <div><strong>DMARC</strong> → v=DMARC1; p=quarantine; ...</div>
                <div><strong>DKIM</strong> → mail._domainkey (placeholder — replace with real key)</div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowEmailGen(false)}>Cancel</Button>
              <Button onClick={generateEmailDns}>Generate Records</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}

function SecuritySection({ domain, onUpdated }: { domain: Domain; onUpdated: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [authCode, setAuthCode] = useState<string | null>(null)
  const [showCode, setShowCode] = useState(false)

  const toggle = async (field: 'whoisPrivacy' | 'locked' | 'autoRenew', value: boolean) => {
    setBusy(field)
    try {
      const endpoint = field === 'whoisPrivacy' ? 'privacy' : field === 'locked' ? 'lock' : 'auto-renew'
      const bodyKey = field === 'whoisPrivacy' ? 'enabled' : field === 'locked' ? 'locked' : 'enabled'
      await apiFetch(`/domains/${domain.id}/${endpoint}`, {
        method: 'PUT',
        body: JSON.stringify({ [bodyKey]: value }),
      })
      toast.success(`${field} ${value ? 'enabled' : 'disabled'}`)
      onUpdated()
    } catch (err) {
      toast.error('Update failed', { description: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const getAuthCode = async () => {
    setBusy('authCode')
    try {
      const data = await apiFetch(`/domains/${domain.id}/auth-code`)
      setAuthCode(data.data?.authCode || null)
      setShowCode(true)
    } catch (err) {
      toast.error('Failed to get auth code', { description: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Shield className="h-5 w-5 text-indigo-500" /> Security &amp; Privacy
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <SecurityToggle
            icon={domain.whoisPrivacy ? ShieldCheck : ShieldOff}
            title="WHOIS Privacy"
            description="Hide your personal contact info from public WHOIS lookups"
            checked={domain.whoisPrivacy}
            disabled={busy === 'whoisPrivacy'}
            onToggle={(v) => toggle('whoisPrivacy', v)}
          />
          <Separator />
          <SecurityToggle
            icon={domain.locked ? Lock : Unlock}
            title="Registrar Lock"
            description="Prevent unauthorized domain transfers (recommended: ON)"
            checked={domain.locked}
            disabled={busy === 'locked'}
            onToggle={(v) => toggle('locked', v)}
          />
          <Separator />
          <SecurityToggle
            icon={RefreshCw}
            title="Auto-Renew"
            description="Automatically renew before expiration to prevent loss"
            checked={domain.autoRenew}
            disabled={busy === 'autoRenew'}
            onToggle={(v) => toggle('autoRenew', v)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <KeyRound className="h-5 w-5 text-amber-500" /> EPP / Auth Code
          </CardTitle>
          <CardDescription>Required to transfer this domain to another registrar</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {authCode && showCode ? (
            <div className="flex items-center gap-2">
              <Input value={authCode} readOnly className="font-mono" />
              <Button variant="outline" size="icon" onClick={() => { navigator.clipboard.writeText(authCode); toast.success('Auth code copied') }}>
                <Copy className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="icon" onClick={() => setShowCode(false)}>
                <EyeOff className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <Button variant="outline" onClick={getAuthCode} disabled={busy === 'authCode'}>
              {busy === 'authCode' ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <KeyRound className="h-4 w-4 mr-2" />}
              Reveal Auth Code
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            Keep this code secure. Anyone with it can initiate a transfer of your domain.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function SecurityToggle({
  icon: Icon, title, description, checked, disabled, onToggle,
}: {
  icon: React.ElementType
  title: string
  description: string
  checked: boolean
  disabled: boolean
  onToggle: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 rounded-md p-1.5 ${checked ? 'bg-indigo-500/15' : 'bg-muted'}`}>
          <Icon className={`h-4 w-4 ${checked ? 'text-indigo-500' : 'text-muted-foreground'}`} />
        </div>
        <div>
          <div className="font-medium text-sm">{title}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onToggle} />
    </div>
  )
}

function RenewTransferSection({ domain, onUpdated }: { domain: Domain; onUpdated: () => void }) {
  const [years, setYears] = useState(1)
  const [renewing, setRenewing] = useState(false)
  const [transferDomain, setTransferDomain] = useState('')
  const [transferCode, setTransferCode] = useState('')
  const [transferring, setTransferring] = useState(false)

  const renew = async () => {
    setRenewing(true)
    try {
      const data = await apiFetch('/domains/renew', {
        method: 'POST',
        body: JSON.stringify({ domainId: domain.id, duration: years }),
      })
      toast.success('Domain renewed!', {
        description: `Invoice ${data.data?.invoiceNumber || 'generated'} · ${years} year${years > 1 ? 's' : ''} added`,
      })
      onUpdated()
    } catch (err) {
      toast.error('Renewal failed', { description: (err as Error).message })
    } finally {
      setRenewing(false)
    }
  }

  const transfer = async () => {
    if (!transferDomain.trim() || !transferCode.trim()) {
      toast.error('Domain and auth code are required')
      return
    }
    setTransferring(true)
    try {
      const data = await apiFetch('/domains/transfer', {
        method: 'POST',
        body: JSON.stringify({ domain: transferDomain, authCode: transferCode }),
      })
      toast.success('Transfer initiated!', {
        description: `${data.data?.domain} — invoice ${data.data?.invoiceNumber || 'created'}`,
      })
      setTransferDomain('')
      setTransferCode('')
    } catch (err) {
      toast.error('Transfer failed', { description: (err as Error).message })
    } finally {
      setTransferring(false)
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <RefreshCw className="h-5 w-5 text-indigo-500" /> Renew Domain
          </CardTitle>
          <CardDescription>Extend the registration period</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-md bg-muted/50 p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Domain</span>
              <span className="font-medium">{domain.name}</span>
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-muted-foreground">Expires</span>
              <span className="font-medium">{domain.expiresAt ? new Date(domain.expiresAt).toLocaleDateString() : '—'}</span>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Renew for</Label>
            <Select value={String(years)} onValueChange={(v) => setYears(Number(v))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 5, 10].map((y) => <SelectItem key={y} value={String(y)}>{y} year{y > 1 ? 's' : ''}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={renew} disabled={renewing} className="w-full">
            {renewing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Renew {years} Year{years > 1 ? 's' : ''}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Send className="h-5 w-5 text-indigo-500" /> Transfer Domain
          </CardTitle>
          <CardDescription>Bring a domain from another registrar</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label>Domain to transfer</Label>
            <Input placeholder="example.com" value={transferDomain} onChange={(e) => setTransferDomain(e.target.value)} className="font-mono" />
          </div>
          <div className="space-y-2">
            <Label>EPP / Auth code</Label>
            <Input placeholder="Authorization code from current registrar" value={transferCode} onChange={(e) => setTransferCode(e.target.value)} type="password" className="font-mono" />
          </div>
          <Button onClick={transfer} disabled={transferring} className="w-full" variant="outline">
            {transferring ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" />}
            Initiate Transfer
          </Button>
          <p className="text-xs text-muted-foreground">
            Transfers typically take 5–7 days. Ensure the domain is unlocked at the current registrar.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function LogsSection({ logs }: { logs: DomainLog[] }) {
  if (logs.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          <Clock className="h-8 w-8 mx-auto mb-2 opacity-50" />
          No activity yet
        </CardContent>
      </Card>
    )
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Clock className="h-5 w-5 text-indigo-500" /> Activity Log
        </CardTitle>
        <CardDescription>Last {logs.length} events</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 max-h-96 overflow-y-auto pr-2">
          {logs.map((log) => (
            <div key={log.id} className="flex items-start gap-3 rounded-md border p-2.5 text-sm">
              <div className="mt-0.5">
                {log.status === 'success' ? (
                  <CheckCircle2 className="h-4 w-4 text-indigo-500" />
                ) : log.status === 'failed' ? (
                  <XCircle className="h-4 w-4 text-red-500" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">{log.action}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {new Date(log.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="text-xs mt-1 text-muted-foreground">{log.message}</p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Invoices Tab ─────────────────────────────────────────────────────────────

function InvoicesTab() {
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Invoice | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/invoices')
      setInvoices(data.data || [])
    } catch (err) {
      toast.error('Failed to load invoices', { description: (err as Error).message })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (loading) {
    return <div className="grid gap-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}</div>
  }

  if (selected) {
    return <InvoiceDetail invoice={selected} onBack={() => setSelected(null)} />
  }

  if (invoices.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16">
          <FileText className="h-10 w-10 text-muted-foreground mb-2" />
          <p className="text-muted-foreground">No invoices yet</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <FileText className="h-5 w-5 text-indigo-500" /> Invoices
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice #</TableHead>
                <TableHead>Domain</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((inv) => (
                <TableRow key={inv.id} className="cursor-pointer hover:bg-accent/50" onClick={() => setSelected(inv)}>
                  <TableCell className="font-mono text-sm">{inv.number}</TableCell>
                  <TableCell>{inv.domainName || '—'}</TableCell>
                  <TableCell className="text-right font-mono">${inv.total} {inv.currency}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={inv.status === 'paid' ? 'bg-indigo-500/15 text-indigo-600 border-indigo-500/30' : ''}>
                      {inv.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{new Date(inv.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost"><Download className="h-3 w-3" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

function InvoiceDetail({ invoice, onBack }: { invoice: Invoice; onBack: () => void }) {
  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="h-4 w-4 mr-1" /> Back to Invoices
      </Button>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Invoice {invoice.number}</CardTitle>
            <CardDescription>{new Date(invoice.createdAt).toLocaleDateString()}</CardDescription>
          </div>
          <Badge variant="outline" className={invoice.status === 'paid' ? 'bg-indigo-500/15 text-indigo-600 border-indigo-500/30' : ''}>
            {invoice.status}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit Price</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(invoice.items || []).map((item, i) => (
                  <TableRow key={i}>
                    <TableCell>{item.description}</TableCell>
                    <TableCell className="text-right">{item.quantity}</TableCell>
                    <TableCell className="text-right font-mono">${item.unitPrice}</TableCell>
                    <TableCell className="text-right font-mono">${item.total}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex justify-end">
            <div className="w-64 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="font-mono">${invoice.total}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span className="font-mono">$0.00</span></div>
              <Separator />
              <div className="flex justify-between font-bold text-base"><span>Total</span><span className="font-mono text-indigo-600">${invoice.total} {invoice.currency}</span></div>
            </div>
          </div>
          <Button variant="outline" onClick={() => window.print()}>
            <Download className="h-4 w-4 mr-2" /> Download Receipt
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

// ─── Pricing Tab ──────────────────────────────────────────────────────────────

interface PricingTabProps {
  isAdmin: boolean
  globalMarkup?: number | null
  onMarkupChanged?: (markup: number) => void
}

function PricingTab({ isAdmin, globalMarkup, onMarkupChanged }: PricingTabProps) {
  const [prices, setPrices] = useState<TldPrice[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [info, setInfo] = useState<{ markup: number; formula: string } | null>(null)

  // Markup editor state
  const [markupInput, setMarkupInput] = useState<string>('')
  const [savingMarkup, setSavingMarkup] = useState(false)
  const [markupConfirmOpen, setMarkupConfirmOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/pricing')
      setPrices(data.data?.tlds || [])
      const m = data.data?.markup
      setInfo({ markup: m, formula: data.data?.formula })
      if (typeof m === 'number') {
        setMarkupInput(m.toFixed(2))
      }
    } catch (err) {
      toast.error('Failed to load pricing', { description: (err as Error).message })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Keep the input in sync with the parent badge's value too.
  useEffect(() => {
    if (typeof globalMarkup === 'number' && !savingMarkup) {
      setMarkupInput(globalMarkup.toFixed(2))
    }
  }, [globalMarkup, savingMarkup])

  const sync = async () => {
    setSyncing(true)
    try {
      const data = await apiFetch('/pricing/sync', { method: 'POST' })
      toast.success('Prices synced', { description: data.message })
      load()
    } catch (err) {
      toast.error('Sync failed', { description: (err as Error).message })
    } finally {
      setSyncing(false)
    }
  }

  const saveMarkup = async () => {
    const parsed = parseFloat(markupInput)
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast.error('Invalid markup', { description: 'Enter a non-negative number, e.g. 8.50' })
      return
    }
    if (parsed > 1000) {
      toast.error('Invalid markup', { description: 'Markup must be less than $1000 USD' })
      return
    }
    setSavingMarkup(true)
    try {
      const data = await apiFetch('/pricing/markup', {
        method: 'POST',
        body: JSON.stringify({ markup: parsed }),
        headers: { 'Content-Type': 'application/json' },
      })
      const newMarkup = data.data?.markup
      toast.success('Markup updated', {
        description: data.message || `Now $${newMarkup?.toFixed(2)} — all prices recalculated`,
      })
      setMarkupConfirmOpen(false)
      if (typeof newMarkup === 'number') {
        setMarkupInput(newMarkup.toFixed(2))
        onMarkupChanged?.(newMarkup)
      }
      load() // reload the table with new prices
    } catch (err) {
      toast.error('Failed to update markup', { description: (err as Error).message })
    } finally {
      setSavingMarkup(false)
    }
  }

  const currentMarkup = typeof globalMarkup === 'number' ? globalMarkup : info?.markup
  const hasMarkupChanged =
    currentMarkup !== undefined &&
    Math.abs((parseFloat(markupInput) || 0) - currentMarkup) > 0.001

  return (
    <div className="space-y-4">
      {isAdmin && (
        <Card className="border-amber-500/30 bg-amber-50/40 dark:bg-amber-950/10">
          <CardHeader>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Sparkles className="h-5 w-5 text-amber-500" /> Global Markup
                </CardTitle>
                <CardDescription>
                  The markup (USD) added to every TLD's wholesale price. Changing
                  it instantly recalculates all selling prices.
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-mono text-sm pointer-events-none">$</span>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max="1000"
                    inputMode="decimal"
                    value={markupInput}
                    onChange={(e) => setMarkupInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && hasMarkupChanged) setMarkupConfirmOpen(true)
                    }}
                    className="w-32 pl-7 font-mono"
                    placeholder="6.50"
                    aria-label="Markup amount in USD"
                  />
                </div>
                <Button
                  size="sm"
                  onClick={() => setMarkupConfirmOpen(true)}
                  disabled={!hasMarkupChanged || savingMarkup}
                >
                  {savingMarkup ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <BadgeDollarSign className="h-4 w-4 mr-1" />}
                  Save &amp; Recalculate
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
              <div className="rounded-lg border bg-background/60 p-3">
                <div className="text-xs uppercase text-muted-foreground">Current markup</div>
                <div className="text-lg font-mono font-semibold text-amber-600 mt-1">
                  {currentMarkup !== undefined ? `$${currentMarkup.toFixed(2)}` : '—'}
                </div>
              </div>
              <div className="rounded-lg border bg-background/60 p-3">
                <div className="text-xs uppercase text-muted-foreground">Formula</div>
                <div className="text-sm font-mono mt-1 break-words">
                  {info?.formula || `Selling = Wholesale + $${currentMarkup?.toFixed(2) ?? '6.50'}`}
                </div>
              </div>
              <div className="rounded-lg border bg-background/60 p-3">
                <div className="text-xs uppercase text-muted-foreground">Affected TLDs</div>
                <div className="text-lg font-mono font-semibold mt-1">
                  {prices.length || '—'}
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Example: a <span className="font-mono">.com</span> domain with a wholesale
              of <span className="font-mono">$8.49</span> sells for{' '}
              <span className="font-mono font-semibold">
                ${currentMarkup !== undefined ? (8.49 + currentMarkup).toFixed(2) : '14.99'}
              </span>{' '}
              at the current markup.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <BadgeDollarSign className="h-5 w-5 text-indigo-500" /> Domain Pricing
              </CardTitle>
              <CardDescription>
                {info && (
                  <span className="font-mono">{info.formula}</span>
                )}
              </CardDescription>
            </div>
            {isAdmin && (
              <Button variant="outline" size="sm" onClick={sync} disabled={syncing}>
                {syncing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
                Sync Prices
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10" />)}</div>
          ) : (
            <div className="rounded-md border max-h-[60vh] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-background">
                  <TableRow>
                    <TableHead>TLD</TableHead>
                    <TableHead className="text-right">Wholesale</TableHead>
                    <TableHead className="text-right">Markup</TableHead>
                    <TableHead className="text-right">Register</TableHead>
                    <TableHead className="text-right">Renew</TableHead>
                    <TableHead className="text-right">Transfer</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {prices.map((p) => (
                    <TableRow key={p.tld}>
                      <TableCell className="font-mono font-medium">{p.tld}</TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">${p.wholesale.toFixed(2)}</TableCell>
                      <TableCell className="text-right font-mono text-amber-600">+${p.markup.toFixed(2)}</TableCell>
                      <TableCell className="text-right font-mono font-semibold text-indigo-600">${p.registration.toFixed(2)}</TableCell>
                      <TableCell className="text-right font-mono">${p.renewal.toFixed(2)}</TableCell>
                      <TableCell className="text-right font-mono">${p.transfer.toFixed(2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Markup change confirmation */}
      <AlertDialog open={markupConfirmOpen} onOpenChange={setMarkupConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change global markup?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This will change the markup from{' '}
                  <span className="font-mono font-semibold text-amber-600">
                    ${currentMarkup?.toFixed(2) ?? '—'}
                  </span>{' '}
                  to{' '}
                  <span className="font-mono font-semibold text-amber-600">
                    ${(parseFloat(markupInput) || 0).toFixed(2)}
                  </span>{' '}
                  and immediately recalculate the selling price of every TLD
                  ({prices.length} entries). Existing invoices and past orders
                  are not affected.
                </p>
                <p className="text-xs">
                  Example .com price:{' '}
                  <span className="font-mono">
                    ${(8.49 + (currentMarkup ?? 0)).toFixed(2)}
                  </span>{' '}
                  →{' '}
                  <span className="font-mono font-semibold">
                    ${(8.49 + (parseFloat(markupInput) || 0)).toFixed(2)}
                  </span>
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={savingMarkup}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                saveMarkup()
              }}
              disabled={savingMarkup}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {savingMarkup ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" /> Saving…
                </>
              ) : (
                'Confirm & Save'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─── Admin Tab ────────────────────────────────────────────────────────────────

interface AdminDomain {
  id: string
  name: string
  status: string
  registrar: string
  provider: string
  registeredAt?: string
  expiresAt?: string
  autoRenew: boolean
  whoisPrivacy: boolean
  locked: boolean
  premium: boolean
  emailHosted: boolean
  transferStatus?: string | null
  externalId?: string | null
  nameservers: string[]
  owner: { id: string; name: string; email: string }
  project: { id: string; name: string; status: string; subdomain: string } | null
  dnsRecordsCount: number
  logsCount: number
  ordersCount: number
  invoicesCount: number
  createdAt: string
}

interface DomainBreakdown {
  total: number
  active: number
  pending: number
  cancelled: number
  deleted: number
  expired: number
  transferring: number
  suspended: number
  activeWithHosting: number
}

type StatusFilter = 'all' | 'active' | 'cancelled' | 'deleted' | 'suspended' | 'expired'

function AdminTab({ onSelect }: { onSelect: (id: string) => void }) {
  const [domains, setDomains] = useState<AdminDomain[]>([])
  const [breakdown, setBreakdown] = useState<DomainBreakdown | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [suspendId, setSuspendId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (statusFilter !== 'all') params.set('status', statusFilter)
      const qs = params.toString()
      const data = await apiFetch(`/admin/domains${qs ? `?${qs}` : ''}`)
      setDomains(data.data?.domains || [])
      setBreakdown(data.data?.breakdown || null)
    } catch (err) {
      toast.error('Failed to load domains', { description: (err as Error).message })
    } finally {
      setLoading(false)
    }
  }, [search, statusFilter])

  useEffect(() => { load() }, [load])

  const suspend = async () => {
    if (!suspendId) return
    try {
      await apiFetch(`/admin/domains/${suspendId}/suspend`, { method: 'POST' })
      toast.success('Domain suspended')
      setSuspendId(null)
      load()
    } catch (err) {
      toast.error('Suspend failed', { description: (err as Error).message })
    }
  }

  const remove = async () => {
    if (!deleteId) return
    try {
      await apiFetch(`/admin/domains/${deleteId}`, { method: 'DELETE' })
      toast.success('Domain deleted')
      setDeleteId(null)
      load()
    } catch (err) {
      toast.error('Delete failed', { description: (err as Error).message })
    }
  }

  // Status badge with appropriate colour per status.
  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      active: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border-indigo-500/30',
      pending: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
      pending_verification: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
      transferring: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border-indigo-500/30',
      cancelled: 'bg-gray-500/15 text-gray-600 dark:text-gray-400 border-gray-500/30',
      expired: 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30',
      suspended: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
      deleted: 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30',
    }
    return (
      <Badge className={map[status] || 'bg-gray-500/15 text-gray-600 border-gray-500/30'} variant="outline">
        {status}
      </Badge>
    )
  }

  const formatExpiry = (iso?: string) => {
    if (!iso) return { text: '—', days: null as number | null }
    const d = new Date(iso)
    const days = Math.ceil((d.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    return { text: d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }), days }
  }

  const statusFilters: { id: StatusFilter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: breakdown?.total ?? 0 },
    { id: 'active', label: 'Active', count: breakdown?.active ?? 0 },
    { id: 'cancelled', label: 'Cancelled', count: breakdown?.cancelled ?? 0 },
    { id: 'deleted', label: 'Deleted', count: breakdown?.deleted ?? 0 },
    { id: 'suspended', label: 'Suspended', count: breakdown?.suspended ?? 0 },
    { id: 'expired', label: 'Expired', count: breakdown?.expired ?? 0 },
  ]

  const hostingCount = breakdown?.activeWithHosting ?? 0

  return (
    <div className="space-y-4">
      <IntegrationStatusCard />

      {/* Real stats summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="p-4">
          <div className="text-xs uppercase text-muted-foreground flex items-center gap-1">
            <Globe className="h-3 w-3" /> Total Domains
          </div>
          <div className="text-2xl font-bold mt-1">{breakdown?.total ?? '—'}</div>
          <div className="text-xs text-muted-foreground mt-0.5">across all users</div>
        </Card>
        <Card className="p-4 border-indigo-500/30">
          <div className="text-xs uppercase text-muted-foreground flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3 text-indigo-500" /> Active
          </div>
          <div className="text-2xl font-bold mt-1 text-indigo-600 dark:text-indigo-400">
            {breakdown?.active ?? '—'}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">live &amp; renewable</div>
        </Card>
        <Card className="p-4 border-amber-500/30">
          <div className="text-xs uppercase text-muted-foreground flex items-center gap-1">
            <Server className="h-3 w-3 text-amber-500" /> Currently Hosting
          </div>
          <div className="text-2xl font-bold mt-1 text-amber-600 dark:text-amber-400">
            {hostingCount}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">active with email or project</div>
        </Card>
        <Card className="p-4 border-red-500/30">
          <div className="text-xs uppercase text-muted-foreground flex items-center gap-1">
            <XCircle className="h-3 w-3 text-red-500" /> Inactive
          </div>
          <div className="text-2xl font-bold mt-1 text-red-600 dark:text-red-400">
            {(breakdown?.cancelled ?? 0) + (breakdown?.deleted ?? 0) + (breakdown?.expired ?? 0)}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {(breakdown?.cancelled ?? 0)} cancelled · {(breakdown?.deleted ?? 0)} deleted · {(breakdown?.expired ?? 0)} expired
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Shield className="h-5 w-5 text-indigo-500" /> All Domains (Admin)
              </CardTitle>
              <CardDescription>
                Real domain records from the database
                {breakdown ? ` — ${breakdown.total} total` : ''}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="Search domains…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-48"
              />
              <Button variant="outline" size="sm" onClick={load} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {/* Status filter pills */}
          <div className="flex flex-wrap gap-1.5 mt-2">
            {statusFilters.map((f) => (
              <button
                key={f.id}
                onClick={() => setStatusFilter(f.id)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors border ${
                  statusFilter === f.id
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground border-border hover:bg-muted'
                }`}
              >
                {f.label} <span className="opacity-70">({f.count})</span>
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : domains.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              <Globe className="h-8 w-8 mx-auto mb-2 opacity-40" />
              No domains match the current filter.
            </div>
          ) : (
            <div className="rounded-md border max-h-[60vh] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-background z-10">
                  <TableRow>
                    <TableHead>Domain</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Hosting</TableHead>
                    <TableHead>Registrar</TableHead>
                    <TableHead className="text-right">Expires</TableHead>
                    <TableHead className="text-right">DNS</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {domains.map((d) => {
                    const exp = formatExpiry(d.expiresAt)
                    return (
                      <TableRow key={d.id} className={d.status === 'deleted' || d.status === 'cancelled' ? 'opacity-60' : ''}>
                        <TableCell>
                          <button
                            className="font-medium hover:underline flex items-center gap-1.5 text-left"
                            onClick={() => onSelect(d.id)}
                          >
                            <Globe className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
                            <span className="break-all">{d.name}</span>
                            {d.premium && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Sparkles className="h-3 w-3 text-amber-500 shrink-0" />
                                  </TooltipTrigger>
                                  <TooltipContent>Premium domain</TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                          </button>
                          <div className="text-xs text-muted-foreground mt-0.5 ml-5">
                            {d.nameservers.length > 0 ? (
                              <span className="font-mono">{d.nameservers[0]}{d.nameservers.length > 1 ? ` +${d.nameservers.length - 1}` : ''}</span>
                            ) : (
                              <span>no nameservers</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm align-top">
                          <div className="font-medium">{d.owner?.name || '—'}</div>
                          <div className="text-xs text-muted-foreground">{d.owner?.email}</div>
                        </TableCell>
                        <TableCell className="align-top">{statusBadge(d.status)}</TableCell>
                        <TableCell className="align-top">
                          <div className="flex flex-col gap-1">
                            {d.emailHosted && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border-amber-500/30 w-fit" variant="outline">
                                      <Mail className="h-3 w-3 mr-1" /> Email
                                    </Badge>
                                  </TooltipTrigger>
                                  <TooltipContent>Email hosting active on this domain</TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                            {d.project && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Badge
                                      className={`w-fit border ${
                                        d.project.status === 'running'
                                          ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 border-indigo-500/30'
                                          : 'bg-gray-100 text-gray-700 dark:bg-gray-900/40 dark:text-gray-300 border-gray-500/30'
                                      }`}
                                      variant="outline"
                                    >
                                      <Server className="h-3 w-3 mr-1" /> {d.project.name}
                                    </Badge>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    Linked project: {d.project.name} ({d.project.status})
                                    <br />
                                    Subdomain: {d.project.subdomain}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                            {!d.emailHosted && !d.project && (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm align-top">
                          <span className="font-mono text-xs">{d.registrar}</span>
                          {d.locked && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Lock className="h-3 w-3 text-muted-foreground inline-block ml-1" />
                                </TooltipTrigger>
                                <TooltipContent>Registrar lock enabled</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </TableCell>
                        <TableCell className="text-right align-top">
                          <div className="text-sm">{exp.text}</div>
                          {exp.days !== null && (
                            <div className={`text-xs ${exp.days < 30 ? 'text-red-500' : exp.days < 60 ? 'text-amber-500' : 'text-muted-foreground'}`}>
                              {exp.days > 0 ? `in ${exp.days} days` : `${Math.abs(exp.days)} days ago`}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right align-top">
                          <span className="font-mono text-sm">{d.dnsRecordsCount}</span>
                          {d.logsCount > 0 && (
                            <div className="text-xs text-muted-foreground">{d.logsCount} logs</div>
                          )}
                        </TableCell>
                        <TableCell className="text-right align-top">
                          <div className="flex gap-1 justify-end">
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button size="sm" variant="ghost" onClick={() => onSelect(d.id)}>
                                    <ExternalLink className="h-3 w-3" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>View details</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            {d.status !== 'suspended' && d.status !== 'deleted' && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button size="sm" variant="ghost" onClick={() => setSuspendId(d.id)}>
                                      <Power className="h-3 w-3 text-amber-500" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>Suspend domain</TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button size="sm" variant="ghost" onClick={() => setDeleteId(d.id)}>
                                    <Trash2 className="h-3 w-3 text-red-500" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Delete record</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </div>
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

      {/* Suspend dialog */}
      <AlertDialog open={!!suspendId} onOpenChange={(o) => !o && setSuspendId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Suspend this domain?</AlertDialogTitle>
            <AlertDialogDescription>
              This will mark the domain as suspended and disable auto-renew at the registrar. The domain record is preserved for audit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={suspend} className="bg-amber-600 hover:bg-amber-700">Suspend Domain</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete dialog */}
      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this domain record?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  This permanently removes the domain record from the database.
                  The domain itself remains registered at the registrar until it
                  expires. This action cannot be undone.
                </p>
                <p className="text-xs">
                  All associated DNS records, logs, and project links will be
                  orphaned. Existing invoices are preserved for audit.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={remove}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              Delete Permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─── Domain Integration Status (live Dynadot feature verification) ────────────

interface FeatureStatus {
  id: number
  name: string
  status: 'live' | 'simulated' | 'error'
  detail: string
  lastChecked: string
}

function IntegrationStatusCard() {
  const [data, setData] = useState<{
    provider: string
    demoMode: boolean
    apiKeyConfigured: boolean
    summary: { total: number; live: number; simulated: number; error: number }
    features: FeatureStatus[]
    checkedAt: string
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)

  const load = useCallback(async () => {
    setChecking(true)
    try {
      const res = await apiFetch('/domains/status')
      setData(res.data)
    } catch (err) {
      toast.error('Failed to check integration status', {
        description: (err as Error).message,
      })
    } finally {
      setLoading(false)
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const allLive = data && data.summary.live === data.summary.total && data.summary.total > 0
  const hasErrors = data && data.summary.error > 0
  const hasSimulated = data && data.summary.simulated > 0

  const statusIcon = (s: FeatureStatus['status']) => {
    if (s === 'live') return <CheckCircle2 className="h-4 w-4 text-indigo-500" />
    if (s === 'simulated') return <XCircle className="h-4 w-4 text-amber-500" />
    return <AlertTriangle className="h-4 w-4 text-red-500" />
  }

  const statusBadge = (s: FeatureStatus['status']) => {
    if (s === 'live') return <Badge className="bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">LIVE</Badge>
    if (s === 'simulated') return <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">SIMULATED</Badge>
    return <Badge className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">ERROR</Badge>
  }

  return (
    <Card className={
      allLive
        ? 'border-indigo-500/50 bg-indigo-50/50 dark:bg-indigo-950/20'
        : hasErrors
        ? 'border-red-500/50 bg-red-50/50 dark:bg-red-950/20'
        : 'border-amber-500/50 bg-amber-50/50 dark:bg-amber-950/20'
    }>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Zap className="h-5 w-5 text-amber-500" />
              Domain Integration Status
              {allLive && (
                <Badge className="bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                  All Live
                </Badge>
              )}
              {hasErrors && (
                <Badge className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                  {data!.summary.error} Error{data!.summary.error > 1 ? 's' : ''}
                </Badge>
              )}
              {hasSimulated && (
                <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                  {data!.summary.simulated} Simulated
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="mt-1">
              {data
                ? `Provider: ${data.provider} • ${data.summary.live}/${data.summary.total} features live • Last checked ${new Date(data.checkedAt).toLocaleTimeString()}`
                : 'Live-testing all 7 domain features against the registrar API…'}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={checking}>
            {checking ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
            Re-check
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">{[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : data ? (
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead className="w-12 text-center">#</TableHead>
                  <TableHead>Feature</TableHead>
                  <TableHead className="w-32 text-center">Status</TableHead>
                  <TableHead>What&apos;s happening</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.features.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell className="text-center font-mono text-muted-foreground">{f.id}</TableCell>
                    <TableCell className="font-medium flex items-center gap-2">
                      {statusIcon(f.status)}
                      {f.name}
                    </TableCell>
                    <TableCell className="text-center">{statusBadge(f.status)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{f.detail}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">Unable to load integration status.</div>
        )}
      </CardContent>
    </Card>
  )
}
