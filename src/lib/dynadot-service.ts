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
 * When DYNADOT_API_KEY is not set OUTSIDE production, the service runs in DEMO
 * MODE and returns deterministic simulated data so the application can be
 * exercised without a real registrar account. In production a missing key is
 * an error on every call (RegistrarNotConfiguredError) — never a simulation.
 *
 * Design notes:
 *  - SOLID: single responsibility (Dynadot API communication only)
 *  - Repository/Service pattern: this is the provider gateway; domain state
 *    persistence lives in the DomainService orchestrator.
 *  - Retry with exponential backoff for transient network errors.
 *  - Rate-limit aware (429 → honours Retry-After).
 */
import {
  isDynadotDemoMode,
  isDynadotSimulated,
  RegistrarNotConfiguredError,
  RegistrarUnknownOutcomeError,
  isRegistrarUnknownOutcome,
  isPurchaseCommand,
  dynadotEnvelopes,
  dynadotEnvelopeError,
  parsePurchaseResponse,
  parseRegistrarDate,
  DYNADOT_REQUEST_TIMEOUT_MS,
  assertDnsWriteAllowed,
  addDnsRecordsVia,
  deleteDnsRecordVia,
  updateDnsRecordVia,
  type DnsWriteResult,
} from './dynadot'
import { NS1_HOSTNAME, NS2_HOSTNAME } from './brand-config'

const API_BASE = 'https://api.dynadot.com/api3.json'
const MAX_RETRIES = 3
const BASE_DELAY_MS = 500

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * What a lookup actually established. `unknown` means the registrar did not
 * answer for this domain (error, timeout, missing from the reply): it is
 * neither available nor taken, and must never be sold or shown as either.
 */
export type DomainSearchStatus = 'available' | 'unavailable' | 'premium' | 'unknown'

export interface DomainSearchResult {
  domain: string
  /** True only when the registrar said "yes". False for unavailable AND unknown: read `status`. */
  available: boolean
  premium: boolean
  status: DomainSearchStatus
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
  /** Registrar's refusal message when success is false. */
  error?: string
}

/**
 * Dynadot contact IDs, keyed by role, as returned by `create_contact`.
 * The register command takes IDs — not inline contact data.
 */
export interface DynadotContactIds {
  registrant?: string
  admin?: string
  tech?: string
  billing?: string
}

export interface RenewResult {
  success: boolean
  orderId?: string
  renewalPrice?: number
  /** ISO date, only when the registrar reported a parsable expiry. */
  newExpiry?: string
  error?: string
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

/**
 * Split a free-text phone number into the country code and subscriber number
 * that Dynadot's `phonecc` / `phonenum` parameters expect.
 *
 * Accepts the shapes customers actually type — "+252 61 234 5678",
 * "00252612345678", "252-61-234-5678" — and falls back to a 1-3 digit prefix
 * heuristic when there is no explicit "+" marker.
 */
export function splitPhone(raw?: string): { cc: string; num: string } {
  if (!raw) return { cc: '', num: '' }

  const trimmed = raw.trim()
  // "00" is the ITU international prefix — equivalent to a leading "+".
  const explicit = trimmed.startsWith('+')
    ? trimmed.slice(1)
    : trimmed.startsWith('00')
    ? trimmed.slice(2)
    : null

  const digits = (explicit ?? trimmed).replace(/\D/g, '')
  if (!digits) return { cc: '', num: '' }

  // No international marker: assume the number is already national-format
  // and leave the country code for the caller/registrar default.
  if (explicit === null) return { cc: '', num: digits }

  // Country calling codes are 1-3 digits. "1" (NANP) and "7" are the only
  // single-digit codes; codes starting 2/3/4/5/6/8/9 are 2-3 digits, and the
  // 3-digit ones all begin with a known 2-digit prefix range.
  let ccLen = 3
  if (digits.startsWith('1') || digits.startsWith('7')) {
    ccLen = 1
  } else if (/^(2[07]|3[0-46-9]|4[013-9]|5[1-8]|6[0-6]|8[1246]|9[0-58])/.test(digits)) {
    ccLen = 2
  }

  return { cc: digits.slice(0, ccLen), num: digits.slice(ccLen) }
}

// ─── Service class ────────────────────────────────────────────────────────────

class DynadotService {
  // Read on every call, not once at startup: keys saved in Admin
  // (lib/dynadot-settings) replace process.env while the server runs.
  private get apiKey(): string | null {
    return process.env.DYNADOT_API_KEY || null
  }

  /**
   * Simulated data is served ONLY when no key is configured AND this is not
   * production. In production a missing key makes every call throw
   * RegistrarNotConfiguredError: no invented availability, no fake orders.
   */
  get demoMode(): boolean {
    return isDynadotSimulated()
  }

  /** True when a real registrar key is configured. */
  get configured(): boolean {
    return !!this.apiKey
  }

  /**
   * Low-level call to Dynadot.
   *
   * Read-only and idempotent commands are retried with backoff on 429, 5xx,
   * network errors, unparsable bodies and transient body errors. PURCHASE
   * commands (register, renew, transfer, ...) are NEVER retried: a retry after
   * an ambiguous failure can buy twice. For them, any failure after the request
   * may have reached Dynadot (network/timeout, 5xx, unparsable body) throws
   * RegistrarUnknownOutcomeError so the caller parks the order for
   * reconciliation instead of trying again.
   */
  private async call(params: Record<string, string>): Promise<Record<string, unknown>> {
    const key = this.apiKey
    if (!key) throw new RegistrarNotConfiguredError()
    const command = params.command
    const purchase = isPurchaseCommand(command)
    const url = new URL(API_BASE)
    url.searchParams.set('key', key)
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v)
    }

    for (let attempt = 0; ; attempt++) {
      const canRetry = !purchase && attempt < MAX_RETRIES
      const backoff = () => this.sleep(BASE_DELAY_MS * Math.pow(2, attempt))

      let res: Response
      try {
        res = await fetch(url.toString(), {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(DYNADOT_REQUEST_TIMEOUT_MS),
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (purchase) throw new RegistrarUnknownOutcomeError(command, `network/timeout: ${msg}`)
        if (canRetry) {
          await backoff()
          continue
        }
        throw err
      }

      // Rate limited: the request was refused, not executed.
      if (res.status === 429) {
        if (canRetry) {
          const retryAfter = parseInt(res.headers.get('retry-after') || '2', 10)
          await this.sleep((Number.isFinite(retryAfter) ? retryAfter : 2) * 1000)
          continue
        }
        throw new Error('Dynadot rate limit exceeded')
      }

      if (res.status >= 500) {
        if (purchase) throw new RegistrarUnknownOutcomeError(command, `HTTP ${res.status}`)
        if (canRetry) {
          await backoff()
          continue
        }
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Dynadot API HTTP ${res.status}: ${text.slice(0, 300)}`)
      }

      let json: Record<string, unknown>
      try {
        json = (await res.json()) as Record<string, unknown>
        if (!json || typeof json !== 'object') throw new Error('empty body')
      } catch {
        if (purchase) throw new RegistrarUnknownOutcomeError(command, 'unparsable response body')
        if (canRetry) {
          await backoff()
          continue
        }
        throw new Error('Dynadot API returned an unparsable response')
      }

      // Dynadot answers HTTP 200 with errors embedded in ANY top-level
      // *Response envelope. A body error is a definite answer.
      const bodyErr = dynadotEnvelopes(json)
        .map((env) => dynadotEnvelopeError(env))
        .find((e): e is string => !!e)
      if (bodyErr) {
        // Not retryable: retrying just hits the same refusal.
        if (bodyErr.includes('unauthorized ip address')) {
          throw new Error(`Dynadot IP not authorized: ${bodyErr}`)
        }
        if (canRetry && !bodyErr.includes('invalid characters')) {
          await backoff()
          continue
        }
        throw new Error(`Dynadot API error: ${bodyErr}`)
      }
      return json
    }
  }

  /**
   * Send a purchase command. A definite refusal thrown by call() (body error,
   * 4xx, 429, IP not authorised) is returned as an error envelope so the
   * parser classifies it as 'failed'. Unknown-outcome and not-configured
   * errors propagate unchanged; anything else is treated as ambiguous.
   */
  private async purchaseCall(
    kind: 'register' | 'renew' | 'transfer',
    params: Record<string, string>
  ): Promise<Record<string, unknown>> {
    try {
      return await this.call(params)
    } catch (err) {
      if (isRegistrarUnknownOutcome(err) || err instanceof RegistrarNotConfiguredError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      if (
        msg.startsWith('Dynadot API error:') ||
        msg.startsWith('Dynadot API HTTP 4') ||
        msg.startsWith('Dynadot IP not authorized') ||
        msg.includes('rate limit')
      ) {
        return { Response: { ResponseCode: '-1', Status: 'error', Error: msg } }
      }
      throw new RegistrarUnknownOutcomeError(kind, msg)
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
          status: (available ? (premium ? 'premium' : 'available') : 'unavailable') as DomainSearchStatus,
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
        const availRaw = String(item.Available ?? '').trim().toLowerCase()
        const available = availRaw === 'yes'
        const priceRaw = item.Price ? String(item.Price) : ''
        const parsed = this.parsePriceString(priceRaw)
        const premium = parsed?.premium ?? (String(item.Premium || '').toLowerCase() === 'yes')
        const status = this.searchStatus(availRaw, premium, item)
        out.push({
          domain: name,
          available: status === 'available' || status === 'premium',
          premium,
          status,
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
          const availRaw = String(dv.Available ?? '').trim().toLowerCase()
          const premium = parsed?.premium ?? (String(dv.Premium || '').toLowerCase() === 'yes')
          const status = this.searchStatus(availRaw, premium, dv as Record<string, unknown>)
          out.push({
            domain: name,
            available: status === 'available' || status === 'premium',
            premium,
            status,
            registrationPrice: parsed?.registration,
            renewalPrice: parsed?.renewal,
            transferPrice: parsed?.renewal,
            currency: 'USD',
          })
        }
      }
    }

    // Every requested domain gets an entry. One the registrar did not report
    // on is UNKNOWN: not "unavailable", and certainly not "available".
    return cleaned.map((d) => {
      const found = out.find((r) => r.domain.toLowerCase() === d)
      return (
        found || {
          domain: d,
          available: false,
          premium: false,
          status: 'unknown' as DomainSearchStatus,
        }
      )
    })
  }

  /** Map one search item to a status. Anything but an explicit yes/no is unknown. */
  private searchStatus(
    availRaw: string,
    premium: boolean,
    item: Record<string, unknown>
  ): DomainSearchStatus {
    const itemStatus = String(item.Status ?? '').trim().toLowerCase()
    if (itemStatus === 'error' || (item.Error !== undefined && item.Error !== null && String(item.Error).trim() !== '')) {
      return 'unknown'
    }
    if (availRaw === 'yes') return premium ? 'premium' : 'available'
    if (availRaw === 'no') return 'unavailable'
    return 'unknown'
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

  /**
   * Create a contact record at the registrar and return its Dynadot contact ID.
   *
   * ICANN requires real registrant data on every gTLD registration, and many
   * TLDs reject an order outright without it. Dynadot's API3 takes contact
   * *IDs* on the register command, so contacts must be created first — passing
   * inline contact JSON (which this client used to do) is silently ignored and
   * the order falls back to the account's default contact.
   *
   * Docs: https://www.dynadot.com/domain/api3.html#create_contact
   */
  async createContact(contact: DomainContactInput): Promise<string> {
    if (this.demoMode) {
      return `demo-contact-${Date.now()}-${contact.type}`
    }

    const { cc, num } = splitPhone(contact.phone)
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

    const json = await this.call(params)
    const envelope =
      (json.CreateContactResponse as Record<string, unknown>) ||
      (json.Response as Record<string, unknown>) ||
      {}
    const contactId =
      (envelope.ContactId as string | number | undefined) ??
      ((envelope.CreateContact as Record<string, unknown> | undefined)
        ?.ContactId as string | number | undefined)

    if (contactId === undefined || contactId === null || contactId === '') {
      throw new Error(
        `Dynadot create_contact returned no ContactId for ${contact.type}`
      )
    }
    return String(contactId)
  }

  /**
   * Create every supplied contact and map them onto the four registrar roles.
   *
   * Only the registrant is mandatory; admin/tech/billing fall back to the
   * registrant's ID, which is what registrars expect when a customer supplies
   * a single contact.
   */
  async createContacts(
    contacts: DomainContactInput[]
  ): Promise<DynadotContactIds> {
    const ids: DynadotContactIds = {}
    for (const contact of contacts) {
      ids[contact.type] = await this.createContact(contact)
    }
    const fallback = ids.registrant || ids.admin || ids.tech || ids.billing
    if (!fallback) return ids
    return {
      registrant: ids.registrant || fallback,
      admin: ids.admin || fallback,
      tech: ids.tech || fallback,
      billing: ids.billing || fallback,
    }
  }

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

    // Register the contacts first, then reference them by ID. A failure here
    // must abort the registration: silently falling back to the account's
    // default contact would put OUR details on the CUSTOMER'S domain.
    if (contacts && contacts.length > 0) {
      const ids = await this.createContacts(contacts)
      if (ids.registrant) params.registrant_contact = ids.registrant
      if (ids.admin) params.admin_contact = ids.admin
      if (ids.tech) params.technical_contact = ids.tech
      if (ids.billing) params.billing_contact = ids.billing
    }

    const json = await this.purchaseCall('register', params)
    const parsed = parsePurchaseResponse('register', json)
    if (parsed.outcome === 'unknown') {
      throw new RegistrarUnknownOutcomeError('register', parsed.reason)
    }
    if (parsed.outcome === 'failed') {
      return { success: false, error: parsed.error, domain }
    }
    return {
      success: true,
      orderId: parsed.orderId,
      registrationPrice: parsed.price,
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

    const json = await this.purchaseCall('renew', {
      command: 'renew',
      domain,
      duration: String(duration),
    })
    const parsed = parsePurchaseResponse('renew', json)
    if (parsed.outcome === 'unknown') {
      throw new RegistrarUnknownOutcomeError('renew', parsed.reason)
    }
    if (parsed.outcome === 'failed') return { success: false, error: parsed.error }
    return {
      success: true,
      orderId: parsed.orderId,
      renewalPrice: parsed.price,
      newExpiry: parsed.expiration,
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

    const json = await this.purchaseCall('transfer', {
      command: 'transfer',
      domain,
      auth: authCode,
    })
    const parsed = parsePurchaseResponse('transfer', json)
    if (parsed.outcome === 'unknown') {
      throw new RegistrarUnknownOutcomeError('transfer', parsed.reason)
    }
    if (parsed.outcome === 'failed') return { success: false, message: parsed.error }
    return {
      success: true,
      orderId: parsed.orderId,
      message: 'Transfer initiated',
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
        nameservers: [NS1_HOSTNAME, NS2_HOSTNAME],
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
    // Expiration / Registration are epoch milliseconds (number or numeric string).
    const expiry = parseRegistrarDate(info.Expiration)?.toISOString()
    const registeredAt = parseRegistrarDate(info.Registration)?.toISOString()

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

  /**
   * Add DNS records. APPENDS to the live zone (add_dns_to_current_setting=1)
   * and never replaces it — see the DNS section of lib/dynadot for the rules.
   * Throws DnsWriteRefusedError for brand/panel domains and impossible writes.
   */
  async setDnsRecords(domain: string, records: DnsRecordInput[]): Promise<DnsWriteResult> {
    assertDnsWriteAllowed(domain)
    if (this.demoMode) {
      return { success: true, written: 0 }
    }
    return addDnsRecordsVia((p) => this.call(p), domain, records)
  }

  /** Remove one record, writing back every other record in the live zone. */
  async deleteDnsRecord(domain: string, target: DnsRecordInput): Promise<DnsWriteResult> {
    assertDnsWriteAllowed(domain)
    if (this.demoMode) {
      return { success: true, written: 0 }
    }
    return deleteDnsRecordVia((p) => this.call(p), domain, target)
  }

  /** Replace one record in place, writing back every other record. */
  async updateDnsRecord(
    domain: string,
    target: DnsRecordInput,
    replacement: DnsRecordInput
  ): Promise<DnsWriteResult> {
    assertDnsWriteAllowed(domain)
    if (this.demoMode) {
      return { success: true, written: 0 }
    }
    return updateDnsRecordVia((p) => this.call(p), domain, target, replacement)
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
export {
  isDynadotDemoMode,
  isDynadotSimulated,
  RegistrarNotConfiguredError,
  RegistrarUnknownOutcomeError,
  isRegistrarUnknownOutcome,
}
