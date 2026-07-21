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

/**
 * Register a domain for a given duration (in years).
 */
export async function registerDomain(
  domain: string,
  duration: number
): Promise<RegisterDomainResult> {
  const json = await callDynadot({
    command: 'register',
    domain,
    duration: String(duration),
  })
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

interface DnsRecordInput {
  type: string // A, AAAA, CNAME, MX, TXT, etc.
  name: string // subdomain or @
  value: string
  ttl?: number
  priority?: number
}

/**
 * Set DNS records for a domain via Dynadot's DNS management.
 */
export async function setDnsRecords(
  domain: string,
  records: DnsRecordInput[]
): Promise<{ success: boolean }> {
  const dnsConfig = records.map((r, i) => ({
    index: i,
    type: r.type,
    name: r.name,
    value: r.value,
    ttl: r.ttl || 3600,
  }))

  const json = await callDynadot({
    command: 'set_dns2',
    domain,
    main_record_type0: dnsConfig[0]?.type || 'A',
    main_record0: dnsConfig[0]?.value || '127.0.0.1',
    main_record_type1: dnsConfig[1]?.type || '',
    main_record1: dnsConfig[1]?.value || '',
    main_record_type2: dnsConfig[2]?.type || '',
    main_record2: dnsConfig[2]?.value || '',
    main_record_type3: dnsConfig[3]?.type || '',
    main_record3: dnsConfig[3]?.value || '',
  })
  const status = json.Response?.Status?.toLowerCase()
  return { success: status === 'success' }
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
