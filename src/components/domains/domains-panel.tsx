'use client'

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiFetch, useAuthStore, ApiRequestError } from '@/store/auth-store'
import {
  Search, Globe, Plus, Trash2, RefreshCw, Shield, Clock, CheckCircle2,
  XCircle, Tag, Lock, Unlock, Copy, Loader2, AlertTriangle, ArrowLeft,
  ArrowLeftRight,
  FileText, Database, Server, Mail, KeyRound, Power, Send, Eye, EyeOff,
  ShieldCheck, ShieldOff, Sparkles, Download, ShoppingBag, Wallet,
  TrendingUp, Calendar, ExternalLink, ChevronRight, Zap, BadgeDollarSign,
} from 'lucide-react'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { DomainPricingPanel } from '@/components/admin/domain-pricing-panel'
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
import {
  availabilityOf, isPurchasable, AvailabilityBadge, AvailabilityIcon, AVAILABILITY_COPY,
  availabilityErrorMessage, domainStatusLabel, domainStatusColor, domainStatusHint,
  type AvailabilityState,
} from '@/components/domains/domain-availability'

// ─── Checkout shared pieces ───────────────────────────────────────────────────

/**
 * ICANN requires accurate registrant details on every gTLD registration, and
 * many registries reject an order outright without them — so these are
 * collected before payment rather than patched in afterwards.
 */
interface Registrant {
  firstName: string
  lastName: string
  email: string
  phone: string
  organization: string
  address1: string
  address2: string
  city: string
  state: string
  postalCode: string
  country: string
}

const EMPTY_REGISTRANT: Registrant = {
  firstName: '', lastName: '', email: '', phone: '', organization: '',
  address1: '', address2: '', city: '', state: '', postalCode: '', country: '',
}

interface PaymentMethodOption {
  method: string
  displayName: string
  icon?: string
}

/** Mirrors the server-side validation so the customer sees errors before paying. */
function validateRegistrant(r: Registrant): string | null {
  const required: Array<[keyof Registrant, string]> = [
    ['firstName', 'First name'], ['lastName', 'Last name'], ['email', 'Email'],
    ['phone', 'Phone number'], ['address1', 'Street address'], ['city', 'City'],
    ['postalCode', 'Postal code'], ['country', 'Country'],
  ]
  for (const [field, label] of required) {
    if (!r[field].trim()) return `${label} is required`
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email.trim())) {
    return 'Enter a valid email address'
  }
  if (!/^[A-Za-z]{2}$/.test(r.country.trim())) {
    return 'Country must be a 2-letter code (e.g. SO, US, GB)'
  }
  if (r.phone.replace(/\D/g, '').length < 7) {
    return 'Enter a valid phone number including country code, e.g. +252612345678'
  }
  return null
}

/** Load the gateways an admin has actually switched on, plus a live quote. */
function useDomainQuote(domain: string | null, kind: string, years: number) {
  const [methods, setMethods] = useState<PaymentMethodOption[]>([])
  const [quote, setQuote] = useState<{ unitPrice: number; total: number } | null>(null)
  const [loading, setLoading] = useState(Boolean(domain))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!domain) return
    let cancelled = false
    setLoading(true)
    setError(null)
    apiFetch(
      `/domains/checkout?domain=${encodeURIComponent(domain)}&kind=${kind}&years=${years}`
    )
      .then((data) => {
        if (cancelled) return
        setMethods(data.paymentMethods || [])
        setQuote(data.quote ? { unitPrice: data.quote.unitPrice, total: data.quote.total } : null)
      })
      .catch((err) => {
        if (cancelled) return
        setMethods([])
        setQuote(null)
        // 404 = extension not sold; 429 = slow down. Either way the customer
        // must not be able to continue to payment on a guessed price.
        setError(availabilityErrorMessage(err, 'We could not price this domain right now. Please try again.'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [domain, kind, years])

  return { methods, quote, loading, error }
}

/** Toast for a failed checkout call, keeping the server's reason visible. */
function checkoutErrorToast(err: unknown) {
  const status = err instanceof ApiRequestError ? err.status : undefined
  const description =
    status === 429
      ? 'Too many attempts in a short time. Please wait a minute and try again.'
      : (err as Error)?.message || 'Please try again.'
  toast.error(
    status === 409 ? 'This domain is already taken or ordered' : 'Could not start checkout',
    { description }
  )
}

function RegistrantFields({
  value,
  onChange,
  disabled,
}: {
  value: Registrant
  onChange: (r: Registrant) => void
  disabled?: boolean
}) {
  const set = (k: keyof Registrant) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...value, [k]: e.target.value })

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">First name *</Label>
          <Input value={value.firstName} onChange={set('firstName')} disabled={disabled} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Last name *</Label>
          <Input value={value.lastName} onChange={set('lastName')} disabled={disabled} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Email *</Label>
          <Input type="email" value={value.email} onChange={set('email')} disabled={disabled} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Phone *</Label>
          <Input
            placeholder="+252612345678"
            value={value.phone}
            onChange={set('phone')}
            disabled={disabled}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Organization (optional)</Label>
        <Input value={value.organization} onChange={set('organization')} disabled={disabled} />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Street address *</Label>
        <Input value={value.address1} onChange={set('address1')} disabled={disabled} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">City *</Label>
          <Input value={value.city} onChange={set('city')} disabled={disabled} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">State / region</Label>
          <Input value={value.state} onChange={set('state')} disabled={disabled} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Postal code *</Label>
          <Input value={value.postalCode} onChange={set('postalCode')} disabled={disabled} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Country code *</Label>
          <Input
            placeholder="SO"
            maxLength={2}
            value={value.country}
            onChange={(e) =>
              onChange({ ...value, country: e.target.value.toUpperCase().slice(0, 2) })
            }
            disabled={disabled}
          />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        These details are filed with the domain registry as required by ICANN. WHOIS
        privacy keeps them off the public record.
      </p>
    </div>
  )
}

function PaymentMethodPicker({
  methods,
  value,
  onChange,
  disabled,
}: {
  methods: PaymentMethodOption[]
  value: string
  onChange: (m: string) => void
  disabled?: boolean
}) {
  if (methods.length === 0) {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
        No payment method is currently available. Please contact support.
      </div>
    )
  }
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Payment method</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger>
          <SelectValue placeholder="Choose how to pay" />
        </SelectTrigger>
        <SelectContent>
          {methods.map((m) => (
            <SelectItem key={m.method} value={m.method}>
              {m.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * Send the customer to the gateway, or explain the next step when the method
 * settles offline (bank transfer waits on an admin confirming the money).
 */
function handleCheckoutResult(
  data: { redirectUrl?: string; status?: string; invoiceNumber?: string },
  fallbackMessage: string
) {
  if (data.redirectUrl) {
    toast.success('Redirecting to payment…')
    window.location.href = data.redirectUrl
    return
  }
  toast.success('Order created', {
    description: data.invoiceNumber
      ? `Invoice ${data.invoiceNumber} — ${fallbackMessage}`
      : fallbackMessage,
  })
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * GET /api/domains/search (envelope `data`) and each row of the bulk POST.
 * `available` is null when the registrar could not answer; prices are null
 * unless the result is available AND sellable.
 */
interface SearchResult {
  domain: string
  available: boolean | null
  premium: boolean
  status?: 'available' | 'unavailable' | 'premium' | 'unknown'
  sellable?: boolean
  registrationPrice: number | null
  renewalPrice: number | null
  transferPrice: number | null
  currency: string
  suggestions?: Array<{
    domain: string
    available: boolean | null
    premium: boolean
    status?: 'available' | 'unavailable' | 'premium' | 'unknown'
    sellable?: boolean
    registrationPrice: number | null
  }>
}

function stateOf(r: {
  status?: string
  available: boolean | null
  premium?: boolean
  sellable?: boolean
  registrationPrice: number | null
}): AvailabilityState {
  return availabilityOf({
    status: r.status,
    available: r.available,
    premium: r.premium,
    sellable: r.sellable,
    price: r.registrationPrice,
  })
}

const money = (n: number | null | undefined) =>
  typeof n === 'number' && n > 0 ? `$${n.toFixed(2)}` : '—'

interface Domain {
  id: string
  name: string
  status: string
  /**
   * 'managed'  — registered through us, sitting in our registrar account.
   *              Full registrar control available.
   * 'external' — registered at another provider and pointed here for hosting.
   *              We control DNS and hosting only; no registrar authority.
   *
   * Server-supplied: customers can't derive it, because `provider` is
   * deliberately masked to hide the upstream registrar's brand.
   */
  mode?: 'managed' | 'external'
  /**
   * What the worker last observed about whether this domain actually reaches
   * this server. Present for connected domains; null when the domain has not
   * been attached to a website yet.
   */
  connection?: {
    verified: boolean
    sslStatus: string
    zoneCreated: boolean
    method: string
    lastError?: string | null
    lastCheckedAt?: string | null
  } | null
  registrar: string
  provider: string
  registeredAt?: string
  /**
   * Registrar-held facts. Null for external domains: we cannot read them, and
   * the underlying columns are schema defaults rather than observed state.
   * Render `—`, never a confident value.
   */
  expiresAt?: string | null
  autoRenew: boolean | null
  whoisPrivacy: boolean | null
  locked: boolean | null
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

/** GET /api/domains/[id]/email-dns */
interface EmailDnsPreview {
  domain: string
  mailServer: string
  records: DnsRecord[]
  dkim: { available: true; name: string } | { available: false; reason: string; message: string }
}

interface TldPrice {
  tld: string
  // SECURITY: wholesale + markup are admin-only — optional for non-admin responses
  wholesale?: number
  markup?: number
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

type Tab = 'search' | 'domains' | 'orders' | 'invoices' | 'pricing' | 'admin'

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Domain lifecycle wording lives in domain-availability so every view agrees:
// nothing reads as registered/active until the domain actually is.
const statusColor = domainStatusColor
const statusLabel = domainStatusLabel

/**
 * One line describing how far an external domain has got toward serving from
 * this server — derived from what the worker actually observed, never from a
 * stored status string.
 */
function connectionLabel(d: Domain): string {
  const c = d.connection
  if (!c) return 'Not attached to a site'
  if (c.verified && c.zoneCreated) return 'Live'
  if (c.verified) return 'Verified, finishing setup'
  return 'Awaiting DNS change'
}

function daysUntil(dateStr?: string | null): number | null {
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

  // The markup badge is admin-only, and so is the endpoint: customers would
  // only get a 403 on every visit, so don't ask on their behalf.
  useEffect(() => {
    if (!isAdmin) return
    apiFetch('/pricing/markup')
      .then((data) => setGlobalMarkup(typeof data.data?.markup === 'number' ? data.data.markup : null))
      .catch(() => setGlobalMarkup(null))
  }, [isAdmin])

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
          {/*
            "Domain Reseller" is how WE describe the business to ourselves.
            To a customer it says we are a middleman, and "via Apsamo" is
            redundant on a page they reached by logging into Apsamo. Name the
            thing they came to do instead.
          */}
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Globe className="h-6 w-6 text-indigo-500" />
            Domains
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Search and register new domains, or connect one you already own
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Markup is the reseller margin — admin-only. Showing it to a
              customer reveals our profit on every domain (and the old
              "markup loading…" placeholder leaked into their view). */}
          {isAdmin && globalMarkup !== null && (
            <Badge variant="outline" className="w-fit" title="Editable in the Pricing tab">
              <Sparkles className="h-3 w-3 me-1 text-amber-500" />
              {`$${globalMarkup.toFixed(2)} markup applied`}
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={() => setTransferOpen(true)}>
            <Send className="h-4 w-4 me-1.5" />
            Transfer Domain
          </Button>
        </div>
      </div>

      {transferOpen && (
        <TransferDomainDialog
          onClose={() => setTransferOpen(false)}
          onTransferred={() => setTab('orders')}
        />
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className={`grid w-full grid-cols-2 h-auto ${isAdmin ? 'sm:grid-cols-6' : 'sm:grid-cols-5'}`}>
          <TabsTrigger value="search" className="flex items-center gap-1.5">
            <Search className="h-4 w-4" /> Search
          </TabsTrigger>
          <TabsTrigger value="domains" className="flex items-center gap-1.5">
            <Globe className="h-4 w-4" /> My Domains
          </TabsTrigger>
          <TabsTrigger value="orders" className="flex items-center gap-1.5">
            <ShoppingBag className="h-4 w-4" /> Orders
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
          <SearchTab onRegistered={() => setTab('orders')} />
        </TabsContent>
        <TabsContent value="domains" className="mt-6">
          <DomainsListTab onSelect={setSelectedDomainId} />
        </TabsContent>
        <TabsContent value="orders" className="mt-6">
          <OrdersTab onSearch={() => setTab('search')} onOpenDomain={setSelectedDomainId} />
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
  const [searchError, setSearchError] = useState<string | null>(null)
  const [bulkMode, setBulkMode] = useState(false)
  const [bulkQuery, setBulkQuery] = useState('')
  const [bulkResults, setBulkResults] = useState<SearchResult[]>([])
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [registering, setRegistering] = useState<string | null>(null)
  const [registerDialog, setRegisterDialog] = useState<{ domain: string; price: number } | null>(null)

  const runSearch = useCallback(async (term: string) => {
    const domain = term.trim().toLowerCase()
    if (!domain) return
    setLoading(true)
    setResult(null)
    setSearchError(null)
    try {
      const data = await apiFetch(`/domains/search?domain=${encodeURIComponent(domain)}`)
      setResult(data.data)
    } catch (err) {
      // 503 = the registrar could not confirm availability; 429 = rate limited.
      // Neither may ever read as "available" or "taken".
      setSearchError(availabilityErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const handleSearch = useCallback(() => runSearch(query), [query, runSearch])

  // Deep link from other flows (hosting checkout, email checkout):
  // /?tab=domains&register=example.com pre-fills and runs the search.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const wanted = params.get('register')
    if (!wanted) return
    // Deferred so the search starts after mount rather than as a cascading
    // render inside this effect, and so a StrictMode re-run still finds the
    // param (it is only removed once the search actually starts).
    const timer = setTimeout(() => {
      params.delete('register')
      const rest = params.toString()
      window.history.replaceState({}, '', rest ? `/?${rest}` : '/')
      setQuery(wanted)
      void runSearch(wanted)
    }, 0)
    return () => clearTimeout(timer)
  }, [runSearch])

  const handleBulkSearch = useCallback(async () => {
    const domains = bulkQuery.split('\n').map((d) => d.trim()).filter(Boolean)
    if (domains.length === 0) return
    setLoading(true)
    setBulkError(null)
    try {
      const data = await apiFetch('/domains/search', {
        method: 'POST',
        body: JSON.stringify({ domains }),
      })
      setBulkResults(data.data || [])
    } catch (err) {
      setBulkResults([])
      setBulkError(availabilityErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [bulkQuery])

  const handleRegister = async (
    domain: string,
    duration: number,
    registrant: Registrant,
    method: string
  ) => {
    setRegistering(domain)
    try {
      // Creates the order and starts payment. The registrar is not touched
      // until the gateway confirms the money.
      const data = await apiFetch('/domains/checkout', {
        method: 'POST',
        body: JSON.stringify({
          domain,
          kind: 'register',
          years: duration,
          method,
          registrant,
        }),
      })
      handleCheckoutResult(
        data,
        'It appears under My Domains once payment is confirmed and the registration completes.'
      )
      setRegisterDialog(null)
      if (!data.redirectUrl) onRegistered()
    } catch (err) {
      checkoutErrorToast(err)
    } finally {
      setRegistering(null)
    }
  }

  const bulkUnknown = bulkResults.filter((r) => stateOf(r) === 'unknown').length

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
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
              onClick={() => {
                setBulkMode(!bulkMode)
                setResult(null)
                setBulkResults([])
                setSearchError(null)
                setBulkError(null)
              }}
            >
              {bulkMode ? 'Single Search' : 'Bulk Search'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!bulkMode ? (
            <>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  void handleSearch()
                }}
              >
                <Input
                  placeholder="example.com"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="text-base"
                  aria-label="Domain name to search"
                  autoCapitalize="off"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button type="submit" disabled={loading || !query.trim()}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  Search
                </Button>
              </form>

              {loading && <SearchSkeleton />}

              {searchError && !loading && (
                <SearchErrorNotice message={searchError} onRetry={() => void handleSearch()} />
              )}

              {result && !loading && (
                <SearchResultCard
                  result={result}
                  onRegister={(domain, price) => setRegisterDialog({ domain, price })}
                  onRetry={() => void runSearch(result.domain)}
                  registering={registering}
                />
              )}
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="bulk-domains">Enter one domain per line (max 50)</Label>
                <Textarea
                  id="bulk-domains"
                  placeholder={'example.com\nmybrand.net\nawesome.io'}
                  value={bulkQuery}
                  onChange={(e) => setBulkQuery(e.target.value)}
                  rows={6}
                  className="font-mono text-sm"
                />
                <Button onClick={handleBulkSearch} disabled={loading || !bulkQuery.trim()}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  Search {bulkQuery.split('\n').filter((l) => l.trim()).length} Domains
                </Button>
              </div>

              {bulkError && !loading && (
                <SearchErrorNotice message={bulkError} onRetry={() => void handleBulkSearch()} />
              )}

              {bulkUnknown > 0 && !loading && (
                <p className="text-xs text-amber-700 dark:text-amber-400" role="status">
                  {bulkUnknown === 1 ? 'One name' : `${bulkUnknown} names`} couldn&rsquo;t be checked right now.
                  Search again in a moment to see whether {bulkUnknown === 1 ? 'it is' : 'they are'} available.
                </p>
              )}

              {bulkResults.length > 0 && (
                <div className="rounded-md border overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Domain</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-end">Register</TableHead>
                        <TableHead className="text-end">Renew</TableHead>
                        <TableHead className="text-end">Transfer</TableHead>
                        <TableHead><span className="sr-only">Actions</span></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {bulkResults.map((r) => {
                        const state = stateOf(r)
                        const buyable = state === 'available'
                        return (
                          <TableRow key={r.domain}>
                            <TableCell className="font-medium">{r.domain}</TableCell>
                            <TableCell>
                              <AvailabilityBadge state={state} />
                            </TableCell>
                            <TableCell className="text-end font-mono">
                              {buyable ? money(r.registrationPrice) : '—'}
                            </TableCell>
                            <TableCell className="text-end font-mono">
                              {buyable ? money(r.renewalPrice) : '—'}
                            </TableCell>
                            <TableCell className="text-end font-mono">
                              {buyable ? money(r.transferPrice) : '—'}
                            </TableCell>
                            <TableCell className="text-end">
                              {buyable && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setRegisterDialog({ domain: r.domain, price: r.registrationPrice! })}
                                  aria-label={`Buy ${r.domain}`}
                                >
                                  <ShoppingBag className="h-3 w-3 me-1" /> Buy
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        )
                      })}
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
          onConfirm={(duration, registrant, method) =>
            handleRegister(registerDialog.domain, duration, registrant, method)
          }
        />
      )}
    </div>
  )
}

function SearchSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-busy="true" aria-label="Checking availability">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  )
}

/** Lookup failed (registrar unreachable, rate limited, bad input). */
function SearchErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  // A typing mistake (the server answers 400 "Enter a valid domain name") is
  // not an outage: it used to appear under "Couldn't check availability" with
  // a Try again button that could never succeed.
  const invalidName = /valid domain name/i.test(message)
  return (
    <div
      role="alert"
      className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4"
    >
      <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0" aria-hidden="true" />
      <div className="flex-1 text-sm">
        <p className="font-medium">{invalidName ? 'Check the domain name' : <>Couldn&rsquo;t check availability</>}</p>
        <p className="text-muted-foreground">{message}</p>
      </div>
      {!invalidName && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5 me-1.5" /> Try again
        </Button>
      )}
    </div>
  )
}

const RESULT_FRAME: Record<AvailabilityState, string> = {
  available: 'border-indigo-500/30 bg-indigo-500/5',
  not_sold: 'border-border bg-muted/30',
  unavailable: 'border-red-500/30 bg-red-500/5',
  premium: 'border-amber-500/30 bg-amber-500/5',
  unknown: 'border-amber-500/30 bg-amber-500/5',
}

const RESULT_TEXT: Record<AvailabilityState, string> = {
  available: 'text-indigo-600 dark:text-indigo-400',
  not_sold: 'text-muted-foreground',
  unavailable: 'text-red-600 dark:text-red-400',
  premium: 'text-amber-700 dark:text-amber-400',
  unknown: 'text-amber-700 dark:text-amber-400',
}

function SearchResultCard({
  result, onRegister, onRetry, registering,
}: {
  result: SearchResult
  onRegister: (domain: string, price: number) => void
  onRetry: () => void
  registering: string | null
}) {
  const state = stateOf(result)
  const buyable = state === 'available'
  const copy = AVAILABILITY_COPY[state]

  const copyName = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success('Copied to clipboard'),
      () => toast.error('Could not copy to clipboard')
    )
  }

  return (
    <div className="space-y-4">
      <div className={`rounded-lg border p-4 ${RESULT_FRAME[state]}`} aria-live="polite">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <h3 className="text-xl font-bold break-all">{result.domain}</h3>
            <div className={`flex items-center gap-2 ${RESULT_TEXT[state]}`}>
              <AvailabilityIcon state={state} className="h-4 w-4 shrink-0" />
              <span className="text-sm font-medium">{copy.label}</span>
            </div>
            {state !== 'available' && (
              <p className="text-sm text-muted-foreground">{copy.detail}</p>
            )}
          </div>
          {buyable && (
            <div className="text-end">
              <div className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">
                {money(result.registrationPrice)}
              </div>
              <div className="text-xs text-muted-foreground">/year</div>
            </div>
          )}
        </div>

        {buyable && (
          <>
            <div className="grid grid-cols-3 gap-3 mt-4">
              <div className="rounded-md bg-background/60 p-2 text-center">
                <div className="text-xs text-muted-foreground">Register</div>
                <div className="font-semibold">{money(result.registrationPrice)}</div>
              </div>
              <div className="rounded-md bg-background/60 p-2 text-center">
                <div className="text-xs text-muted-foreground">Renew</div>
                <div className="font-semibold">{money(result.renewalPrice)}</div>
              </div>
              <div className="rounded-md bg-background/60 p-2 text-center">
                <div className="text-xs text-muted-foreground">Transfer</div>
                <div className="font-semibold">{money(result.transferPrice)}</div>
              </div>
            </div>

            <div className="flex gap-2 mt-4">
              <Button
                onClick={() => onRegister(result.domain, result.registrationPrice!)}
                disabled={registering === result.domain}
                className="flex-1"
              >
                {registering === result.domain ? (
                  <Loader2 className="h-4 w-4 animate-spin me-2" />
                ) : (
                  <ShoppingBag className="h-4 w-4 me-2" />
                )}
                Register Now
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={() => copyName(result.domain)}
                aria-label={`Copy ${result.domain}`}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </>
        )}

        {state === 'unknown' && (
          <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
            <RefreshCw className="h-3.5 w-3.5 me-1.5" /> Try again
          </Button>
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
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {result.suggestions.map((s) => {
                const sState = stateOf(s)
                const sBuyable = isPurchasable({
                  status: s.status,
                  available: s.available,
                  premium: s.premium,
                  sellable: s.sellable,
                  price: s.registrationPrice,
                })
                return (
                  <li
                    key={s.domain}
                    className="flex items-center justify-between gap-2 rounded-md border p-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <AvailabilityIcon
                        state={sState}
                        className={`h-4 w-4 shrink-0 ${sBuyable ? 'text-indigo-500' : 'text-muted-foreground'}`}
                      />
                      <span className="font-medium text-sm truncate">{s.domain}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {sBuyable ? (
                        <>
                          <span className="text-sm font-mono text-indigo-600 dark:text-indigo-400">
                            {money(s.registrationPrice)}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onRegister(s.domain, s.registrationPrice!)}
                            aria-label={`Buy ${s.domain}`}
                          >
                            Buy
                          </Button>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {AVAILABILITY_COPY[sState].label}
                        </span>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

/**
 * Domain purchase checkout.
 *
 * Collects the registration period, the ICANN registrant details and a payment
 * method, then creates an order and sends the customer to the gateway. The
 * domain is registered only after the payment clears — this dialog never
 * triggers a registrar call on its own.
 */
function RegisterDialog({
  domain, price, loading, onClose, onConfirm,
}: {
  domain: string
  price: number
  loading: boolean
  onClose: () => void
  onConfirm: (duration: number, registrant: Registrant, method: string) => void
}) {
  const [duration, setDuration] = useState(1)
  const [registrant, setRegistrant] = useState<Registrant>(EMPTY_REGISTRANT)
  const [method, setMethod] = useState('')
  const { user } = useAuthStore()
  const { methods, quote, loading: quoting, error: quoteError } = useDomainQuote(domain, 'register', duration)

  // Prefill from the signed-in account — most customers are registering in
  // their own name, and retyping an email they already gave us is friction.
  useEffect(() => {
    if (user?.email) {
      setRegistrant((r) => (r.email ? r : { ...r, email: user.email }))
    }
  }, [user?.email])

  useEffect(() => {
    if (!method && methods.length > 0) setMethod(methods[0].method)
  }, [methods, method])

  const unitPrice = quote?.unitPrice ?? price
  const total = (quote?.total ?? unitPrice * duration).toFixed(2)

  const submit = () => {
    const error = validateRegistrant(registrant)
    if (error) {
      toast.error('Check your details', { description: error })
      return
    }
    if (!method) {
      toast.error('Choose a payment method')
      return
    }
    onConfirm(duration, registrant, method)
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShoppingBag className="h-5 w-5 text-indigo-500" />
            Register {domain}
          </DialogTitle>
          <DialogDescription>
            Your domain is registered as soon as your payment is confirmed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Registration period</Label>
            <Select
              value={String(duration)}
              onValueChange={(v) => setDuration(Number(v))}
              disabled={loading}
            >
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
              <span className="font-mono">${unitPrice.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Duration</span>
              <span>{duration} year{duration > 1 ? 's' : ''}</span>
            </div>
            <Separator />
            <div className="flex justify-between font-semibold">
              <span>Total due now</span>
              <span className="text-indigo-600">${total}</span>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <Shield className="h-3.5 w-3.5 text-indigo-500" />
              Registrant details
            </Label>
            <RegistrantFields
              value={registrant}
              onChange={setRegistrant}
              disabled={loading}
            />
          </div>

          {quoteError ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs"
            >
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" aria-hidden="true" />
              <span>{quoteError}</span>
            </div>
          ) : quoting && methods.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Loading price and payment options…
            </div>
          ) : (
            <PaymentMethodPicker
              methods={methods}
              value={method}
              onChange={setMethod}
              disabled={loading || quoting}
            />
          )}

          <div className="rounded-md border border-indigo-500/30 bg-indigo-500/5 p-3 text-xs text-muted-foreground">
            Once payment clears we register the domain, point it at your nameservers,
            set up DNS, and email you the confirmation. Domain fees are
            non-refundable once the registration is placed.
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={submit} disabled={loading || quoting || !!quoteError || methods.length === 0}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <Zap className="h-4 w-4 me-2" />}
            Continue to payment (${total})
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
  const [registrant, setRegistrant] = useState<Registrant>(EMPTY_REGISTRANT)
  const [method, setMethod] = useState('')
  const { user } = useAuthStore()

  // Quote only once a plausible domain has been typed, so we aren't firing a
  // request on every keystroke of "e", "ex", "exa"…
  const quotable = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain.trim().toLowerCase())
    ? domain.trim().toLowerCase()
    : null
  const { methods, quote } = useDomainQuote(quotable, 'transfer', 1)

  useEffect(() => {
    if (user?.email) {
      setRegistrant((r) => (r.email ? r : { ...r, email: user.email }))
    }
  }, [user?.email])

  useEffect(() => {
    if (!method && methods.length > 0) setMethod(methods[0].method)
  }, [methods, method])

  const submit = async () => {
    if (!domain.trim() || !authCode.trim()) {
      toast.error('Domain and auth code are required')
      return
    }
    const error = validateRegistrant(registrant)
    if (error) {
      toast.error('Check your details', { description: error })
      return
    }
    if (!method) {
      toast.error('Choose a payment method')
      return
    }
    setTransferring(true)
    try {
      // Creates the order and starts payment; the transfer is requested at the
      // registrar only once the money is confirmed.
      const data = await apiFetch('/domains/transfer', {
        method: 'POST',
        body: JSON.stringify({
          domain: domain.trim(),
          authCode: authCode.trim(),
          registrant,
          method,
        }),
      })
      handleCheckoutResult(
        data.data || data,
        'The transfer starts as soon as payment is confirmed.'
      )
      onTransferred()
      onClose()
    } catch (err) {
      toast.error('Could not start transfer', { description: (err as Error).message })
    } finally {
      setTransferring(false)
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
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

          {quote && (
            <div className="rounded-md bg-muted/50 p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Transfer fee</span>
                <span className="font-mono">${quote.unitPrice.toFixed(2)}</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Includes one extra year added to the domain&apos;s expiry.
              </p>
              <Separator />
              <div className="flex justify-between font-semibold">
                <span>Total due now</span>
                <span className="text-indigo-600">${quote.total.toFixed(2)}</span>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <Shield className="h-3.5 w-3.5 text-indigo-500" />
              Registrant details
            </Label>
            <RegistrantFields
              value={registrant}
              onChange={setRegistrant}
              disabled={transferring}
            />
          </div>

          <PaymentMethodPicker
            methods={methods}
            value={method}
            onChange={setMethod}
            disabled={transferring}
          />

          <div className="rounded-md border border-indigo-500/30 bg-indigo-500/5 p-3 text-xs text-muted-foreground space-y-1">
            <div className="flex items-center gap-1.5 font-medium text-indigo-700 dark:text-indigo-400">
              <AlertTriangle className="h-3.5 w-3.5" />
              Before transferring
            </div>
            <ul className="list-disc list-inside space-y-0.5 ms-1">
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
          <Button
            onClick={submit}
            disabled={transferring || !domain.trim() || !authCode.trim() || methods.length === 0}
          >
            {transferring ? (
              <Loader2 className="h-4 w-4 animate-spin me-2" />
            ) : (
              <Send className="h-4 w-4 me-2" />
            )}
            Continue to payment
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
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await apiFetch('/domains')
      // Handle both array and envelope responses
      const list = Array.isArray(data) ? data : data.data || data.domains || []
      setDomains(list)
    } catch (err) {
      setLoadError((err as Error).message || 'Please try again.')
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

  if (loadError) {
    // Never fall through to "No domains yet" when we simply failed to load.
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 text-center" role="alert">
          <AlertTriangle className="h-12 w-12 text-amber-500 mb-3" aria-hidden="true" />
          <h3 className="font-semibold text-lg">Couldn&rsquo;t load your domains</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">{loadError}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5 me-1.5" /> Try again
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (domains.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <Globe className="h-12 w-12 text-muted-foreground mb-3" />
          <h3 className="font-semibold text-lg">No domains yet</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">
            Search for a domain and register it to get started. A new domain appears here once
            its payment is confirmed; until then you can follow it under Orders.
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
            role="button"
            tabIndex={0}
            aria-label={`${d.name}, ${statusLabel(d.status)}. Open details`}
            className="cursor-pointer hover:border-indigo-500/40 hover:shadow-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onSelect(d.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(d.id)
              }
            }}
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
                      {statusLabel(d.status)}
                    </Badge>
                    <ModeBadge mode={d.mode} />
                    {d.premium && (
                      <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30" variant="outline">
                        <Sparkles className="h-3 w-3 me-1" />Premium
                      </Badge>
                    )}
                  </div>
                  {domainStatusHint(d.status) && (
                    <p className="text-xs text-muted-foreground mt-2">{domainStatusHint(d.status)}</p>
                  )}
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              </div>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {d.mode === 'external' ? (
                /*
                  Expiry, lock, WHOIS privacy and auto-renew are facts held by
                  whoever registered the domain. We cannot read them, so we show
                  what we CAN observe: whether the domain actually reaches this
                  server yet.
                */
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <Globe className="h-3 w-3" /> Connection
                    </span>
                    <span>{connectionLabel(d)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <ShieldCheck className="h-3 w-3" /> SSL
                    </span>
                    <span>
                      {d.connection?.sslStatus && d.connection.sslStatus !== 'none'
                        ? d.connection.sslStatus
                        : 'Not issued yet'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <Server className="h-3 w-3" /> Registration
                    </span>
                    <span className="text-muted-foreground">At your provider</span>
                  </div>
                </>
              ) : (
                <>
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
                    <span>{d.locked == null ? '—' : d.locked ? 'Locked' : 'Unlocked'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <Shield className="h-3 w-3" /> Privacy
                    </span>
                    <span>{d.whoisPrivacy == null ? '—' : d.whoisPrivacy ? 'On' : 'Off'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <RefreshCw className="h-3 w-3" /> Auto-renew
                    </span>
                    <span>{d.autoRenew == null ? '—' : d.autoRenew ? 'On' : 'Off'}</span>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

// ─── Domain Detail ────────────────────────────────────────────────────────────

/**
 * Badge distinguishing a domain we hold at the registrar from one the customer
 * registered elsewhere and merely pointed at this server.
 */
function ModeBadge({ mode }: { mode?: 'managed' | 'external' }) {
  if (mode === 'managed') {
    return (
      <Badge variant="outline" className="bg-indigo-500/15 text-indigo-600 border-indigo-500/30 text-[10px]">
        Registered with us
      </Badge>
    )
  }
  if (mode === 'external') {
    return (
      <Badge variant="outline" className="bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30 text-[10px]">
        Connected
      </Badge>
    )
  }
  return null
}

/**
 * Shown on an external domain's detail view, in place of the registrar tabs.
 * States plainly what we can and cannot do, so nobody goes looking for a
 * renew button that was never going to work.
 */
function ExternalDomainNotice({ domain }: { domain: Domain }) {
  return (
    <Card className="border-sky-500/30 bg-sky-500/5">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="h-4 w-4 text-sky-600" />
          Connected domain
        </CardTitle>
        <CardDescription>
          {domain.name} is registered with another provider. It&apos;s connected here
          for hosting, but its registration is managed where you bought it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2 text-sm">
        <div>
          <div className="font-medium mb-1.5 flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-indigo-500" />
            You can do here
          </div>
          <ul className="list-disc list-inside space-y-0.5 text-muted-foreground text-xs">
            <li>Point it at a website on this server</li>
            <li>Manage DNS records (once delegated to our nameservers)</li>
            <li>Automatic SSL certificates</li>
          </ul>
        </div>
        <div>
          <div className="font-medium mb-1.5 flex items-center gap-1.5">
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
            Do at your registrar
          </div>
          <ul className="list-disc list-inside space-y-0.5 text-muted-foreground text-xs">
            <li>Renewals and expiry</li>
            <li>Nameserver changes</li>
            <li>Transfer lock &amp; WHOIS privacy</li>
            <li>Auth / EPP codes</li>
          </ul>
        </div>
        <p className="sm:col-span-2 text-xs text-muted-foreground">
          Want everything in one place? Transfer it in from the Domains page and
          we&apos;ll manage the registration for you.
        </p>
      </CardContent>
    </Card>
  )
}

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

  // Registrar-only tabs don't exist for an external domain. If one is selected
  // when we discover the domain is external — from a stale link, or because a
  // reconcile reclassified it — fall back to Overview rather than rendering a
  // panel of controls that will all 409.
  const isExternal = domain ? domain.mode === 'external' : false
  useEffect(() => {
    if (isExternal && (section === 'nameservers' || section === 'security' || section === 'renew')) {
      setSection('overview')
    }
  }, [isExternal, section])

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
          <ArrowLeft className="h-4 w-4 me-1" /> Back
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
                <Badge className={statusColor(domain.status)} variant="outline">{statusLabel(domain.status)}</Badge>
                <ModeBadge mode={domain.mode} />
                {/* The registrar label is only meaningful for domains we hold;
                    for external ones the mode badge already says it better. */}
                {domain.mode !== 'external' && (
                  <Badge variant="outline">{domain.registrar}</Badge>
                )}
                {domain.premium && (
                  <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30" variant="outline">
                    <Sparkles className="h-3 w-3 me-1" />Premium
                  </Badge>
                )}
              </div>
              {domainStatusHint(domain.status) && (
                <p className="text-sm text-muted-foreground mt-2">{domainStatusHint(domain.status)}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              {/*
                Expiry belongs to whoever registered the domain. For an external
                one we genuinely do not know it, so show the connection state —
                the thing we DO observe — instead of an empty date field that
                reads as "no expiry".
              */}
              {domain.mode === 'external' ? (
                <>
                  <div className="rounded-md bg-muted/50 px-3 py-2">
                    <div className="text-xs text-muted-foreground">Connection</div>
                    <div className="font-medium">{connectionLabel(domain)}</div>
                  </div>
                  <div className="rounded-md bg-muted/50 px-3 py-2">
                    <div className="text-xs text-muted-foreground">Expiry &amp; renewal</div>
                    <div className="font-medium text-muted-foreground">At your provider</div>
                  </div>
                </>
              ) : (
                <>
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
                </>
              )}
            </div>
          </div>
        </CardHeader>
      </Card>

      {/*
        External domains are registered somewhere else. Nameservers, transfer
        lock, WHOIS privacy, auto-renew, auth codes and renewal are all
        registrar operations we cannot perform on them — the API now refuses
        with a 409, so showing the controls would only produce dead buttons.
      */}
      {isExternal && <ExternalDomainNotice domain={domain} />}

      <Tabs value={section} onValueChange={(v) => setSection(v as typeof section)}>
        <TabsList className={`grid w-full h-auto ${isExternal ? 'grid-cols-3' : 'grid-cols-3 sm:grid-cols-6'}`}>
          <TabsTrigger value="overview" className="text-xs">Overview</TabsTrigger>
          {!isExternal && (
            <TabsTrigger value="nameservers" className="text-xs">Nameservers</TabsTrigger>
          )}
          <TabsTrigger value="dns" className="text-xs">DNS</TabsTrigger>
          {!isExternal && (
            <>
              <TabsTrigger value="security" className="text-xs">Security</TabsTrigger>
              <TabsTrigger value="renew" className="text-xs">Renew/Transfer</TabsTrigger>
            </>
          )}
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
  // Auto-renew, WHOIS privacy and registrar lock are facts held by whoever
  // registered the domain. For an external one we cannot read them — the
  // columns hold schema defaults — so report the connection instead of
  // presenting a default as if it were observed state.
  const stats =
    domain.mode === 'external'
      ? [
          { label: 'Status', value: statusLabel(domain.status), icon: Globe, color: 'text-indigo-500' },
          { label: 'Connection', value: connectionLabel(domain), icon: Server, color: 'text-sky-500' },
          {
            label: 'SSL',
            value:
              domain.connection?.sslStatus && domain.connection.sslStatus !== 'none'
                ? domain.connection.sslStatus
                : 'Not issued yet',
            icon: ShieldCheck,
            color: 'text-indigo-500',
          },
          { label: 'Registration', value: 'At your provider', icon: ExternalLink, color: 'text-muted-foreground' },
        ]
      : [
          { label: 'Status', value: statusLabel(domain.status), icon: Globe, color: 'text-indigo-500' },
          { label: 'Registrar', value: domain.registrar, icon: Server, color: 'text-indigo-500' },
          { label: 'Auto-Renew', value: domain.autoRenew == null ? '—' : domain.autoRenew ? 'Enabled' : 'Disabled', icon: RefreshCw, color: domain.autoRenew ? 'text-indigo-500' : 'text-muted-foreground' },
          { label: 'WHOIS Privacy', value: domain.whoisPrivacy == null ? '—' : domain.whoisPrivacy ? 'Enabled' : 'Disabled', icon: Shield, color: domain.whoisPrivacy ? 'text-indigo-500' : 'text-muted-foreground' },
          { label: 'Registrar Lock', value: domain.locked == null ? '—' : domain.locked ? 'Locked' : 'Unlocked', icon: Lock, color: domain.locked ? 'text-indigo-500' : 'text-amber-500' },
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
              <Plus className="h-4 w-4 me-1" /> Add Nameserver
            </Button>
          )}
          <Button onClick={save} disabled={saving} className="ms-auto">
            {saving ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <RefreshCw className="h-4 w-4 me-2" />}
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
  // Empty = use the server's configured mail host (MAIL_SERVER_HOSTNAME).
  const [mxTarget, setMxTarget] = useState('')
  const [emailDns, setEmailDns] = useState<EmailDnsPreview | null>(null)
  const [emailDnsLoading, setEmailDnsLoading] = useState(false)
  const [emailDnsError, setEmailDnsError] = useState<string | null>(null)

  // Load the real records whenever the dialog is open and the MX host changes
  // (debounced). DKIM comes from Mailcow, so only the server can produce it.
  useEffect(() => {
    if (!showEmailGen) return
    let cancelled = false
    setEmailDnsLoading(true)
    const timer = setTimeout(async () => {
      try {
        const qs = mxTarget.trim() ? `?mx=${encodeURIComponent(mxTarget.trim())}` : ''
        const data = await apiFetch<EmailDnsPreview>(`/domains/${domain.id}/email-dns${qs}`)
        if (cancelled) return
        setEmailDns(data)
        setEmailDnsError(null)
        if (!mxTarget.trim()) setMxTarget(data.mailServer)
      } catch (err) {
        if (cancelled) return
        setEmailDns(null)
        setEmailDnsError((err as Error).message)
      } finally {
        if (!cancelled) setEmailDnsLoading(false)
      }
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [showEmailGen, mxTarget, domain.id])

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
    if (!emailDns) return
    const withDkim = emailDns.dkim.available
    const isDkim = (r: DnsRecord) => /(^|\.)_domainkey$/.test(r.name)
    setRecords([
      ...records.filter(
        (r) =>
          !(
            r.type === 'MX' ||
            r.name === '_dmarc' ||
            (r.type === 'TXT' && r.name === '@' && r.value?.startsWith('v=spf1')) ||
            // Replace DKIM only with a real key; always drop a placeholder
            // that an older version of this screen may have saved.
            (isDkim(r) && (withDkim || r.value?.includes('PLACEHOLDER')))
          )
      ),
      ...emailDns.records,
    ])
    setShowEmailGen(false)
    if (emailDns.dkim.available) {
      toast.success('Email DNS records added', { description: 'MX, SPF, DMARC and DKIM. Save to publish them.' })
    } else {
      toast.warning('MX, SPF and DMARC added — DKIM skipped', { description: emailDns.dkim.message })
    }
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
            <Mail className="h-4 w-4 me-1" /> Email DNS
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
            <Plus className="h-4 w-4 me-1" /> Add Record
          </Button>
          <Button onClick={save} disabled={saving} className="ms-auto">
            {saving ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <RefreshCw className="h-4 w-4 me-2" />}
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
                Adds MX, SPF and DMARC records, plus DKIM when this domain has a key on the mail server.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="space-y-2">
                <Label htmlFor="email-dns-mx">Mail Server (MX target)</Label>
                <Input
                  id="email-dns-mx"
                  value={mxTarget}
                  onChange={(e) => setMxTarget(e.target.value)}
                  placeholder="mail.example.com"
                  className="font-mono"
                />
              </div>
              <div className="rounded-md bg-muted/50 p-3 text-xs space-y-1 min-h-[5.5rem]" aria-live="polite">
                {emailDnsLoading && !emailDns ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading records…
                  </div>
                ) : emailDnsError ? (
                  <div className="flex items-start gap-2 text-destructive">
                    <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {emailDnsError}
                  </div>
                ) : emailDns ? (
                  <>
                    {emailDns.records.map((r) => (
                      <div key={`${r.type}-${r.name}`} className="break-all">
                        <strong>{r.type}</strong> {r.name} → <span className="font-mono">{r.value}</span>
                        {r.priority ? ` (priority ${r.priority})` : ''}
                      </div>
                    ))}
                  </>
                ) : null}
              </div>
              {emailDns && !emailDnsError && (
                emailDns.dkim.available ? (
                  <div className="flex items-start gap-2 text-xs text-muted-foreground">
                    <ShieldCheck className="h-3.5 w-3.5 mt-0.5 shrink-0 text-indigo-500" />
                    DKIM uses this domain&apos;s real key from the mail server.
                  </div>
                ) : (
                  <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 p-2.5 text-xs text-amber-800 dark:text-amber-300">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                      <strong>No DKIM record will be added.</strong> {emailDns.dkim.message}
                    </span>
                  </div>
                )
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowEmailGen(false)}>Cancel</Button>
              <Button onClick={generateEmailDns} disabled={!emailDns || !!emailDnsError || emailDnsLoading}>
                {emailDnsLoading && <Loader2 className="h-4 w-4 animate-spin me-2" />}
                Add Records
              </Button>
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
            checked={domain.whoisPrivacy ?? false}
            disabled={busy === 'whoisPrivacy'}
            onToggle={(v) => toggle('whoisPrivacy', v)}
          />
          <Separator />
          <SecurityToggle
            icon={domain.locked ? Lock : Unlock}
            title="Registrar Lock"
            description="Prevent unauthorized domain transfers (recommended: ON)"
            checked={domain.locked ?? false}
            disabled={busy === 'locked'}
            onToggle={(v) => toggle('locked', v)}
          />
          <Separator />
          <SecurityToggle
            icon={RefreshCw}
            title="Auto-Renew"
            description="Automatically renew before expiration to prevent loss"
            checked={domain.autoRenew ?? false}
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
              {busy === 'authCode' ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <KeyRound className="h-4 w-4 me-2" />}
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
  const [renewMethod, setRenewMethod] = useState('')
  const { methods, quote } = useDomainQuote(domain.name, 'renew', years)

  useEffect(() => {
    if (!renewMethod && methods.length > 0) setRenewMethod(methods[0].method)
  }, [methods, renewMethod])

  const renew = async () => {
    if (!renewMethod) {
      toast.error('Choose a payment method')
      return
    }
    setRenewing(true)
    try {
      // Orders the renewal and starts payment; the registrar is called once
      // the money is confirmed.
      const data = await apiFetch('/domains/renew', {
        method: 'POST',
        body: JSON.stringify({
          domainId: domain.id,
          duration: years,
          method: renewMethod,
        }),
      })
      handleCheckoutResult(
        data.data || data,
        'The renewal applies as soon as payment is confirmed.'
      )
      onUpdated()
    } catch (err) {
      toast.error('Could not start renewal', { description: (err as Error).message })
    } finally {
      setRenewing(false)
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
          {quote && (
            <div className="rounded-md bg-muted/50 p-3 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Renewal / year</span>
                <span className="font-mono">${quote.unitPrice.toFixed(2)}</span>
              </div>
              <Separator />
              <div className="flex justify-between font-semibold">
                <span>Total due now</span>
                <span className="text-indigo-600">${quote.total.toFixed(2)}</span>
              </div>
            </div>
          )}
          <PaymentMethodPicker
            methods={methods}
            value={renewMethod}
            onChange={setRenewMethod}
            disabled={renewing}
          />
          <Button
            onClick={renew}
            disabled={renewing || methods.length === 0}
            className="w-full"
          >
            {renewing ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <RefreshCw className="h-4 w-4 me-2" />}
            {quote
              ? `Continue to payment ($${quote.total.toFixed(2)})`
              : `Renew ${years} year${years > 1 ? 's' : ''}`}
          </Button>
        </CardContent>
      </Card>

      {/*
        This panel is scoped to a domain the customer already owns, so the
        useful transfer action here is the outbound one. Bringing a NEW domain
        in is a purchase and lives in the Transfer Domain dialog on the main
        Domains page, where registrant details and payment are collected.
      */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Send className="h-5 w-5 text-indigo-500" /> Transfer Away
          </CardTitle>
          <CardDescription>Move {domain.name} to another registrar</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ol className="list-decimal list-inside space-y-1.5 text-muted-foreground">
            <li>Unlock the domain on the <span className="font-medium text-foreground">Security</span> tab.</li>
            <li>Disable WHOIS privacy there as well.</li>
            <li>Copy the auth (EPP) code from the Security tab.</li>
            <li>Start the transfer at your new registrar using that code.</li>
          </ol>
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
            Registry rules block transfers within 60 days of registration or a
            previous transfer. Any time left on the registration moves with the
            domain.
          </div>
          <p className="text-xs text-muted-foreground">
            Want to bring a different domain <span className="font-medium">in</span>? Use
            Transfer Domain at the top of the Domains page.
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
        <div className="space-y-2 max-h-96 overflow-y-auto pe-2">
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

// ─── Orders Tab ───────────────────────────────────────────────────────────────

/** One row of GET /api/domains/orders. */
interface DomainOrderItem {
  id: string
  domainName: string
  kind: 'register' | 'renew' | 'transfer'
  years: number
  status: string
  amount: number
  currency: string
  invoiceId: string | null
  invoiceNumber: string | null
  invoicePaid: boolean
  domainId: string | null
  domainActive: boolean
  payment: {
    method: 'stripe' | 'waafi' | 'manual' | null
    payUrl: string | null
    reference: string | null
    instructions: string | null
  } | null
  message: string
  createdAt: string
  updatedAt: string
}

const ORDER_KIND_LABEL: Record<DomainOrderItem['kind'], string> = {
  register: 'Registration',
  renew: 'Renewal',
  transfer: 'Transfer',
}

/** Finished orders: kept as history, collapsed below the ones still moving. */
const SETTLED_ORDER_STATUSES = new Set(['completed', 'cancelled'])

const ORDERS_PAGE_SIZE = 20

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

interface OrdersPage {
  orders: DomainOrderItem[]
  nextCursor: string | null
}

function fetchOrdersPage(cursor: string | null): Promise<OrdersPage> {
  const qs = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
  return apiFetch<OrdersPage>(`/domains/orders?limit=${ORDERS_PAGE_SIZE}${qs}`)
}

function OrdersTab({
  onSearch,
  onOpenDomain,
}: {
  onSearch: () => void
  onOpenDomain: (id: string) => void
}) {
  const [orders, setOrders] = useState<DomainOrderItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  // Applies a first-page result. Only ever called after the request settles,
  // so the initial effect never sets state synchronously.
  const applyFirstPage = useCallback((result: Promise<OrdersPage>, isCurrent: () => boolean) => {
    result
      .then((data) => {
        if (!isCurrent()) return
        setOrders(data.orders || [])
        setNextCursor(data.nextCursor ?? null)
        setLoadError(null)
      })
      .catch((err) => {
        if (isCurrent()) setLoadError((err as Error).message || 'Please try again.')
      })
      .finally(() => {
        if (isCurrent()) setLoading(false)
      })
  }, [])

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    applyFirstPage(fetchOrdersPage(null), () => true)
  }, [applyFirstPage])

  const loadMore = useCallback(async () => {
    if (!nextCursor) return
    setLoadingMore(true)
    try {
      const data = await fetchOrdersPage(nextCursor)
      setOrders((prev) => {
        const seen = new Set(prev.map((o) => o.id))
        return [...prev, ...(data.orders || []).filter((o) => !seen.has(o.id))]
      })
      setNextCursor(data.nextCursor ?? null)
    } catch (err) {
      toast.error('Could not load more orders', { description: (err as Error).message })
    } finally {
      setLoadingMore(false)
    }
  }, [nextCursor])

  useEffect(() => {
    let current = true
    applyFirstPage(fetchOrdersPage(null), () => current)
    return () => {
      current = false
    }
  }, [applyFirstPage])

  if (loading) {
    return (
      <div className="space-y-3" role="status" aria-busy="true" aria-label="Loading orders">
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}
      </div>
    )
  }

  if (loadError) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 text-center" role="alert">
          <AlertTriangle className="h-12 w-12 text-amber-500 mb-3" aria-hidden="true" />
          <h3 className="font-semibold text-lg">Couldn&rsquo;t load your orders</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">{loadError}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => load()}>
            <RefreshCw className="h-3.5 w-3.5 me-1.5" aria-hidden="true" /> Try again
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (orders.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <ShoppingBag className="h-12 w-12 text-muted-foreground mb-3" aria-hidden="true" />
          <h3 className="font-semibold text-lg">No domain orders yet</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">
            When you register, renew or transfer a domain, the order shows up here straight
            away, so you can follow it from payment to the domain going live.
          </p>
          <Button size="sm" className="mt-4" onClick={onSearch}>
            <Search className="h-3.5 w-3.5 me-1.5" aria-hidden="true" /> Find a domain
          </Button>
        </CardContent>
      </Card>
    )
  }

  const open = orders.filter((o) => !SETTLED_ORDER_STATUSES.has(o.status))
  const settled = orders.filter((o) => SETTLED_ORDER_STATUSES.has(o.status))

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-lg">
              <ShoppingBag className="h-5 w-5 text-indigo-500" aria-hidden="true" /> Orders
            </CardTitle>
            <CardDescription className="mt-1">
              Orders that are awaiting payment or still being processed.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => load()} aria-label="Refresh orders">
            <RefreshCw className="h-3.5 w-3.5 sm:me-1.5" aria-hidden="true" />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </CardHeader>
        <CardContent>
          {open.length === 0 ? (
            <p className="flex items-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-indigo-500 shrink-0" aria-hidden="true" />
              Nothing in progress. Your finished orders are listed under Order history.
            </p>
          ) : (
            <ul className="divide-y rounded-md border" aria-label="Orders in progress">
              {open.map((o) => (
                <OrderListItem key={o.id} order={o} onOpenDomain={onOpenDomain} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {settled.length > 0 && (
        <Card>
          <CardHeader className="py-0">
            <h3 className="m-0">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-md py-4 text-start font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={historyOpen}
                aria-controls="domain-order-history"
                onClick={() => setHistoryOpen((v) => !v)}
              >
                <span className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  Order history
                  <Badge variant="outline" className="font-normal">{settled.length}</Badge>
                </span>
                <ChevronRight
                  className={`h-4 w-4 text-muted-foreground transition-transform ${historyOpen ? 'rotate-90' : ''}`}
                  aria-hidden="true"
                />
              </button>
            </h3>
          </CardHeader>
          <CardContent id="domain-order-history" hidden={!historyOpen} className="pt-0">
            <ul className="divide-y rounded-md border" aria-label="Order history">
              {settled.map((o) => (
                <OrderListItem key={o.id} order={o} onOpenDomain={onOpenDomain} compact />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {nextCursor && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? (
              <Loader2 className="h-3.5 w-3.5 me-1.5 animate-spin" aria-hidden="true" />
            ) : null}
            {loadingMore ? 'Loading…' : 'Load older orders'}
          </Button>
        </div>
      )}
    </div>
  )
}

function OrderListItem({
  order,
  onOpenDomain,
  compact = false,
}: {
  order: DomainOrderItem
  onOpenDomain: (id: string) => void
  compact?: boolean
}) {
  const created = new Date(order.createdAt)
  const yearsLabel = `${order.years} year${order.years === 1 ? '' : 's'}`
  const awaitingPayment = order.status === 'pending_payment' && !order.invoicePaid
  const payment = order.payment

  const copyReference = async (ref: string) => {
    try {
      await navigator.clipboard.writeText(ref)
      toast.success('Payment reference copied')
    } catch {
      toast.error('Could not copy. Select the reference and copy it manually.')
    }
  }

  return (
    <li className={compact ? 'p-3' : 'p-4'}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 space-y-1">
          <p className="font-medium break-all flex items-center gap-2">
            <Globe className="h-4 w-4 text-indigo-500 shrink-0" aria-hidden="true" />
            {order.domainName}
          </p>
          <p className="text-xs text-muted-foreground">
            {ORDER_KIND_LABEL[order.kind]} · {yearsLabel} · Ordered{' '}
            <time dateTime={order.createdAt}>{created.toLocaleDateString()}</time>
          </p>
        </div>
        <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-1">
          <Badge variant="outline" className={statusColor(order.status)}>
            {statusLabel(order.status)}
          </Badge>
          <span className="font-mono text-sm">{formatMoney(order.amount, order.currency)}</span>
        </div>
      </div>

      <p className={`text-sm text-muted-foreground ${compact ? 'mt-1' : 'mt-2'}`}>{order.message}</p>

      {awaitingPayment && payment?.method === 'manual' && payment.reference && (
        <div className="mt-3 rounded-md border bg-muted/30 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Payment reference</span>
            <code className="font-mono font-medium break-all">{payment.reference}</code>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => void copyReference(payment.reference as string)}
              aria-label={`Copy payment reference ${payment.reference}`}
            >
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
          {payment.instructions && (
            <p className="mt-2 text-xs text-muted-foreground whitespace-pre-line">
              {payment.instructions}
            </p>
          )}
        </div>
      )}

      {(awaitingPayment && payment?.payUrl) || order.invoiceId || (order.domainId && order.domainActive) ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {awaitingPayment && payment?.payUrl && (
            <Button asChild size="sm">
              <a href={payment.payUrl}>
                <Wallet className="h-3.5 w-3.5 me-1.5" aria-hidden="true" />
                Pay {formatMoney(order.amount, order.currency)}
                <span className="sr-only"> for {order.domainName}</span>
              </a>
            </Button>
          )}
          {order.invoiceId && (
            <Button asChild size="sm" variant="outline">
              <a href={`/api/invoices/${order.invoiceId}/pdf`} target="_blank" rel="noopener noreferrer">
                <FileText className="h-3.5 w-3.5 me-1.5" aria-hidden="true" />
                {order.invoiceNumber ? `Invoice ${order.invoiceNumber}` : 'Invoice'}
                {order.invoicePaid ? ' (paid)' : ''}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
          )}
          {order.domainId && order.domainActive && (
            <Button size="sm" variant="ghost" onClick={() => onOpenDomain(order.domainId as string)}>
              Manage domain
              <ChevronRight className="h-3.5 w-3.5 ms-1" aria-hidden="true" />
            </Button>
          )}
        </div>
      ) : null}
    </li>
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
                <TableHead className="text-end">Amount</TableHead>
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
                  <TableCell className="text-end font-mono">${inv.total} {inv.currency}</TableCell>
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
        <ArrowLeft className="h-4 w-4 me-1" /> Back to Invoices
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
                  <TableHead className="text-end">Qty</TableHead>
                  <TableHead className="text-end">Unit Price</TableHead>
                  <TableHead className="text-end">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(invoice.items || []).map((item, i) => (
                  <TableRow key={i}>
                    <TableCell>{item.description}</TableCell>
                    <TableCell className="text-end">{item.quantity}</TableCell>
                    <TableCell className="text-end font-mono">${item.unitPrice}</TableCell>
                    <TableCell className="text-end font-mono">${item.total}</TableCell>
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
            <Download className="h-4 w-4 me-2" /> Download Receipt
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

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/pricing')
      setPrices(data.data?.tlds || [])
      const m = data.data?.markup
      setInfo({ markup: m, formula: data.data?.formula })
    } catch (err) {
      toast.error('Failed to load pricing', { description: (err as Error).message })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

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


  const currentMarkup = typeof globalMarkup === 'number' ? globalMarkup : info?.markup

  return (
    <div className="space-y-4">
      {/* Admin pricing controls: markups and discounts per action.
          Replaces the old single Global Markup card — two markup editors
          on one page, with one of them only a fallback for the other, is
          how the wrong field gets edited and silently does nothing. */}
      {isAdmin && <DomainPricingPanel />}

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
                {syncing ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <RefreshCw className="h-4 w-4 me-1" />}
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
                    {/* SECURITY: hide Wholesale + Markup columns from non-admin customers — M7 */}
                    {isAdmin && <TableHead className="text-end">Wholesale</TableHead>}
                    {isAdmin && <TableHead className="text-end">Markup</TableHead>}
                    <TableHead className="text-end">Register</TableHead>
                    <TableHead className="text-end">Renew</TableHead>
                    <TableHead className="text-end">Transfer</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {prices.map((p) => (
                    <TableRow key={p.tld}>
                      <TableCell className="font-mono font-medium">{p.tld}</TableCell>
                      {isAdmin && (
                        <TableCell className="text-end font-mono text-muted-foreground">
                          ${p.wholesale?.toFixed(2) ?? '—'}
                        </TableCell>
                      )}
                      {isAdmin && (
                        <TableCell className="text-end font-mono text-amber-600">
                          +${p.markup?.toFixed(2) ?? '—'}
                        </TableCell>
                      )}
                      <TableCell className="text-end font-mono font-semibold text-indigo-600">${p.registration.toFixed(2)}</TableCell>
                      <TableCell className="text-end font-mono">${p.renewal.toFixed(2)}</TableCell>
                      <TableCell className="text-end font-mono">${p.transfer.toFixed(2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Markup change confirmation */}
    </div>
  )
}

// ─── Admin Tab ────────────────────────────────────────────────────────────────

interface TransferDetail {
  orderId: string
  status: string
  failedReason?: string
  transferType: 'in' | 'away'
  submittedDate?: string
  cost?: string
  paymentMethod?: string
}

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
  project: { id: string; name: string; status: string; domain: string | null } | null
  dnsRecordsCount: number
  logsCount: number
  ordersCount: number
  invoicesCount: number
  createdAt: string
  transferDetail: TransferDetail | null
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

interface SyncInfo {
  synced: number
  purged: number
  transfers: number
  error?: string
  source: string
}

type StatusFilter = 'all' | 'active' | 'transferring' | 'cancelled' | 'deleted' | 'suspended' | 'expired'

interface ReconcileFinding {
  id: string
  name: string
  verdict: 'confirmed' | 'demoted' | 'subdomain'
  reason: string
}

interface ReconcileReport {
  dryRun: boolean
  registrarDomainCount: number
  checked: number
  confirmed: number
  reclassified: number
  repaired: number
  findings: ReconcileFinding[]
}

/**
 * Compares what the panel claims about domain ownership against the registrar's
 * actual inventory. Always previews first — it rewrites ownership on live
 * customer records, so "apply" is a second, deliberate click.
 */
function ReconcileDialog({
  report,
  applying,
  onApply,
  onClose,
}: {
  report: ReconcileReport
  applying: boolean
  onApply: () => void
  onClose: () => void
}) {
  const verdictStyle = (v: ReconcileFinding['verdict']) =>
    v === 'confirmed'
      ? 'bg-indigo-500/15 text-indigo-600 border-indigo-500/30'
      : 'bg-amber-500/15 text-amber-600 border-amber-500/30'

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-indigo-500" />
            Ownership reconciliation
          </DialogTitle>
          <DialogDescription>
            {report.dryRun
              ? `Preview — nothing has been changed. Checked ${report.checked} domain${report.checked === 1 ? '' : 's'} against ${report.registrarDomainCount} in the registrar account.`
              : `Applied. ${report.reclassified} reclassified as external, ${report.repaired} registrar id${report.repaired === 1 ? '' : 's'} restored.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          {report.findings.map((f) => (
            <div key={f.id} className="rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm truncate">{f.name}</span>
                <Badge variant="outline" className={`${verdictStyle(f.verdict)} text-[10px] flex-shrink-0`}>
                  {f.verdict === 'confirmed'
                    ? 'ours'
                    : f.verdict === 'subdomain'
                    ? 'subdomain'
                    : 'external'}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{f.reason}</p>
            </div>
          ))}
          {report.findings.length === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Nothing claims registrar ownership. Nothing to reconcile.
            </p>
          )}
        </div>

        {report.dryRun && report.reclassified > 0 && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
            Applying clears the stored expiry and auto-renew on reclassified
            domains — those values were defaults we never verified, and leaving
            them drives false renewal reminders. Hosting and DNS are untouched.
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={applying}>
            {report.dryRun ? 'Cancel' : 'Close'}
          </Button>
          {report.dryRun && report.findings.length > 0 && (
            <Button onClick={onApply} disabled={applying}>
              {applying ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : null}
              Apply changes
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AdminTab({ onSelect }: { onSelect: (id: string) => void }) {
  const [domains, setDomains] = useState<AdminDomain[]>([])
  const [breakdown, setBreakdown] = useState<DomainBreakdown | null>(null)
  const [sync, setSync] = useState<SyncInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [suspendId, setSuspendId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [reconciling, setReconciling] = useState(false)
  const [reconcileReport, setReconcileReport] = useState<ReconcileReport | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (statusFilter !== 'all') params.set('status', statusFilter)
      // sync=true (default) forces a live call to Dynadot's list_domain API.
      const qs = params.toString()
      const data = await apiFetch(`/admin/domains${qs ? `?${qs}` : ''}`)
      setDomains(data.data?.domains || [])
      setBreakdown(data.data?.breakdown || null)
      setSync(data.data?.sync || null)
    } catch (err) {
      toast.error('Failed to load domains', { description: (err as Error).message })
    } finally {
      setLoading(false)
    }
  }, [search, statusFilter])

  useEffect(() => { load() }, [load])

  const runReconcile = async (dryRun: boolean) => {
    setReconciling(true)
    try {
      const data = await apiFetch('/admin/domains/reconcile', {
        method: 'POST',
        body: JSON.stringify({ dryRun }),
      })
      setReconcileReport(data.data as ReconcileReport)
      if (!dryRun) {
        toast.success('Ownership reconciled', { description: data.message })
        load()
      }
    } catch (err) {
      toast.error('Reconcile failed', { description: (err as Error).message })
    } finally {
      setReconciling(false)
    }
  }

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
      active: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
      pending: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
      pending_verification: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
      transferring: 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30',
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
    { id: 'transferring', label: 'Transferring', count: breakdown?.transferring ?? 0 },
    { id: 'cancelled', label: 'Cancelled', count: breakdown?.cancelled ?? 0 },
    { id: 'deleted', label: 'Deleted', count: breakdown?.deleted ?? 0 },
    { id: 'suspended', label: 'Suspended', count: breakdown?.suspended ?? 0 },
    { id: 'expired', label: 'Expired', count: breakdown?.expired ?? 0 },
  ]

  const hostingCount = breakdown?.activeWithHosting ?? 0

  return (
    <div className="space-y-4">
      <IntegrationStatusCard />

      {/*
        Ownership reconciliation. Registrar-backed ownership is decided by
        `externalId`, and rows predating that — or created by flows that never
        set it — misreport in both directions: someone else's domain looking
        like ours, and ours looking external. This compares against the live
        registrar inventory and repairs both.
      */}
      <Card className="p-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="text-sm font-medium flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-indigo-500" />
              Verify domain ownership
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Check every domain marked as registered with us against the
              registrar&apos;s actual account. Previews before changing anything.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => runReconcile(true)}
            disabled={reconciling}
          >
            {reconciling ? (
              <Loader2 className="h-4 w-4 animate-spin me-1.5" />
            ) : (
              <ShieldCheck className="h-4 w-4 me-1.5" />
            )}
            Check ownership
          </Button>
        </div>
      </Card>

      {reconcileReport && (
        <ReconcileDialog
          report={reconcileReport}
          applying={reconciling}
          onApply={() => runReconcile(false)}
          onClose={() => setReconcileReport(null)}
        />
      )}

      {/* Sync status banner — shows the result of the last Dynadot API call */}
      {sync && (
        <Card className={`p-3 ${sync.error ? 'border-amber-500/40 bg-amber-50/50 dark:bg-amber-950/20' : 'border-emerald-500/40 bg-emerald-50/50 dark:bg-emerald-950/20'}`}>
          <div className="flex items-center gap-2 text-sm flex-wrap">
            {sync.error ? (
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
            )}
            <span className="font-medium">
              {sync.error
                ? 'Dynadot sync failed — showing cached DB data'
                : `Live from Dynadot API`}
            </span>
            <span className="text-muted-foreground">
              {sync.error
                ? sync.error
                : [
                    `${sync.synced} registered`,
                    sync.transfers > 0 ? `${sync.transfers} transferring` : null,
                    sync.purged > 0 ? `${sync.purged} purged` : null,
                  ].filter(Boolean).join(' · ')}
            </span>
          </div>
        </Card>
      )}

      {/* Real stats summary */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Card className="p-4">
          <div className="text-xs uppercase text-muted-foreground flex items-center gap-1">
            <Globe className="h-3 w-3" /> Total Domains
          </div>
          <div className="text-2xl font-bold mt-1">{breakdown?.total ?? '—'}</div>
          <div className="text-xs text-muted-foreground mt-0.5">in Dynadot account</div>
        </Card>
        <Card className="p-4 border-emerald-500/30">
          <div className="text-xs uppercase text-muted-foreground flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3 text-emerald-500" /> Active
          </div>
          <div className="text-2xl font-bold mt-1 text-emerald-600 dark:text-emerald-400">
            {breakdown?.active ?? '—'}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">live &amp; renewable</div>
        </Card>
        <Card className="p-4 border-purple-500/30">
          <div className="text-xs uppercase text-muted-foreground flex items-center gap-1">
            <ArrowLeftRight className="h-3 w-3 text-purple-500" /> Transferring
          </div>
          <div className="text-2xl font-bold mt-1 text-purple-600 dark:text-purple-400">
            {breakdown?.transferring ?? 0}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">pending transfer in/out</div>
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
                Live from Dynadot <code className="text-xs font-mono">list_domain</code> API
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
                <span className="sr-only">Sync from Dynadot</span>
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
            <div className="text-center py-10 text-muted-foreground">
              <Globe className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-medium">
                {statusFilter === 'all'
                  ? 'No domains in your Dynadot account'
                  : `No ${statusFilter} domains found`}
              </p>
              <p className="text-xs mt-1 max-w-sm mx-auto">
                {sync?.error
                  ? `Could not reach Dynadot: ${sync.error}`
                  : statusFilter === 'all'
                  ? 'Domains you register through Dynadot (via the website or Dynadot dashboard) will appear here in real time.'
                  : 'Try a different status filter or sync again.'}
              </p>
              <Button variant="outline" size="sm" className="mt-3" onClick={load} disabled={loading}>
                <RefreshCw className="h-3.5 w-3.5 me-1" /> Sync from Dynadot
              </Button>
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
                    <TableHead className="text-end">Expires</TableHead>
                    <TableHead className="text-end">DNS</TableHead>
                    <TableHead className="text-end">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {domains.map((d) => {
                    const exp = formatExpiry(d.expiresAt)
                    const isTransferring = d.status === 'transferring' && d.transferDetail
                    return (
                      <TableRow key={d.id} className={d.status === 'deleted' || d.status === 'cancelled' ? 'opacity-60' : ''}>
                        <TableCell>
                          <button
                            className="font-medium hover:underline flex items-center gap-1.5 text-start"
                            onClick={() => onSelect(d.id)}
                          >
                            <Globe className={`h-3.5 w-3.5 shrink-0 ${isTransferring ? 'text-purple-500' : 'text-indigo-500'}`} />
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
                            {isTransferring && d.transferDetail?.transferType === 'in' && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Badge className="bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 border-purple-500/30 ms-1" variant="outline">
                                      <ArrowLeftRight className="h-3 w-3 me-1" /> Transfer In
                                    </Badge>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    Domain being transferred INTO this Dynadot account.
                                    Order #{d.transferDetail.orderId} · {d.transferDetail.submittedDate}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                          </button>
                          {isTransferring ? (
                            <div className="text-xs mt-0.5 ms-5 space-y-0.5">
                              <div className="flex items-center gap-1 text-purple-600 dark:text-purple-400">
                                <Clock className="h-3 w-3" />
                                <span className="font-medium">{d.transferDetail!.status}</span>
                                {d.transferDetail!.failedReason && (
                                  <span className="text-muted-foreground">· {d.transferDetail!.failedReason}</span>
                                )}
                              </div>
                              <div className="text-muted-foreground">
                                Order #{d.transferDetail!.orderId}
                                {d.transferDetail!.submittedDate && ` · submitted ${d.transferDetail!.submittedDate}`}
                                {d.transferDetail!.cost && ` · ${d.transferDetail!.cost}`}
                              </div>
                            </div>
                          ) : (
                            <div className="text-xs text-muted-foreground mt-0.5 ms-5">
                              {d.nameservers.length > 0 ? (
                                <span className="font-mono">{d.nameservers[0]}{d.nameservers.length > 1 ? ` +${d.nameservers.length - 1}` : ''}</span>
                              ) : (
                                <span>no nameservers</span>
                              )}
                            </div>
                          )}
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
                                      <Mail className="h-3 w-3 me-1" /> Email
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
                                      <Server className="h-3 w-3 me-1" /> {d.project.name}
                                    </Badge>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    Linked project: {d.project.name} ({d.project.status})
                                    <br />
                                    Site address: {d.project.domain || 'No domain connected'}
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
                                  <Lock className="h-3 w-3 text-muted-foreground inline-block ms-1" />
                                </TooltipTrigger>
                                <TooltipContent>Registrar lock enabled</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </TableCell>
                        <TableCell className="text-end align-top">
                          <div className="text-sm">{exp.text}</div>
                          {exp.days !== null && (
                            <div className={`text-xs ${exp.days < 30 ? 'text-red-500' : exp.days < 60 ? 'text-amber-500' : 'text-muted-foreground'}`}>
                              {exp.days > 0 ? `in ${exp.days} days` : `${Math.abs(exp.days)} days ago`}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-end align-top">
                          <span className="font-mono text-sm">{d.dnsRecordsCount}</span>
                          {d.logsCount > 0 && (
                            <div className="text-xs text-muted-foreground">{d.logsCount} logs</div>
                          )}
                        </TableCell>
                        <TableCell className="text-end align-top">
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
            {checking ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <RefreshCw className="h-4 w-4 me-1" />}
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
