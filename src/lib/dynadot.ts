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
  // Dynadot JSON envelope
  Response?: {
    Status?: string
    Error?: string
    [k: string]: unknown
  }
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
  return json
}

interface SearchDomainResult {
  domain: string
  available: boolean
  price?: number
}

/**
 * Search domain availability for one or more domains.
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

  const domainList = domains.join(',')
  const json = await callDynadot({
    command: 'search',
    domain0: domainList,
  })

  const response = json.Response
  if (!response) {
    throw new Error('Dynadot returned no response body')
  }

  const results: SearchDomainResult[] = []
  // Dynadot returns dynamic keys like "domain0", "domain1", etc.
  for (const [key, value] of Object.entries(response)) {
    if (key.startsWith('domain') && typeof value === 'object' && value !== null) {
      const dv = value as { Name?: string; Available?: string; Price?: string }
      results.push({
        domain: dv.Name || '',
        available: String(dv.Available).toLowerCase() === 'yes',
        price: dv.Price ? parseFloat(dv.Price) : undefined,
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

  const json = await callDynadot({
    command: 'get_domain_info',
    domain,
  })
  const response = json.Response
  const info = (response?.DomainInfo || response || {}) as Record<string, unknown>
  const ns = (info.NameServer as string | string[] | undefined) || []
  return {
    status: String(info.Status || 'unknown'),
    expiry: info.Expiration ? String(info.Expiration) : undefined,
    nameservers: Array.isArray(ns) ? ns : String(ns).split(',').map((s) => s.trim()),
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
