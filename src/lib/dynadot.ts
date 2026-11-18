/**
 * Dynadot domain registrar API client.
 *
 * Used by:
 *  - Dynadot domain provider integration
 *  - Admin "All Domains" list (real API result via listDomains)
 *
 * API docs: https://www.dynadot.com/domain/api3.html
 *
 * The Dynadot API returns XML by default, but supports JSON via the
 * `api3.json` endpoint. We use the JSON form for easier parsing.
 *
 * NOTE: This client ONLY performs REAL API calls. There is NO simulation,
 * no mock data, and no demo-mode fallback. Every function will throw if
 * DYNADOT_API_KEY is not configured.
 */

const API_BASE = 'https://api.dynadot.com/api3.json'

function getApiKey(): string | null {
  return process.env.DYNADOT_API_KEY || null
}

/**
 * Returns true when no Dynadot API key is configured.
 *
 * This is kept for backward-compatibility with code that wants to surface a
 * "key not configured" warning in the UI. It does NOT trigger any simulation —
 * all API functions below will throw if the key is missing.
 */
export function isDynadotDemoMode(): boolean {
  return !getApiKey()
}

interface DynadotResponse {
  // Dynadot JSON envelope — the top-level key varies by command.
  Response?: {
    Status?: string
    Error?: string
    ResponseCode?: string | number
    [k: string]: unknown
  }
  DomainInfoResponse?: {
    ResponseCode?: string | number
    Status?: string
    Error?: string
    DomainInfo?: Record<string, unknown>
  }
  GetNsResponse?: {
    ResponseCode?: string | number
    Status?: string
    Error?: string
    NameServer?: string | string[]
    Ns?: string | string[]
    [k: string]: unknown
  }
  ListDomainInfoResponse?: {
    ResponseCode?: string | number
    Status?: string
    Error?: string
    MainDomains?: DynadotListedDomain[]
    DeletedDomains?: DynadotListedDomain[]
    [k: string]: unknown
  }
  SearchResponse?: {
    ResponseCode?: string | number
    Status?: string
    SearchResults?: Array<Record<string, unknown>>
    [k: string]: unknown
  }
  CreateContactResponse?: {
    ResponseCode?: string | number
    Status?: string
    Error?: string
    ContactId?: string | number
    [k: string]: unknown
  }
  SetDnsResponse?: {
    ResponseCode?: string | number
    Status?: string
    Error?: string
    [k: string]: unknown
  }
  GetDnsResponse?: {
    ResponseCode?: string | number
    Status?: string
    Error?: string
    [k: string]: unknown
  }
  [k: string]: unknown
}

interface DynadotListedDomain {
  Name?: string
  Status?: string
  Expiration?: string | number
  Registration?: string | number
  NameServerSettings?: string
  Lock?: string
  AutoRenew?: string
  AutoRenewal?: string
  Premium?: string
  Whois?: string
  [k: string]: unknown
}

async function callDynadot(params: Record<string, string>): Promise<DynadotResponse> {
  const key = getApiKey()
  if (!key) {
    throw new Error('DYNADOT_API_KEY not configured')
  }
  const url = new URL(API_BASE)
  url.searchParams.set('key', key)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`Dynadot API HTTP ${res.status}: ${await res.text()}`)
  }
  const json = (await res.json()) as DynadotResponse
  // Detect embedded Dynadot body errors (HTTP 200 + ResponseCode -1).
  // Errors can appear in ANY top-level *Response envelope, not just "Response".
  const envelopes = [
    json.Response,
    json.DomainInfoResponse,
    json.GetNsResponse,
    json.ListDomainInfoResponse,
    json.CreateContactResponse,
    // DNS commands: set_dns2 answers under SetDnsResponse, get_dns under
    // GetDnsResponse. Without these a failed DNS write looked like a non-error.
    json.SetDnsResponse,
    json.GetDnsResponse,
  ].filter(Boolean) as Array<Record<string, unknown>>
  for (const env of envelopes) {
    if (env.Status === 'error' || env.ResponseCode === '-1' || env.ResponseCode === -1) {
      throw new Error(`Dynadot API error: ${env.Error || 'Unknown error'}`)
    }
  }
  return json
}

// ─── Domain listing ────────────────────────────────────────────────────────────

export interface ListedDomain {
  name: string
  status: string
  expiresAt?: string
  registeredAt?: string
  autoRenew: boolean
  locked: boolean
  premium: boolean
  whoisPrivacy: boolean
  nameServerSettings?: string
}

/**
 * Parse a Dynadot timestamp. Dynadot returns expiration/registration dates as
 * Unix timestamps in MILLISECONDS (e.g. 1781675135000).
 */
function parseDynadotDate(raw: unknown): string | undefined {
  if (!raw) return undefined
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return new Date(n).toISOString()
}

function yesNo(v: unknown): boolean {
  return String(v || '').toLowerCase() === 'yes'
}

/**
 * List ALL domains registered in the Dynadot account.
 *
 * Uses the API3 `list_domain` command which returns both MainDomains (active)
 * and DeletedDomains (deleted/expired). We merge them into one list so the
 * admin UI can show the complete, real picture.
 *
 * This is a REAL API call — no simulation, no fallback.
 */
export async function listDomains(): Promise<{
  main: ListedDomain[]
  deleted: ListedDomain[]
}> {
  const json = await callDynadot({ command: 'list_domain' })
  const resp = json.ListDomainInfoResponse
  if (!resp) {
    throw new Error('Dynadot list_domain returned no ListDomainInfoResponse body')
  }

  const mapList = (arr: DynadotListedDomain[] | undefined): ListedDomain[] => {
    if (!Array.isArray(arr)) return []
    return arr
      .map((d) => {
        const name = String(d.Name || '').toLowerCase().trim()
        if (!name) return null
        return {
          name,
          status: String(d.Status || 'unknown'),
          expiresAt: parseDynadotDate(d.Expiration),
          registeredAt: parseDynadotDate(d.Registration),
          autoRenew: yesNo(d.AutoRenew) || yesNo(d.AutoRenewal),
          locked: yesNo(d.Lock),
          premium: yesNo(d.Premium),
          whoisPrivacy: yesNo(d.Whois),
          nameServerSettings: d.NameServerSettings ? String(d.NameServerSettings) : undefined,
        } as ListedDomain
      })
      .filter((d): d is ListedDomain => d !== null)
  }

  return {
    main: mapList(resp.MainDomains),
    deleted: mapList(resp.DeletedDomains),
  }
}

// ─── Transfer orders ──────────────────────────────────────────────────────────

export interface TransferOrder {
  orderId: string
  domain: string
  status: string // "Waiting", "Completed", "Cancelled", "Failed", etc.
  submittedDate?: string
  cost?: string
  paymentMethod?: string
  orderStatus?: string // top-level order status: "Processing", "Completed"
  failedReason?: string // e.g. "Transfer Pending"
  transferType: 'in' | 'away'
}

interface DynadotOrderItem {
  ItemType?: string
  ItemTypeName?: string
  Name?: string
  Cost?: string
  Status?: string
  ItemStatus?: string
  ItemName?: string
}

interface DynadotOrderListEntry {
  OrderId?: string | number
  SubmittedDate?: string
  Currency?: string
  PaymentMethod?: string
  TotalCost?: string
  TotalPaid?: string
  Status?: string
  OrderStatus?: string
  ItemList?: DynadotOrderItem[]
}

interface DynadotOrderListResponse {
  OrderListResponse?: {
    ResponseCode?: string | number
    Status?: string
    Error?: string
    OrderList?: DynadotOrderListEntry[]
  }
}

interface DynadotTransferStatusResponse {
  GetTransferStatusResponse?: {
    ResponseCode?: string | number
    Status?: string
    Error?: string
    TransferList?: Array<{
      OrderId?: string | number
      TransferStatus?: string
      FailedReason?: string
    }>
  }
}

/**
 * List ALL orders in the Dynadot account within the given date range, then
 * filter to only those that contain a "Domain Transfer" item.
 *
 * This is how we discover domains that are currently being transferred IN
 * (or OUT) — they do NOT appear in the `list_domain` result until the
 * transfer completes.
 *
 * @param days  How many days back to search (default 180 = ~6 months).
 */
export async function listTransferOrders(days = 180): Promise<TransferOrder[]> {
  const end = new Date()
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)
  const fmt = (d: Date) =>
    `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(
      d.getDate()
    ).padStart(2, '0')}`

  const json = await callDynadot({
    command: 'order_list',
    search_by: 'date_range',
    start_date: fmt(start),
    end_date: fmt(end),
  })
  const resp = (json as DynadotOrderListResponse).OrderListResponse
  const orders = resp?.OrderList || []

  const transfers: TransferOrder[] = []
  for (const o of orders) {
    const items = o.ItemList || []
    for (const item of items) {
      const typeRaw = String(item.ItemType || item.ItemTypeName || '').toLowerCase()
      if (!typeRaw.includes('transfer')) continue
      const domain = String(item.Name || item.ItemName || '').toLowerCase().trim()
      if (!domain) continue
      transfers.push({
        orderId: String(o.OrderId || ''),
        domain,
        status: String(item.Status || item.ItemStatus || o.Status || o.OrderStatus || 'unknown'),
        submittedDate: o.SubmittedDate,
        cost: item.Cost || o.TotalCost,
        paymentMethod: o.PaymentMethod,
        orderStatus: o.Status || o.OrderStatus,
        transferType: 'in', // order_list doesn't distinguish; we default to "in"
      })
    }
  }

  // Enrich each transfer with the precise TransferStatus + FailedReason via
  // get_transfer_status. This returns e.g. "Waiting" / "Transfer Pending".
  await Promise.all(
    transfers.map(async (t) => {
      try {
        const stJson = await callDynadot({
          command: 'get_transfer_status',
          domain: t.domain,
          transfer_type: 'in',
        })
        const stResp = (stJson as DynadotTransferStatusResponse).GetTransferStatusResponse
        const entry = stResp?.TransferList?.[0]
        if (entry) {
          if (entry.TransferStatus) t.status = String(entry.TransferStatus)
          if (entry.FailedReason) t.failedReason = String(entry.FailedReason)
        }
      } catch {
        // If get_transfer_status fails (e.g. it's actually a transfer-away),
        // try the "away" type. Otherwise leave the order_list status as-is.
        try {
          const stJson = await callDynadot({
            command: 'get_transfer_status',
            domain: t.domain,
            transfer_type: 'away',
          })
          const stResp = (stJson as DynadotTransferStatusResponse).GetTransferStatusResponse
          const entry = stResp?.TransferList?.[0]
          if (entry) {
            t.transferType = 'away'
            if (entry.TransferStatus) t.status = String(entry.TransferStatus)
            if (entry.FailedReason) t.failedReason = String(entry.FailedReason)
          }
        } catch {
          // leave as-is
        }
      }
    })
  )

  return transfers
}

// ─── Search ────────────────────────────────────────────────────────────────────

interface SearchDomainResult {
  domain: string
  available: boolean
  price?: number
  registrationPrice?: number
  renewalPrice?: number
  transferPrice?: number
  premium?: boolean
}

/**
 * Parse Dynadot's `show_price=1` Price string into structured prices.
 *
 * Example input:
 *   "Registration Price: 10.88 in USD and Renewal price: 10.88 in USD and Domain is not a Premium Domain"
 */
function parseDynadotPriceString(
  raw: string
): { registration: number; renewal: number; premium: boolean } | null {
  if (!raw || typeof raw !== 'string') return null
  const matches = raw.match(/([\d.]+)\s+in\s+USD/gi)
  if (!matches || matches.length < 1) return null
  const nums = matches.map((m) => parseFloat(m.replace(/[^\d.]/g, '')))
  const registration = nums[0] || 0
  const renewal = nums[1] || registration
  const premium = /is\s+a\s+Premium/i.test(raw)
  return { registration, renewal, premium }
}

/**
 * Search domain availability for one or more domains.
 *
 * Uses `show_price=1` so Dynadot returns real Registration + Renewal prices
 * (the reseller wholesale price we pay) in the `Price` field.
 */
export async function searchDomains(
  domains: string[]
): Promise<SearchDomainResult[]> {
  // Dynadot's search API requires separate domain0, domain1, domain2... params.
  const searchParams: Record<string, string> = {
    command: 'search',
    show_price: '1',
    currency: 'USD',
  }
  domains.forEach((d, i) => {
    searchParams[`domain${i}`] = d
  })
  const json = await callDynadot(searchParams)

  const results: SearchDomainResult[] = []

  const searchResp = json.SearchResponse
  if (searchResp?.SearchResults && Array.isArray(searchResp.SearchResults)) {
    for (const item of searchResp.SearchResults) {
      const priceRaw = item.Price ? String(item.Price) : ''
      const parsed = parseDynadotPriceString(priceRaw)
      results.push({
        domain: String(item.DomainName || ''),
        available: String(item.Available || '').toLowerCase() === 'yes',
        price: parsed?.registration,
        registrationPrice: parsed?.registration,
        renewalPrice: parsed?.renewal,
        transferPrice: parsed?.renewal,
        premium: parsed?.premium ?? (String(item.Premium || '').toLowerCase() === 'yes'),
      })
    }
    return results
  }

  // Fallback: older Dynadot format { Response: { domain0: {...}, domain1: {...} } }
  const response = json.Response
  if (!response) {
    throw new Error('Dynadot returned no response body')
  }
  for (const [key, value] of Object.entries(response)) {
    if (key.startsWith('domain') && typeof value === 'object' && value !== null) {
      const dv = value as { Name?: string; Available?: string; Price?: string }
      const parsed = parseDynadotPriceString(dv.Price ?? '')
      results.push({
        domain: dv.Name || '',
        available: String(dv.Available).toLowerCase() === 'yes',
        price: parsed?.registration ?? (dv.Price ? parseFloat(dv.Price) : undefined),
        registrationPrice: parsed?.registration,
        renewalPrice: parsed?.renewal,
        transferPrice: parsed?.renewal,
      })
    }
  }
  return results
}

// ─── Register ──────────────────────────────────────────────────────────────────

interface RegisterDomainResult {
  success: boolean
  orderId?: string
  registrationPrice?: number
}

export interface RegistrantContact {
  firstName: string
  lastName: string
  email: string
  phone?: string
  organization?: string
  address1?: string
  address2?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
}

/**
 * Create a contact at the registrar and return its Dynadot contact ID.
 *
 * The `register` command references contacts by ID; there is no way to pass
 * contact details inline. Without this, every registration silently inherits
 * the API account's default contact — i.e. our details on the customer's
 * domain, which is both wrong and an ICANN accuracy problem.
 */
export async function createContact(
  contact: RegistrantContact
): Promise<string> {
  const phone = (contact.phone || '').trim()
  const intl = phone.startsWith('+')
    ? phone.slice(1)
    : phone.startsWith('00')
    ? phone.slice(2)
    : null
  const digits = (intl ?? phone).replace(/\D/g, '')
  let cc = ''
  let num = digits
  if (intl !== null && digits) {
    let ccLen = 3
    if (digits.startsWith('1') || digits.startsWith('7')) ccLen = 1
    else if (/^(2[07]|3[0-46-9]|4[013-9]|5[1-8]|6[0-6]|8[1246]|9[0-58])/.test(digits)) ccLen = 2
    cc = digits.slice(0, ccLen)
    num = digits.slice(ccLen)
  }

  const params: Record<string, string> = {
    command: 'create_contact',
    name: `${contact.firstName} ${contact.lastName}`.trim(),
    email: contact.email,
    phonecc: cc,
    phonenum: num,
    address1: contact.address1 || '',
    city: contact.city || '',
    state: contact.state || '',
    zip: contact.postalCode || '',
    country: (contact.country || '').toUpperCase(),
  }
  if (contact.organization) params.organization = contact.organization
  if (contact.address2) params.address2 = contact.address2

  const json = await callDynadot(params)
  const envelope =
    ((json.CreateContactResponse as Record<string, unknown> | undefined) ??
      (json.Response as Record<string, unknown> | undefined)) ||
    {}
  const contactId = envelope.ContactId as string | number | undefined
  if (contactId === undefined || contactId === null || contactId === '') {
    throw new Error('Dynadot create_contact returned no ContactId')
  }
  return String(contactId)
}

/**
 * Register a domain for a given duration (in years).
 *
 * When `contact` is supplied it is created at the registrar first and applied
 * to all four contact roles. Registration is aborted if that fails rather than
 * falling back to the account default.
 */
export async function registerDomain(
  domain: string,
  duration: number,
  contact?: RegistrantContact
): Promise<RegisterDomainResult> {
  const params: Record<string, string> = {
    command: 'register',
    domain,
    duration: String(duration),
  }

  if (contact) {
    const contactId = await createContact(contact)
    params.registrant_contact = contactId
    params.admin_contact = contactId
    params.technical_contact = contactId
    params.billing_contact = contactId
  }

  const json = await callDynadot(params)
  const response = json.Response
  const status = response?.Status?.toLowerCase()
  const success = status === 'success' || status === 'register success'
  return {
    success,
    orderId: (response?.RegisterOrderId as string) || (response?.OrderId as string),
    registrationPrice: response?.Price ? parseFloat(String(response.Price)) : undefined,
  }
}

// ─── Domain info ───────────────────────────────────────────────────────────────

interface DomainInfo {
  status: string
  expiry?: string
  nameservers: string[]
}

/**
 * Get info about a registered domain.
 *
 * Uses the API3 `domain_info` command (NOT `get_domain_data`). The response
 * comes under the `DomainInfoResponse` envelope.
 *
 * Note: `domain_info` returns `NameServerSettings` (a mode like "Dynadot
 * Parking"), NOT the actual hostnames. To get the real hostnames we make a
 * second `get_ns` call.
 */
export async function getDomainInfo(domain: string): Promise<DomainInfo> {
  const json = await callDynadot({ command: 'domain_info', domain })
  const resp = json.DomainInfoResponse
  const info = resp?.DomainInfo || {}

  const expiryRaw = info.Expiration ? String(info.Expiration) : undefined
  const expiry = expiryRaw && !isNaN(Number(expiryRaw))
    ? new Date(Number(expiryRaw)).toISOString()
    : undefined

  // domain_info does not return nameserver hostnames — fetch them via get_ns.
  let nameservers: string[] = []
  try {
    const nsJson = await callDynadot({ command: 'get_ns', domain })
    const nsResp = nsJson.GetNsResponse
    const nsHosts = nsResp?.NameServer || nsResp?.Ns
    if (Array.isArray(nsHosts)) {
      nameservers = nsHosts.map((s) => String(s).trim()).filter(Boolean)
    } else if (nsHosts) {
      nameservers = String(nsHosts)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    }
  } catch {
    // get_ns is best-effort — status & expiry are still useful on their own
  }

  return {
    status: String(info.Status || 'unknown'),
    expiry,
    nameservers,
  }
}

// ─── DNS records ───────────────────────────────────────────────────────────────

//
// Dynadot's `set_dns2` REPLACES the whole zone unless
// `add_dns_to_current_setting=1` is sent. The previous implementation never
// sent it, pushed at most four apex records (dropping every record name), and
// invented `A @ 127.0.0.1` when the list was empty — so adding or deleting one
// record wiped the customer's zone. The rules now are:
//
//   ADD             append with add_dns_to_current_setting=1, sending only the
//                   new records (records already present are skipped).
//   DELETE/UPDATE   read the live zone with get_dns, change only the targeted
//                   record, and write back EVERY remaining record — including
//                   ones the panel never knew about.
//   ALWAYS          refuse an empty zone, refuse more records than Dynadot
//                   accepts (truncating would delete the rest), refuse the
//                   brand/panel domains, and report success only when Dynadot
//                   answered Status "success".
//
// set_dns2 parameters: apex records use main_record_type{N} / main_record{N} /
// main_recordx{N} (N = 0..19); subdomain records use subdomain{N} /
// sub_record_type{N} / sub_record{N} / sub_recordx{N} (N = 0..99). The "x"
// field carries the MX distance (and the forward/stealth/email extras). TTL is
// a single zone-wide `ttl` parameter — Dynadot has no per-record TTL.
//
// The pure helpers below are exported so they can be unit-tested without a
// network (tests/unit/dynadot-dns.test.ts).

export interface DnsRecordInput {
  type: string // A, AAAA, CNAME, MX, TXT, SRV
  name: string // '@', '', a relative label ('www', 'mail._domainkey') or an FQDN
  value: string
  ttl?: number
  priority?: number | null
}

/** One record as Dynadot stores it. */
export interface DynadotDnsRecord {
  /** '@' for the apex, otherwise the relative subhost, lowercased. */
  name: string
  /** Dynadot record type, lowercased: a, aaaa, cname, txt, mx, srv, forward, stealth, email. */
  type: string
  value: string
  /** main_recordx / sub_recordx — MX distance, forward type, stealth title, email alias. */
  valueX?: string
}

export interface DynadotDnsZone {
  records: DynadotDnsRecord[]
  /** Zone-wide TTL as returned by get_dns, preserved on full rewrites. */
  ttl?: string
  /** NameServerSettings.Type as returned by get_dns (informational). */
  settingsType?: string
}

export const DYNADOT_MAX_MAIN_RECORDS = 20
export const DYNADOT_MAX_SUB_RECORDS = 100

const APEX_RECORD_TYPES = new Set(['a', 'aaaa', 'cname', 'forward', 'txt', 'mx', 'stealth', 'email'])
const SUB_RECORD_TYPES = new Set([...APEX_RECORD_TYPES, 'srv'])

export type DnsRefusalCode =
  | 'protected_domain'
  | 'empty_zone'
  | 'too_many_records'
  | 'unsupported_record'
  | 'record_not_found'
  | 'zone_unreadable'

/**
 * A DNS write the panel refused to send. Messages are safe to show customers
 * (they never name the registrar).
 */
export class DnsWriteRefusedError extends Error {
  readonly code: DnsRefusalCode
  constructor(code: DnsRefusalCode, message: string) {
    super(message)
    this.name = 'DnsWriteRefusedError'
    this.code = code
  }
}

/** HTTP status a route should answer with for a refused DNS write. */
export function dnsRefusalStatus(code: DnsRefusalCode): number {
  switch (code) {
    case 'protected_domain':
      return 403
    case 'record_not_found':
      return 404
    case 'empty_zone':
      return 409
    case 'too_many_records':
    case 'unsupported_record':
      return 422
    case 'zone_unreadable':
      return 502
  }
}

const normaliseHost = (v: string) => (v || '').trim().toLowerCase().replace(/\.+$/, '')

function hostOf(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) return null
  const s = raw.trim()
  try {
    const host = new URL(s.includes('://') ? s : `https://${s}`).hostname
    return normaliseHost(host) || null
  } catch {
    return null
  }
}

type EnvLike = Record<string, string | undefined>

/**
 * Hostnames whose DNS the panel must never write: the brand domain and the
 * panel's own host (PANEL_DOMAIN, APP_URL, NEXT_PUBLIC_APP_URL). Read at call
 * time so tests and runtime setting changes are honoured.
 */
export function protectedDnsHosts(env: EnvLike = process.env): string[] {
  const hosts = new Set<string>()
  for (const raw of [env.BRAND_DOMAIN || 'apsamo.com', env.PANEL_DOMAIN, env.APP_URL, env.NEXT_PUBLIC_APP_URL]) {
    const h = hostOf(raw)
    // A bare label ("localhost") is not a zone anyone can write.
    if (h && h.includes('.')) hosts.add(h)
  }
  return [...hosts]
}

/**
 * True when `domain` is a protected host, a parent zone of one (the zone that
 * holds panel.apsamo.com is apsamo.com), or a name inside one.
 */
export function isProtectedDnsDomain(domain: string, env: EnvLike = process.env): boolean {
  const d = normaliseHost(domain)
  if (!d) return false
  return protectedDnsHosts(env).some(
    (p) => p === d || p.endsWith(`.${d}`) || d.endsWith(`.${p}`)
  )
}

export function assertDnsWriteAllowed(domain: string, env: EnvLike = process.env): void {
  if (isProtectedDnsDomain(domain, env)) {
    throw new DnsWriteRefusedError(
      'protected_domain',
      `DNS for ${normaliseHost(domain)} is managed by the platform and cannot be changed from the panel.`
    )
  }
}

/** '@', '' or the domain itself → '@'; 'www.example.com' → 'www'; lowercased. */
export function normaliseRecordName(name: string, domain: string): string {
  const d = normaliseHost(domain)
  let n = normaliseHost(name || '')
  if (n === '' || n === '@' || n === d) return '@'
  if (d && n.endsWith(`.${d}`)) n = n.slice(0, -(d.length + 1))
  return n || '@'
}

/**
 * Convert a panel record to Dynadot's shape. With `strict` (the default) the
 * record must be one Dynadot can store at that position; non-strict is for
 * matching a stored record against the live zone.
 */
export function toDynadotRecord(
  r: DnsRecordInput,
  domain: string,
  opts: { strict?: boolean } = {}
): DynadotDnsRecord {
  const strict = opts.strict !== false
  const type = String(r.type || '').trim().toLowerCase()
  const name = normaliseRecordName(r.name, domain)
  const value = String(r.value ?? '').trim()
  if (strict) {
    if (!value) {
      throw new DnsWriteRefusedError('unsupported_record', 'DNS record value is required.')
    }
    const allowed = name === '@' ? APEX_RECORD_TYPES : SUB_RECORD_TYPES
    if (!allowed.has(type)) {
      throw new DnsWriteRefusedError(
        'unsupported_record',
        name === '@'
          ? `${type.toUpperCase() || 'This'} records are not supported at the domain apex by the registrar DNS.`
          : `${type.toUpperCase() || 'This'} records are not supported by the registrar DNS.`
      )
    }
  }
  let valueX: string | undefined
  if (r.priority !== undefined && r.priority !== null && Number.isFinite(Number(r.priority))) {
    valueX = String(Math.trunc(Number(r.priority)))
  } else if (type === 'mx' && strict) {
    valueX = '10' // set_dns2 requires a distance for MX
  }
  return valueX === undefined ? { name, type, value } : { name, type, value, valueX }
}

function comparableValue(rec: DynadotDnsRecord): string {
  // TXT content is case-sensitive; hostnames and addresses are not.
  return rec.type === 'txt' ? rec.value : normaliseHost(rec.value)
}

/** Same record: name, type and value; the x-field only when both sides have one. */
export function sameDnsRecord(a: DynadotDnsRecord, b: DynadotDnsRecord): boolean {
  if (a.name !== b.name || a.type !== b.type) return false
  if (comparableValue(a) !== comparableValue(b)) return false
  if (a.valueX !== undefined && b.valueX !== undefined && a.valueX !== b.valueX) return false
  return true
}

function asArray(v: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === 'object') as Array<Record<string, unknown>>
  if (v && typeof v === 'object') return [v as Record<string, unknown>]
  return []
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v)
}

/**
 * Parse a get_dns response (GetDnsResponse.GetDns.NameServerSettings).
 *
 * Throws `zone_unreadable` for anything it cannot account for fully. A partly
 * parsed zone written back would silently delete the records we missed, so
 * an unreadable zone must stop the write, never shrink it.
 */
export function parseGetDnsZone(json: Record<string, unknown>): DynadotDnsZone {
  const resp = json?.GetDnsResponse as Record<string, unknown> | undefined
  if (!resp || typeof resp !== 'object') {
    throw new DnsWriteRefusedError('zone_unreadable', 'Could not read the current DNS zone from the registrar.')
  }
  const status = str(resp.Status).toLowerCase()
  if (status && status !== 'success') {
    throw new DnsWriteRefusedError('zone_unreadable', 'Could not read the current DNS zone from the registrar.')
  }
  const getDns = (resp.GetDns || resp.GetDnsContent) as Record<string, unknown> | undefined
  const settings = (getDns?.NameServerSettings ?? resp.NameServerSettings) as
    | Record<string, unknown>
    | undefined
  if (!settings || typeof settings !== 'object') {
    throw new DnsWriteRefusedError('zone_unreadable', 'Could not read the current DNS zone from the registrar.')
  }

  const records: DynadotDnsRecord[] = []
  const take = (row: Record<string, unknown>, name: string) => {
    const type = str(row.RecordType).trim().toLowerCase()
    const value = str(row.Value).trim()
    if (!type || !value || !name) {
      throw new DnsWriteRefusedError(
        'zone_unreadable',
        'The current DNS zone contains a record the panel cannot read, so it was left unchanged.'
      )
    }
    const x = str(row.Value2).trim()
    records.push(x ? { name, type, value, valueX: x } : { name, type, value })
  }
  for (const row of asArray(settings.MainDomains)) take(row, '@')
  for (const row of asArray(settings.SubDomains)) {
    take(row, normaliseHost(str(row.Subhost ?? row.SubHost)))
  }

  const ttl = str(settings.TTL ?? settings.Ttl).trim()
  const settingsType = str(settings.Type).trim()
  return {
    records,
    ...(ttl ? { ttl } : {}),
    ...(settingsType ? { settingsType } : {}),
  }
}

/** Drop exact duplicates, keeping the first occurrence. */
export function dedupeDnsRecords(records: DynadotDnsRecord[]): DynadotDnsRecord[] {
  const out: DynadotDnsRecord[] = []
  for (const r of records) if (!out.some((o) => sameDnsRecord(o, r))) out.push(r)
  return out
}

/** Records in `wanted` that the zone does not already contain. */
export function recordsMissingFromZone(
  zone: DynadotDnsRecord[],
  wanted: DynadotDnsRecord[]
): DynadotDnsRecord[] {
  return dedupeDnsRecords(wanted).filter((w) => !zone.some((z) => sameDnsRecord(z, w)))
}

/** The zone without `target` (every exact copy of it). */
export function removeRecordFromZone(
  zone: DynadotDnsRecord[],
  target: DynadotDnsRecord
): { records: DynadotDnsRecord[]; removed: number } {
  const records = zone.filter((z) => !sameDnsRecord(z, target))
  return { records, removed: zone.length - records.length }
}

/** The zone with `target` replaced in place by `replacement`. */
export function replaceRecordInZone(
  zone: DynadotDnsRecord[],
  target: DynadotDnsRecord,
  replacement: DynadotDnsRecord
): DynadotDnsRecord[] {
  const idx = zone.findIndex((z) => sameDnsRecord(z, target))
  if (idx === -1) {
    throw new DnsWriteRefusedError('record_not_found', 'That DNS record is not present in the live zone.')
  }
  const out: DynadotDnsRecord[] = []
  zone.forEach((z, i) => {
    if (i === idx) out.push(replacement)
    else if (!sameDnsRecord(z, target)) out.push(z)
  })
  return dedupeDnsRecords(out)
}

function countByPosition(records: DynadotDnsRecord[]): { main: number; sub: number } {
  let main = 0
  let sub = 0
  for (const r of records) (r.name === '@' ? main++ : sub++)
  return { main, sub }
}

/** Throws when Dynadot could not hold `records` in one zone. */
export function assertZoneCapacity(records: DynadotDnsRecord[]): void {
  const { main, sub } = countByPosition(records)
  if (main > DYNADOT_MAX_MAIN_RECORDS || sub > DYNADOT_MAX_SUB_RECORDS) {
    throw new DnsWriteRefusedError(
      'too_many_records',
      `The registrar DNS holds at most ${DYNADOT_MAX_MAIN_RECORDS} records at the domain apex and ` +
        `${DYNADOT_MAX_SUB_RECORDS} subdomain records; this change would exceed that.`
    )
  }
}

/**
 * Build set_dns2 parameters.
 *
 *   append: true   → add_dns_to_current_setting=1; `records` are only the new ones.
 *   append: false  → `records` is the COMPLETE zone and replaces what is there.
 *
 * Never returns an empty write: replacing a zone with nothing (or inventing a
 * placeholder record) is exactly the failure this module exists to prevent.
 */
export function buildSetDns2Params(
  domain: string,
  records: DynadotDnsRecord[],
  opts: { append: boolean; ttl?: string }
): Record<string, string> {
  if (records.length === 0) {
    throw new DnsWriteRefusedError(
      'empty_zone',
      opts.append
        ? 'There are no DNS records to add.'
        : 'Refusing to replace the DNS zone with an empty record set.'
    )
  }
  assertZoneCapacity(records)

  const params: Record<string, string> = { command: 'set_dns2', domain: normaliseHost(domain) }
  let m = 0
  let s = 0
  for (const r of records) {
    if (!r.value) {
      throw new DnsWriteRefusedError('unsupported_record', 'DNS record value is required.')
    }
    if (r.name === '@') {
      if (!APEX_RECORD_TYPES.has(r.type)) {
        throw new DnsWriteRefusedError('unsupported_record', `${r.type.toUpperCase()} records are not supported at the domain apex.`)
      }
      params[`main_record_type${m}`] = r.type
      params[`main_record${m}`] = r.value
      if (r.valueX !== undefined) params[`main_recordx${m}`] = r.valueX
      m++
    } else {
      if (!SUB_RECORD_TYPES.has(r.type)) {
        throw new DnsWriteRefusedError('unsupported_record', `${r.type.toUpperCase()} records are not supported.`)
      }
      params[`subdomain${s}`] = r.name
      params[`sub_record_type${s}`] = r.type
      params[`sub_record${s}`] = r.value
      if (r.valueX !== undefined) params[`sub_recordx${s}`] = r.valueX
      s++
    }
  }
  if (opts.append) params.add_dns_to_current_setting = '1'
  if (opts.ttl) params.ttl = opts.ttl
  return params
}

/** True only when Dynadot answered a set_dns2 with Status "success". */
export function isSetDnsSuccess(json: Record<string, unknown> | null | undefined): boolean {
  if (!json) return false
  for (const key of ['SetDnsResponse', 'SetDns2Response', 'Response']) {
    const env = json[key] as Record<string, unknown> | undefined
    if (env && typeof env === 'object' && str(env.Status).toLowerCase() === 'success') return true
  }
  return false
}

// ── DNS operations (shared by this module and lib/dynadot-service) ─────────

/** A function that sends one Dynadot API command and returns the parsed JSON. */
export type DynadotCall = (params: Record<string, string>) => Promise<Record<string, unknown>>

export interface DnsWriteResult {
  /** True only when Dynadot confirmed the write (or nothing needed writing). */
  success: boolean
  /** Records sent in the set_dns2 call (0 when nothing needed writing). */
  written: number
  /** ADD: records skipped because the zone already had them. */
  skipped?: number
  /** DELETE: the record was not in the live zone, so nothing was written. */
  notFound?: boolean
}

export async function fetchDnsZoneVia(call: DynadotCall, domain: string): Promise<DynadotDnsZone> {
  const json = await call({ command: 'get_dns', domain: normaliseHost(domain) })
  return parseGetDnsZone(json)
}

/**
 * Append records to the live zone (add_dns_to_current_setting=1). Records the
 * zone already holds are skipped so a retry does not create duplicates.
 */
export async function addDnsRecordsVia(
  call: DynadotCall,
  domain: string,
  records: DnsRecordInput[]
): Promise<DnsWriteResult> {
  assertDnsWriteAllowed(domain)
  const wanted = dedupeDnsRecords(records.map((r) => toDynadotRecord(r, domain)))
  if (wanted.length === 0) {
    throw new DnsWriteRefusedError('empty_zone', 'There are no DNS records to add.')
  }

  let toAdd = wanted
  let zone: DynadotDnsZone | null = null
  try {
    zone = await fetchDnsZoneVia(call, domain)
  } catch {
    // Reading is only for de-duplication and the capacity check; an append
    // without it cannot remove anything, so carry on.
    zone = null
  }
  if (zone) {
    toAdd = recordsMissingFromZone(zone.records, wanted)
    if (toAdd.length === 0) return { success: true, written: 0, skipped: wanted.length }
    assertZoneCapacity([...zone.records, ...toAdd])
  }

  const json = await call(buildSetDns2Params(domain, toAdd, { append: true }))
  return {
    success: isSetDnsSuccess(json),
    written: toAdd.length,
    skipped: wanted.length - toAdd.length,
  }
}

/**
 * Remove one record: read the live zone, drop the record, write back every
 * remaining record. Refuses (empty_zone) when it was the last record.
 */
export async function deleteDnsRecordVia(
  call: DynadotCall,
  domain: string,
  target: DnsRecordInput
): Promise<DnsWriteResult> {
  assertDnsWriteAllowed(domain)
  const t = toDynadotRecord(target, domain, { strict: false })
  const zone = await fetchDnsZoneVia(call, domain)
  const { records, removed } = removeRecordFromZone(zone.records, t)
  if (removed === 0) return { success: true, written: 0, notFound: true }
  if (records.length === 0) {
    throw new DnsWriteRefusedError(
      'empty_zone',
      'This is the last DNS record on the domain. Add its replacement first, or change the nameservers instead.'
    )
  }
  const json = await call(buildSetDns2Params(domain, records, { append: false, ttl: zone.ttl }))
  return { success: isSetDnsSuccess(json), written: records.length }
}

/**
 * Replace one record in place: read the live zone, swap the record, write back
 * the full zone.
 */
export async function updateDnsRecordVia(
  call: DynadotCall,
  domain: string,
  target: DnsRecordInput,
  replacement: DnsRecordInput
): Promise<DnsWriteResult> {
  assertDnsWriteAllowed(domain)
  const t = toDynadotRecord(target, domain, { strict: false })
  const next = toDynadotRecord(replacement, domain)
  const zone = await fetchDnsZoneVia(call, domain)
  const records = replaceRecordInZone(zone.records, t, next)
  const json = await call(buildSetDns2Params(domain, records, { append: false, ttl: zone.ttl }))
  return { success: isSetDnsSuccess(json), written: records.length }
}

const dynadotCall: DynadotCall = (params) => callDynadot(params)

/** Read the live Dynadot zone for a domain. */
export async function getDnsZone(domain: string): Promise<DynadotDnsZone> {
  return fetchDnsZoneVia(dynadotCall, domain)
}

/**
 * Add DNS records for a domain. APPENDS to the live zone — it never replaces
 * it. (Kept under its historical name for existing callers such as
 * lib/orchestration.) Throws DnsWriteRefusedError for refused writes.
 */
export async function setDnsRecords(
  domain: string,
  records: DnsRecordInput[]
): Promise<DnsWriteResult> {
  return addDnsRecordsVia(dynadotCall, domain, records)
}

export const addDnsRecords = setDnsRecords

/** Delete one record from the live zone, keeping every other record. */
export async function deleteDnsRecord(
  domain: string,
  target: DnsRecordInput
): Promise<DnsWriteResult> {
  return deleteDnsRecordVia(dynadotCall, domain, target)
}

/** Replace one record in the live zone, keeping every other record. */
export async function updateDnsRecord(
  domain: string,
  target: DnsRecordInput,
  replacement: DnsRecordInput
): Promise<DnsWriteResult> {
  return updateDnsRecordVia(dynadotCall, domain, target, replacement)
}

// ─── Renew ─────────────────────────────────────────────────────────────────────

/**
 * Renew a domain registration.
 */
export async function renewDomain(
  domain: string,
  duration: number
): Promise<{ success: boolean }> {
  const json = await callDynadot({
    command: 'renew',
    domain,
    duration: String(duration),
  })
  const status = json.Response?.Status?.toLowerCase()
  return { success: status === 'success' || status === 'renew success' }
}

// ─── Transfer ──────────────────────────────────────────────────────────────────

/**
 * Transfer a domain from another registrar using an auth/EPP code.
 */
export async function transferDomain(
  domain: string,
  authCode: string
): Promise<{ success: boolean }> {
  const json = await callDynadot({
    command: 'transfer',
    domain,
    auth: authCode,
  })
  const status = json.Response?.Status?.toLowerCase()
  return { success: status === 'success' || status === 'transfer success' }
}
