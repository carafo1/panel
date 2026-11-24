import { NextResponse } from 'next/server'
import { isDynadotDemoMode } from '@/lib/dynadot'
import { dynadotService, type DomainSearchStatus, type DomainSearchResult } from '@/lib/dynadot-service'
import { getPriceForDomain, tldFromDomain, getAllPrices, type PricedTld } from '@/lib/pricing'
import { ok, fail, apiError } from '@/lib/api-response'
import { withRateLimit } from '@/lib/rate-limit'

/**
 * Domain availability search with SELLING prices.
 *
 * Every result carries a `status`:
 *   available    the registrar said yes, and (if `sellable`) we quote a price
 *   unavailable  the registrar said no
 *   premium      registrar-premium name: not sold here, no price shown
 *   unknown      the registrar did not answer for it (error, timeout, missing
 *                from the reply). Never shown as available OR as taken.
 *
 * A price is shown only for an available, non-premium domain whose TLD has an
 * ACTIVE price row. Wholesale prices are never returned.
 *
 * SECURITY:
 *   - Rate-limited (20 req/min per IP) to prevent registrar API abuse
 *   - Registrar errors are logged server-side only, never returned to client
 */

const PROVIDER = () => (isDynadotDemoMode() ? 'apsamo-demo' : 'apsamo')

/** Selling price for a search hit, or null when it must not be quoted. */
function sellingQuote(
  status: DomainSearchStatus,
  row: Pick<PricedTld, 'registration' | 'renewal' | 'transfer'> | null | undefined
): { registration: number; renewal: number; transfer: number } | null {
  if (status !== 'available' || !row || !(row.registration > 0)) return null
  return { registration: row.registration, renewal: row.renewal, transfer: row.transfer }
}

/** `available` as the API reports it: null when we do not know. */
function availableFlag(status: DomainSearchStatus): boolean | null {
  if (status === 'unknown') return null
  return status === 'available' || status === 'premium'
}

/**
 * A registrable domain name: labels of letters, digits and inner hyphens
 * (punycode "xn--" allowed), at least one dot, a letter-only (or xn--) TLD.
 * Anything else used to be sent to the registrar, come back as "unknown", and
 * be shown as "we couldn't check right now, try again" instead of "invalid".
 */
const DOMAIN_RE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/
function isSearchableDomain(name: string): boolean {
  return DOMAIN_RE.test(name)
}
const INVALID_DOMAIN_MESSAGE = 'Enter a valid domain name, for example mybrand.com'

function unknownResponse() {
  return fail('We could not confirm whether this domain is available. Please try again.', {
    status: 503,
    errors: [{ code: 'availability_unknown', message: 'Availability could not be confirmed' }],
  })
}

async function lookup(domains: string[]): Promise<DomainSearchResult[]> {
  try {
    return await dynadotService.bulkSearch(domains)
  } catch (err) {
    console.error('[domains/search] registrar lookup failed:', err)
    return domains.map((d) => ({ domain: d, available: false, premium: false, status: 'unknown' as const }))
  }
}

async function getHandler(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const domain = searchParams.get('domain')
    if (!domain) {
      return apiError.badRequest('Domain query parameter is required')
    }

    const domainLower = domain.toLowerCase().trim()
    if (!isSearchableDomain(domainLower)) return apiError.badRequest(INVALID_DOMAIN_MESSAGE)
    const tld = tldFromDomain(domainLower)

    const [primary] = await lookup([domainLower])
    if (!primary || primary.status === 'unknown') return unknownResponse()

    const priceRow = await getPriceForDomain(domainLower)
    const quote = sellingQuote(primary.status, priceRow)
    const sellable = !!quote

    // ─── Suggestions across other (active, priced) TLDs ───────────────
    const allPrices = await getAllPrices()
    const POPULAR_TLDS = ['.com', '.net', '.org', '.io', '.co', '.dev', '.app', '.xyz', '.ai', '.store']
    const activeTldSet = new Set(allPrices.map((p) => p.tld))
    const popularFirst = POPULAR_TLDS.filter((t) => t !== tld && activeTldSet.has(t))
    const remaining = allPrices.map((p) => p.tld).filter((t) => t !== tld && !popularFirst.includes(t))
    const suggestionTlds = [...popularFirst, ...remaining].slice(0, 8)
    const baseName = domainLower.substring(0, domainLower.lastIndexOf('.'))
    const suggestionDomains = suggestionTlds.map((t) => `${baseName}${t}`)

    const sugResults = suggestionDomains.length > 0 ? await lookup(suggestionDomains) : []
    // Suggestions the registrar could not answer for are left out.
    const suggestions = sugResults
      .filter((r) => r.status !== 'unknown')
      .map((r) => {
        const q = sellingQuote(r.status, allPrices.find((p) => p.tld === tldFromDomain(r.domain)))
        return {
          domain: r.domain,
          available: availableFlag(r.status),
          premium: r.premium,
          status: r.status,
          sellable: !!q,
          registrationPrice: q?.registration ?? null,
        }
      })

    const message =
      primary.status === 'premium'
        ? 'This is a premium domain and cannot be purchased here'
        : primary.status === 'available'
        ? sellable
          ? 'Domain is available'
          : 'Domain is available, but we do not currently sell this extension'
        : 'Domain is not available'

    return ok(
      {
        domain: domainLower,
        available: availableFlag(primary.status),
        premium: primary.premium,
        status: primary.status,
        sellable,
        registrationPrice: quote?.registration ?? null,
        renewalPrice: quote?.renewal ?? null,
        transferPrice: quote?.transfer ?? null,
        currency: 'USD',
        provider: PROVIDER(),
        tld,
        suggestions,
      },
      message
    )
  } catch (error) {
    console.error('Domain search GET error:', error)
    return apiError.serverError('Internal server error')
  }
}

/**
 * POST /api/domains/search
 * Body: { domain: "x.com" } for single, or { domains: ["a.com","b.net"] } for bulk.
 *   - Bulk search capped at 50 domains
 */
async function postHandler(request: Request) {
  try {
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 })
    }
    const { domain, domains } = body as { domain?: unknown; domains?: unknown }

    // ─── Bulk search mode ───────────────────────────────────────────────
    if (Array.isArray(domains) && domains.length > 0) {
      const cleaned = domains
        .filter((d): d is string => typeof d === 'string')
        .map((d) => d.toLowerCase().trim())
        .filter(Boolean)
      if (cleaned.length > 50) {
        return apiError.badRequest('Maximum 50 domains per bulk search')
      }
      const invalid = cleaned.filter((d) => !isSearchableDomain(d))
      if (invalid.length > 0) {
        return apiError.badRequest(`Not a valid domain name: ${invalid.slice(0, 5).join(', ')}`)
      }
      const results = await lookup(cleaned)
      const allPrices = await getAllPrices()
      const priced = results.map((r) => {
        // Selling price from an ACTIVE row only. Never the registrar's
        // (wholesale) price, never an invented fallback.
        const q = sellingQuote(r.status, allPrices.find((p) => p.tld === tldFromDomain(r.domain)))
        return {
          domain: r.domain,
          available: availableFlag(r.status),
          premium: r.premium,
          status: r.status,
          sellable: !!q,
          registrationPrice: q?.registration ?? null,
          renewalPrice: q?.renewal ?? null,
          transferPrice: q?.transfer ?? null,
          currency: 'USD',
        }
      })
      return ok(priced, `Bulk search completed (${priced.length} domains)`)
    }

    if (!domain || typeof domain !== 'string') {
      return apiError.badRequest('Domain name is required')
    }

    const domainLower = domain.toLowerCase().trim()
    if (!isSearchableDomain(domainLower)) {
      return NextResponse.json({ error: INVALID_DOMAIN_MESSAGE }, { status: 400 })
    }
    const lastDot = domainLower.lastIndexOf('.')
    const tld = lastDot >= 0 ? domainLower.substring(lastDot) : ''
    const baseName = lastDot >= 0 ? domainLower.substring(0, lastDot) : domainLower

    const [primary] = await lookup([domainLower])
    if (!primary || primary.status === 'unknown') {
      return NextResponse.json(
        {
          error: 'We could not confirm whether this domain is available. Please try again.',
          status: 'unknown',
          provider: 'apsamo',
        },
        { status: 503 }
      )
    }

    const sellingRow = await getPriceForDomain(domainLower)
    const quote = sellingQuote(primary.status, sellingRow)

    const allSelling = await getAllPrices()
    const POPULAR_TLDS = ['.com', '.net', '.org', '.io', '.co', '.dev', '.app', '.xyz']
    const activeTldSet = new Set(allSelling.map((p) => p.tld))
    const suggestionTlds = POPULAR_TLDS.filter((t) => t !== tld && activeTldSet.has(t)).slice(0, 5)
    const suggestionDomains = suggestionTlds.map((t) => `${baseName}${t}`)

    const sugResults = suggestionDomains.length > 0 ? await lookup(suggestionDomains) : []
    const suggestions = sugResults
      .filter((r) => r.status !== 'unknown')
      .map((r) => {
        const q = sellingQuote(r.status, allSelling.find((p) => p.tld === tldFromDomain(r.domain)))
        return {
          domain: r.domain,
          available: availableFlag(r.status),
          status: r.status,
          price: q?.registration ?? null,
        }
      })

    if (primary.status !== 'available') {
      return NextResponse.json({
        domain: domainLower,
        available: primary.status === 'premium',
        premium: primary.premium,
        status: primary.status,
        sellable: false,
        price: null,
        message:
          primary.status === 'premium'
            ? 'This is a premium domain and cannot be purchased here'
            : 'Domain is not available',
        provider: PROVIDER(),
        suggestions,
      })
    }

    return NextResponse.json({
      domain: domainLower,
      available: true,
      premium: false,
      status: 'available',
      sellable: !!quote,
      price: quote?.registration ?? null,
      message: quote
        ? 'Domain is available'
        : 'Domain is available, but we do not currently sell this extension',
      provider: PROVIDER(),
      suggestions,
    })
  } catch (error) {
    console.error('Domain search error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// SECURITY: rate limit — 20 requests per minute per IP
export const GET = withRateLimit(getHandler, { limit: 20, windowMs: 60_000 })
export const POST = withRateLimit(postHandler, { limit: 20, windowMs: 60_000 })
