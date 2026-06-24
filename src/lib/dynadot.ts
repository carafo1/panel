/**
 * Dynadot domain registrar API client.
 *
 * Used by:
 *  - Dynadot domain provider integration
 *
 * API docs: https://www.dynadot.com/domain/api3.html
 *
 * The Dynadot API returns XML by default, but supports JSON via the
 * `api3.json` endpoint. We use the JSON form for easier parsing.
 *
 * When DYNADOT_API_KEY env var is not set, runs in DEMO MODE - returns
 * simulated data so the rest of the application can be exercised without
 * a real registrar account.
 */

const API_BASE = 'https://api.dynadot.com/api3.json'

function getApiKey(): string | null {
  return process.env.DYNADOT_API_KEY || null
}

export function isDynadotDemoMode(): boolean {
  return !getApiKey()
}

interface DynadotResponse {
  // Dynadot JSON envelope — the top-level key varies by command.
  // Most commands use "Response", but domain_info uses "DomainInfoResponse",
  // get_ns uses "GetNsResponse", etc.
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
  const envelopes = [json.Response, json.DomainInfoResponse, json.GetNsResponse].filter(
    Boolean
  ) as Array<Record<string, unknown>>
  for (const env of envelopes) {
    if (env.Status === 'error' || env.ResponseCode === '-1' || env.ResponseCode === -1) {
      throw new Error(`Dynadot API error: ${env.Error || 'Unknown error'}`)
    }
  }
  return json
}

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
 *   "Registration Price: 10.88 in USD and Renewal price: 10.88 in USD and Domain is a Premium Domain"
 *
 * Returns the registration + renewal prices (transfer = renewal for Dynadot).
 * Returns nulls if the string can't be parsed.
 */
function parseDynadotPriceString(
  raw: string
): { registration: number; renewal: number; premium: boolean } | null {
  if (!raw || typeof raw !== 'string') return null
  // Extract all "X.XX in USD" prices — registration always comes first, renewal second.
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
 * (the reseller wholesale price we pay) in the `Price` field. The Price field
 * is a human-readable string like:
 *   "Registration Price: 10.88 in USD and Renewal price: 10.88 in USD and ..."
 */
export async function searchDomains(
  domains: string[]
): Promise<SearchDomainResult[]> {
  if (isDynadotDemoMode()) {
    // Demo mode - simulate availability for common TLDs
     
    console.log('[dynadot] DEMO MODE: searchDomains', domains)
    return domains.map((domain) => {
      const tld = domain.split('.').pop()?.toLowerCase() || ''
      const knownTlds = ['com', 'net', 'org', 'io', 'dev', 'app', 'co']
      const isKnownTld = knownTlds.includes(tld)
      // Pretend very long / hyphenated domains are available, others taken
      const available = isKnownTld && (domain.length > 12 || domain.includes('-'))
      const priceMap: Record<string, number> = {
        com: 9.99,
        net: 11.99,
        org: 10.99,
        io: 32.0,
        dev: 14.99,
        app: 16.99,
        co: 24.99,
      }
      return {
        domain,
        available,
        price: available ? priceMap[tld] || 12.99 : undefined,
      }
    })
  }

  // Dynadot's search API requires separate domain0, domain1, domain2... params.
  // A single comma-separated domain0 value returns "invalid characters in domain".
  // show_price=1 makes Dynadot return real Registration + Renewal prices.
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

  // Dynadot search API returns:
  //   { SearchResponse: { ResponseCode: "0", SearchResults: [{ DomainName, Status, Available: "yes"|"no", Price?, Premium? }] } }
  const searchResp = json.SearchResponse as
    | { SearchResults?: Array<Record<string, unknown>> }
    | undefined
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
        transferPrice: parsed?.renewal, // Dynadot transfer price = renewal price
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
      const parsed = parseDynadotPriceString(dv.Price)
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
  if (isDynadotDemoMode()) {
    // Demo mode - simulate a successful registration
     
    console.log(
      `[dynadot] DEMO MODE: registerDomain(${domain}, ${duration}y)`
    )
    return {
      success: true,
      orderId: `demo-order-${Date.now()}`,
      registrationPrice: 9.99 * duration,
    }
  }

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

interface DomainInfo {
  status: string
  expiry?: string
  nameservers: string[]
}

/**
 * Get info about a registered domain.
 *
 * Uses the Dynadot API3 `domain_info` command (NOT `get_domain_info`, which
 * Dynadot rejects with "incorrect command name"). The response is returned
 * under the `DomainInfoResponse` envelope (not `Response`).
 *
 * Note: `domain_info` returns `NameServerSettings` (a mode object like
 * "Dynadot Parking"), NOT the actual nameserver hostnames. To get the real
 * hostnames (ns1.example.com, ...) we make a second `get_ns` call.
 */
export async function getDomainInfo(domain: string): Promise<DomainInfo> {
  if (isDynadotDemoMode()) {
    // Demo mode
     
    console.log(`[dynadot] DEMO MODE: getDomainInfo(${domain})`)
    return {
      status: 'active',
      expiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      nameservers: ['ns1.deployhub.io', 'ns2.deployhub.io'],
    }
  }

  const json = await callDynadot({ command: 'domain_info', domain })
  const resp = json.DomainInfoResponse
  const info = resp?.DomainInfo || {}

  // Expiration is a Unix timestamp in MILLISECONDS
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
  if (isDynadotDemoMode()) {
    // Demo mode - simulate success
     
    console.log(
      `[dynadot] DEMO MODE: setDnsRecords(${domain}, ${records.length} records)`
    )
    return { success: true }
  }

  // Dynadot expects a specific JSON structure for DNS records.
  // We pass them as `main_record_typeN`, `main_recordN`, `sub_recordN`, etc.
  // For simplicity, use the set_dns2 command which takes a JSON config.
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
    // Add up to a few records - Dynadot supports many but we cap for simplicity
    main_record_type2: dnsConfig[2]?.type || '',
    main_record2: dnsConfig[2]?.value || '',
    main_record_type3: dnsConfig[3]?.type || '',
    main_record3: dnsConfig[3]?.value || '',
  })
  const status = json.Response?.Status?.toLowerCase()
  return { success: status === 'success' }
}

/**
 * Renew a domain registration.
 */
export async function renewDomain(
  domain: string,
  duration: number
): Promise<{ success: boolean }> {
  if (isDynadotDemoMode()) {
     
    console.log(`[dynadot] DEMO MODE: renewDomain(${domain}, ${duration}y)`)
    return { success: true }
  }

  const json = await callDynadot({
    command: 'renew',
    domain,
    duration: String(duration),
  })
  const status = json.Response?.Status?.toLowerCase()
  return { success: status === 'success' || status === 'renew success' }
}

/**
 * Transfer a domain from another registrar using an auth/EPP code.
 */
export async function transferDomain(
  domain: string,
  authCode: string
): Promise<{ success: boolean }> {
  if (isDynadotDemoMode()) {
     
    console.log(`[dynadot] DEMO MODE: transferDomain(${domain})`)
    return { success: true }
  }

  const json = await callDynadot({
    command: 'transfer',
    domain,
    auth: authCode,
  })
  const status = json.Response?.Status?.toLowerCase()
  return { success: status === 'success' || status === 'transfer success' }
}
