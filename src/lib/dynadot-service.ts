/**
 * Dynadot Reseller API service class.
 *
 * Implements the complete domain lifecycle:
 *  - Domain availability search (instant + bulk)
 *  - Register / Renew / Transfer
 *  - Get domain information
 *  - List customer domains
 *  - Lock / Unlock domain
 *  - Enable / Disable Whois privacy
 *  - Get EPP / Auth code
 *  - Set Nameservers
 *  - Configure DNS (A, AAAA, CNAME, MX, TXT, SRV, CAA, NS)
 *  - Domain contacts
 *  - Domain expiration information
 *  - Auto-renew management
 *
 * API docs: https://www.dynadot.com/domain/api3.html
 *
 * When DYNADOT_API_KEY is not set, the service runs in DEMO MODE and returns
 * deterministic simulated data so the full application can be exercised without
 * a real registrar account.
 *
 * Design notes:
 *  - SOLID: single responsibility (Dynadot API communication only)
 *  - Repository/Service pattern: this is the provider gateway; domain state
 *    persistence lives in the DomainService orchestrator.
 *  - Retry with exponential backoff for transient network errors.
 *  - Rate-limit aware (429 → honours Retry-After).
 */
import { isDynadotDemoMode } from './dynadot'

const API_BASE = 'https://api.dynadot.com/api3.json'
const MAX_RETRIES = 3
const BASE_DELAY_MS = 500

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DomainSearchResult {
  domain: string
  available: boolean
  premium: boolean
  registrationPrice?: number
  renewalPrice?: number
  transferPrice?: number
  currency?: string
}

export interface DomainInfo {
  domain: string
  status: string
  expiry?: string
  registeredAt?: string
  nameservers: string[]
  locked: boolean
  whoisPrivacy: boolean
  autoRenew: boolean
  premium: boolean
}

export interface DnsRecordInput {
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV' | 'CAA' | 'NS'
  name: string // subdomain or @
  value: string
  ttl?: number
  priority?: number
}

export interface DomainContactInput {
  type: 'registrant' | 'admin' | 'tech' | 'billing'
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

export interface RegisterResult {
  success: boolean
  orderId?: string
  registrationPrice?: number
  domain?: string
}

export interface RenewResult {
  success: boolean
  orderId?: string
  renewalPrice?: number
  newExpiry?: string
}

export interface TransferResult {
  success: boolean
  orderId?: string
  message?: string
}

// ─── Demo data ────────────────────────────────────────────────────────────────

const DEMO_TLD_PRICES: Record<string, { reg: number; renew: number; transfer: number }> = {
  '.com': { reg: 9.99, renew: 9.99, transfer: 9.99 },
  '.net': { reg: 11.99, renew: 11.99, transfer: 11.99 },
  '.org': { reg: 10.99, renew: 10.99, transfer: 10.99 },
  '.info': { reg: 14.99, renew: 14.99, transfer: 14.99 },
  '.biz': { reg: 12.99, renew: 12.99, transfer: 12.99 },
  '.co': { reg: 24.99, renew: 24.99, transfer: 24.99 },
  '.io': { reg: 32.0, renew: 32.0, transfer: 32.0 },
  '.app': { reg: 14.99, renew: 14.99, transfer: 14.99 },
  '.dev': { reg: 14.99, renew: 14.99, transfer: 14.99 },
  '.ai': { reg: 69.99, renew: 69.99, transfer: 69.99 },
  '.xyz': { reg: 3.99, renew: 9.99, transfer: 9.99 },
  '.online': { reg: 8.99, renew: 29.99, transfer: 29.99 },
  '.site': { reg: 7.99, renew: 29.99, transfer: 29.99 },
  '.store': { reg: 9.99, renew: 49.99, transfer: 49.99 },
  '.tech': { reg: 9.99, renew: 39.99, transfer: 39.99 },
  '.cloud': { reg: 9.99, renew: 19.99, transfer: 19.99 },
  '.live': { reg: 9.99, renew: 24.99, transfer: 24.99 },
  '.me': { reg: 14.99, renew: 14.99, transfer: 14.99 },
  '.us': { reg: 8.99, renew: 8.99, transfer: 8.99 },
  '.ca': { reg: 12.99, renew: 12.99, transfer: 12.99 },
  '.uk': { reg: 7.99, renew: 7.99, transfer: 7.99 },
  '.eu': { reg: 7.99, renew: 7.99, transfer: 7.99 },
  '.de': { reg: 6.99, renew: 6.99, transfer: 6.99 },
  '.fr': { reg: 9.99, renew: 9.99, transfer: 9.99 },
  '.it': { reg: 9.99, renew: 9.99, transfer: 9.99 },
  '.nl': { reg: 8.99, renew: 8.99, transfer: 8.99 },
  '.in': { reg: 9.99, renew: 9.99, transfer: 9.99 },
  '.co.uk': { reg: 7.99, renew: 7.99, transfer: 7.99 },
  '.org.uk': { reg: 7.99, renew: 7.99, transfer: 7.99 },
  '.africa': { reg: 14.99, renew: 14.99, transfer: 14.99 },
  '.shop': { reg: 9.99, renew: 29.99, transfer: 29.99 },
}

function demoIsAvailable(domain: string): boolean {
  const lower = domain.toLowerCase()
  if (lower.includes('taken') || lower.includes('unavailable')) return false
  if (lower.includes('premium')) return true
  // Deterministic pseudo-randomness based on string hash
  const tld = '.' + lower.split('.').slice(1).join('.')
  if (!DEMO_TLD_PRICES[tld]) return false
  let hash = 0
  for (let i = 0; i < lower.length; i++) {
    hash = (hash << 5) - hash + lower.charCodeAt(i)
    hash |= 0
  }
  // ~60% available
  return Math.abs(hash) % 10 < 6
}

function demoIsPremium(domain: string): boolean {
  const lower = domain.toLowerCase()
  if (lower.includes('premium')) return true
  // Short single-word .com / .ai treated as premium
  const base = lower.split('.')[0]
  return (base.length <= 4 && (lower.endsWith('.com') || lower.endsWith('.ai')))
}

// ─── Service class ────────────────────────────────────────────────────────────

class DynadotService {
  private apiKey: string | null

  constructor() {
    this.apiKey = process.env.DYNADOT_API_KEY || null
  }

  get demoMode(): boolean {
    return !this.apiKey
  }

  /**
   * Low-level call to Dynadot with retry + backoff + rate-limit handling.
   */
  private async call(
    params: Record<string, string>,
    attempt = 0
  ): Promise<Record<string, unknown>> {
    if (!this.apiKey) {
      throw new Error('DYNADOT_API_KEY not configured')
    }
    const url = new URL(API_BASE)
    url.searchParams.set('key', this.apiKey)
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v)
    }

    try {
      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })

      // Rate limited
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '2', 10)
        if (attempt < MAX_RETRIES) {
          await this.sleep(retryAfter * 1000)
          return this.call(params, attempt + 1)
        }
        throw new Error('Dynadot rate limit exceeded')
      }

      // 5xx → retry
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        await this.sleep(BASE_DELAY_MS * Math.pow(2, attempt))
        return this.call(params, attempt + 1)
      }

      if (!res.ok) {
        throw new Error(`Dynadot API HTTP ${res.status}: ${await res.text()}`)
      }

      const json = (await res.json()) as Record<string, unknown>

      // Dynadot returns HTTP 200 but embeds errors in the body.
      // Errors can appear in ANY top-level *Response envelope, not just "Response"
      // (e.g. domain_info → DomainInfoResponse, get_ns → GetNsResponse).
      // Detect IP-authorization errors specifically — these are not
      // retryable (retrying just hits another unauthorized IP).
      const envelopes = [
        json.Response,
        json.DomainInfoResponse,
        json.GetNsResponse,
        json.SetNsResponse,
        json.SearchResponse,
      ]
        .filter(Boolean) as Array<Record<string, unknown>>
      for (const env of envelopes) {
        if (env.ResponseCode === '-1' || env.ResponseCode === -1 || env.Status === 'error') {
          const errMsg = String(env.Error || 'Unknown Dynadot error')
          if (errMsg.includes('unauthorized ip address')) {
            // Non-retryable — throw immediately, bypass the catch retry
            const ipErr = new Error(`Dynadot IP not authorized: ${errMsg}`)
            ;(ipErr as Error & { noRetry?: boolean }).noRetry = true
            throw ipErr
          }
          // Search errors with "invalid characters" are also non-retryable
          if (errMsg.includes('invalid characters')) {
            const charErr = new Error(`Dynadot API error: ${errMsg}`)
            ;(charErr as Error & { noRetry?: boolean }).noRetry = true
            throw charErr
          }
          throw new Error(`Dynadot API error: ${errMsg}`)
        }
      }

      return json
    } catch (err) {
      // Network failure → retry (but never retry IP-auth or non-retryable errors)
      const noRetry = err instanceof Error && (err as Error & { noRetry?: boolean }).noRetry
      if (noRetry) throw err
      if (attempt < MAX_RETRIES && !(err instanceof Error && err.message.includes('rate limit'))) {
        await this.sleep(BASE_DELAY_MS * Math.pow(2, attempt))
        return this.call(params, attempt + 1)
      }
      throw err
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }

  private tldOf(domain: string): string {
    const parts = domain.toLowerCase().split('.')
    if (parts.length >= 3 && ['co', 'org', 'com'].includes(parts[parts.length - 2])) {
      return '.' + parts.slice(-2).join('.')
    }
    return '.' + parts[parts.length - 1]
  }

  // ─── Search ──────────────────────────────────────────────────────────────

  /**
   * Instant search for a single domain.
   */
  async search(domain: string): Promise<DomainSearchResult> {
    const results = await this.bulkSearch([domain])
    return results[0]
  }

  /**
   * Bulk search across many domains at once.
   *
   * Uses `show_price=1` so Dynadot returns real Registration + Renewal prices
   * in the `Price` field (a human-readable string we parse).
   */
  async bulkSearch(domains: string[]): Promise<DomainSearchResult[]> {
    const cleaned = domains.map((d) => d.toLowerCase().trim()).filter(Boolean)

    if (this.demoMode) {
      return cleaned.map((domain) => {
        const tld = this.tldOf(domain)
        const prices = DEMO_TLD_PRICES[tld]
        const available = prices ? demoIsAvailable(domain) : false
        const premium = demoIsPremium(domain)
        return {
          domain,
          available,
          premium,
          registrationPrice: available ? prices?.reg : undefined,
          renewalPrice: available ? prices?.renew : undefined,
          transferPrice: available ? prices?.transfer : undefined,
          currency: 'USD',
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
    cleaned.forEach((d, i) => {
      searchParams[`domain${i}`] = d
    })
    const json = await this.call(searchParams)
    const out: DomainSearchResult[] = []

    // Dynadot search API returns:
    //   { SearchResponse: { ResponseCode: "0", SearchResults: [{ DomainName, Status, Available: "yes"|"no", Price?, Premium? }] } }
    // Price (when show_price=1) is a string like:
    //   "Registration Price: 10.88 in USD and Renewal price: 10.88 in USD and Domain is not a Premium Domain"
    const searchResp = json.SearchResponse as
      | { SearchResults?: Array<Record<string, unknown>> }
      | undefined

    if (searchResp?.SearchResults && Array.isArray(searchResp.SearchResults)) {
      for (const item of searchResp.SearchResults) {
        const name = String(item.DomainName || '')
        // Dynadot returns Available as "yes"/"no" (string)
        const available = String(item.Available || '').toLowerCase() === 'yes'
        const priceRaw = item.Price ? String(item.Price) : ''
        const parsed = this.parsePriceString(priceRaw)
        const premium = parsed?.premium ?? (String(item.Premium || '').toLowerCase() === 'yes')
        out.push({
          domain: name,
          available,
          premium,
          registrationPrice: parsed?.registration,
          renewalPrice: parsed?.renewal,
          transferPrice: parsed?.renewal, // Dynadot transfer = renewal
          currency: 'USD',
        })
      }
    } else {
      // Fallback: old Dynadot format { Response: { domain0: {...}, domain1: {...} } }
      const response = (json.Response as Record<string, unknown>) || {}
      for (const [key, value] of Object.entries(response)) {
        if (key.startsWith('domain') && typeof value === 'object' && value !== null) {
          const dv = value as { Name?: string; Available?: string; Price?: string; Premium?: string }
          const name = dv.Name || ''
          const parsed = this.parsePriceString(dv.Price)
          out.push({
            domain: name,
            available: String(dv.Available).toLowerCase() === 'yes',
            premium: parsed?.premium ?? (String(dv.Premium || '').toLowerCase() === 'yes'),
            registrationPrice: parsed?.registration,
            renewalPrice: parsed?.renewal,
            transferPrice: parsed?.renewal,
            currency: 'USD',
          })
        }
      }
    }

    // Ensure all requested domains have an entry
    return cleaned.map((d) => {
      const found = out.find((r) => r.domain.toLowerCase() === d)
      return (
        found || {
          domain: d,
          available: false,
          premium: false,
        }
      )
    })
  }

  /**
   * Parse Dynadot's `show_price=1` Price string.
   * Example: "Registration Price: 10.88 in USD and Renewal price: 10.88 in USD and Domain is not a Premium Domain"
   */
  private parsePriceString(
    raw: string | undefined
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
   * TLD suggestions for a base name.
   */
  async suggestTlds(baseName: string, tlds?: string[]): Promise<DomainSearchResult[]> {
    const base = baseName.toLowerCase().split('.')[0]
    const targetTlds = tlds && tlds.length > 0 ? tlds : Object.keys(DEMO_TLD_PRICES).slice(0, 10)
    const candidates = targetTlds.map((t) => (t.startsWith('.') ? base + t : base + '.' + t))
    return this.bulkSearch(candidates)
  }

  // ─── Register ────────────────────────────────────────────────────────────

  async register(
    domain: string,
    duration: number,
    contacts?: DomainContactInput[]
  ): Promise<RegisterResult> {
    if (this.demoMode) {
      const tld = this.tldOf(domain)
      const price = DEMO_TLD_PRICES[tld]?.reg ?? 19.99
      return {
        success: true,
        orderId: `demo-order-${Date.now()}`,
        registrationPrice: price * duration,
        domain,
      }
    }

    const params: Record<string, string> = {
      command: 'register',
      domain,
      duration: String(duration),
    }
    if (contacts && contacts.length > 0) {
      params.contact_info = JSON.stringify(contacts)
    }
    const json = await this.call(params)
    const response = (json.Response as Record<string, unknown>) || {}
    const status = String(response.Status || '').toLowerCase()
    return {
      success: status === 'success' || status === 'register success',
      orderId: (response.RegisterOrderId as string) || (response.OrderId as string),
      registrationPrice: response.Price ? parseFloat(String(response.Price)) : undefined,
      domain,
    }
  }

  // ─── Renew ───────────────────────────────────────────────────────────────

  async renew(domain: string, duration: number): Promise<RenewResult> {
    if (this.demoMode) {
      const tld = this.tldOf(domain)
      const price = DEMO_TLD_PRICES[tld]?.renew ?? 19.99
      const newExpiry = new Date()
      newExpiry.setFullYear(newExpiry.getFullYear() + duration)
      return {
        success: true,
        orderId: `demo-renew-${Date.now()}`,
        renewalPrice: price * duration,
        newExpiry: newExpiry.toISOString(),
      }
    }

    const json = await this.call({
      command: 'renew',
      domain,
      duration: String(duration),
    })
    const response = (json.Response as Record<string, unknown>) || {}
    const status = String(response.Status || '').toLowerCase()
    return {
      success: status === 'success' || status === 'renew success',
      orderId: (response.OrderId as string) || undefined,
      renewalPrice: response.Price ? parseFloat(String(response.Price)) : undefined,
      newExpiry: response.Expiration ? String(response.Expiration) : undefined,
    }
  }

  // ─── Transfer ────────────────────────────────────────────────────────────

  async transfer(domain: string, authCode: string): Promise<TransferResult> {
    if (this.demoMode) {
      return {
        success: true,
        orderId: `demo-transfer-${Date.now()}`,
        message: 'Transfer initiated (demo mode)',
      }
    }

    const json = await this.call({
      command: 'transfer',
      domain,
      auth: authCode,
    })
    const response = (json.Response as Record<string, unknown>) || {}
    const status = String(response.Status || '').toLowerCase()
    return {
      success: status === 'success' || status === 'transfer success',
      orderId: (response.OrderId as string) || undefined,
      message: response.Error ? String(response.Error) : 'Transfer initiated',
    }
  }

  // ─── Domain info ─────────────────────────────────────────────────────────

  async getDomainInfo(domain: string): Promise<DomainInfo> {
    if (this.demoMode) {
      const expiry = new Date()
      expiry.setFullYear(expiry.getFullYear() + 1)
      return {
        domain,
        status: 'active',
        expiry: expiry.toISOString(),
        registeredAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        nameservers: ['ns1.deployhub.io', 'ns2.deployhub.io'],
        locked: true,
        whoisPrivacy: true,
        autoRenew: true,
        premium: demoIsPremium(domain),
      }
    }

    const json = await this.call({ command: 'domain_info', domain })
    const resp = (json.DomainInfoResponse as Record<string, unknown>) || {}
    const info = (resp.DomainInfo || {}) as Record<string, unknown>

    // Expiration / Registration are Unix timestamps in MILLISECONDS
    const expiryRaw = info.Expiration ? String(info.Expiration) : undefined
    const expiry = expiryRaw && !isNaN(Number(expiryRaw))
      ? new Date(Number(expiryRaw)).toISOString()
      : undefined
    const regRaw = info.Registration ? String(info.Registration) : undefined
    const registeredAt = regRaw && !isNaN(Number(regRaw))
      ? new Date(Number(regRaw)).toISOString()
      : undefined

    // domain_info returns NameServerSettings (a mode object), NOT hostnames.
    // Fetch the real hostnames via the separate get_ns command.
    let nameservers: string[] = []
    try {
      const nsJson = await this.call({ command: 'get_ns', domain })
      const nsResp = (nsJson.GetNsResponse as Record<string, unknown>) || {}
      const nsHosts = nsResp.NameServer || nsResp.Ns
      if (Array.isArray(nsHosts)) {
        nameservers = nsHosts.map((s) => String(s).trim()).filter(Boolean)
      } else if (nsHosts) {
        nameservers = String(nsHosts).split(',').map((s) => s.trim()).filter(Boolean)
      }
    } catch {
      // best-effort — other fields are still useful
    }

    const renewOption = String(info.RenewOption || '').toLowerCase()
    return {
      domain,
      status: String(info.Status || 'unknown'),
      expiry,
      registeredAt,
      nameservers,
      locked: String(info.Locked || 'no').toLowerCase() === 'yes',
      whoisPrivacy: String(info.Privacy || 'none').toLowerCase() !== 'none',
      autoRenew: renewOption === 'auto' || renewOption === 'renew',
      premium: String(info.isForSale || 'no').toLowerCase() === 'yes',
    }
  }

  /**
   * List domains for the reseller account.
   */
  async listDomains(): Promise<DomainInfo[]> {
    if (this.demoMode) {
      return []
    }
    const json = await this.call({ command: 'list_domain' })
    const response = (json.Response as Record<string, unknown>) || {}
    const list = (response.Domains as unknown[]) || []
    return list.map((item) => {
      const d = item as Record<string, unknown>
      return {
        domain: String(d.Name || ''),
        status: String(d.Status || 'unknown'),
        expiry: d.Expiration ? String(d.Expiration) : undefined,
        nameservers: [],
        locked: true,
        whoisPrivacy: true,
        autoRenew: true,
        premium: false,
      } as DomainInfo
    })
  }

  // ─── Lock / Unlock ───────────────────────────────────────────────────────

  async lock(domain: string): Promise<{ success: boolean; locked: boolean }> {
    if (this.demoMode) {
      return { success: true, locked: true }
    }
    const json = await this.call({ command: 'lock', domain })
    const status = String((json.Response as Record<string, unknown>)?.Status || '').toLowerCase()
    return { success: status === 'success' || status === 'lock success', locked: true }
  }

  async unlock(domain: string): Promise<{ success: boolean; locked: boolean }> {
    if (this.demoMode) {
      return { success: true, locked: false }
    }
    const json = await this.call({ command: 'unlock', domain })
    const status = String((json.Response as Record<string, unknown>)?.Status || '').toLowerCase()
    return { success: status === 'success' || status === 'unlock success', locked: false }
  }

  // ─── Whois privacy ───────────────────────────────────────────────────────

  async enableWhoisPrivacy(domain: string): Promise<{ success: boolean; enabled: boolean }> {
    if (this.demoMode) {
      return { success: true, enabled: true }
    }
    const json = await this.call({ command: 'whois_privacy', domain, option: 'enable' })
    const status = String((json.Response as Record<string, unknown>)?.Status || '').toLowerCase()
    return { success: status === 'success', enabled: true }
  }

  async disableWhoisPrivacy(domain: string): Promise<{ success: boolean; enabled: boolean }> {
    if (this.demoMode) {
      return { success: true, enabled: false }
    }
    const json = await this.call({ command: 'whois_privacy', domain, option: 'disable' })
    const status = String((json.Response as Record<string, unknown>)?.Status || '').toLowerCase()
    return { success: status === 'success', enabled: false }
  }

  // ─── EPP / Auth code ─────────────────────────────────────────────────────

  async getAuthCode(domain: string): Promise<{ success: boolean; authCode?: string }> {
    if (this.demoMode) {
      // Generate a deterministic-looking demo auth code
      const code = `DH-${domain.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 6)}-${Date.now().toString(36).toUpperCase()}`
      return { success: true, authCode: code }
    }
    const json = await this.call({ command: 'get_auth_code', domain })
    const response = (json.Response as Record<string, unknown>) || {}
    const status = String(response.Status || '').toLowerCase()
    return {
      success: status === 'success',
      authCode: response.AuthCode ? String(response.AuthCode) : undefined,
    }
  }

  // ─── Nameservers ─────────────────────────────────────────────────────────

  async setNameservers(domain: string, nameservers: string[]): Promise<{ success: boolean }> {
    if (this.demoMode) {
      return { success: true }
    }
    const params: Record<string, string> = { command: 'set_ns', domain }
    nameservers.slice(0, 13).forEach((ns, i) => {
      params[`ns${i}`] = ns
    })
    const json = await this.call(params)
    const status = String((json.Response as Record<string, unknown>)?.Status || '').toLowerCase()
    return { success: status === 'success' }
  }

  // ─── DNS records ─────────────────────────────────────────────────────────

  async setDnsRecords(domain: string, records: DnsRecordInput[]): Promise<{ success: boolean }> {
    if (this.demoMode) {
      return { success: true }
    }
    const params: Record<string, string> = { command: 'set_dns2', domain }
    records.slice(0, 10).forEach((r, i) => {
      params[`main_record_type${i}`] = r.type
      params[`main_record${i}`] = r.value
      params[`main_record_name${i}`] = r.name
      params[`main_record_ttl${i}`] = String(r.ttl || 3600)
      if (r.priority !== undefined) {
        params[`main_record_priority${i}`] = String(r.priority)
      }
    })
    const json = await this.call(params)
    const status = String((json.Response as Record<string, unknown>)?.Status || '').toLowerCase()
    return { success: status === 'success' }
  }

  // ─── Contacts ────────────────────────────────────────────────────────────

  async setContacts(
    domain: string,
    contacts: DomainContactInput[]
  ): Promise<{ success: boolean }> {
    if (this.demoMode) {
      return { success: true }
    }
    const params: Record<string, string> = {
      command: 'set_contact',
      domain,
      contact_info: JSON.stringify(contacts),
    }
    const json = await this.call(params)
    const status = String((json.Response as Record<string, unknown>)?.Status || '').toLowerCase()
    return { success: status === 'success' }
  }

  // ─── Auto-renew ──────────────────────────────────────────────────────────

  async enableAutoRenew(domain: string): Promise<{ success: boolean; enabled: boolean }> {
    if (this.demoMode) {
      return { success: true, enabled: true }
    }
    const json = await this.call({ command: 'set_auto_renew', domain, option: 'on' })
    const status = String((json.Response as Record<string, unknown>)?.Status || '').toLowerCase()
    return { success: status === 'success', enabled: true }
  }

  async disableAutoRenew(domain: string): Promise<{ success: boolean; enabled: boolean }> {
    if (this.demoMode) {
      return { success: true, enabled: false }
    }
    const json = await this.call({ command: 'set_auto_renew', domain, option: 'off' })
    const status = String((json.Response as Record<string, unknown>)?.Status || '').toLowerCase()
    return { success: status === 'success', enabled: false }
  }

  // ─── Expiration info ─────────────────────────────────────────────────────

  async getExpiration(domain: string): Promise<{ expiry?: string; daysUntilExpiry?: number }> {
    const info = await this.getDomainInfo(domain)
    if (!info.expiry) return {}
    const expiryDate = new Date(info.expiry)
    const days = Math.ceil((expiryDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    return { expiry: info.expiry, daysUntilExpiry: days }
  }
}

// Export a singleton instance (Service Locator pattern)
export const dynadotService = new DynadotService()
export { isDynadotDemoMode }
