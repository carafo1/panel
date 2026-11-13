import { NextResponse } from 'next/server'
import { searchDomains, isDynadotDemoMode } from '@/lib/dynadot'
import { dynadotService } from '@/lib/dynadot-service'
import { getPriceForDomain, tldFromDomain, getAllPrices } from '@/lib/pricing'
import { ok, apiError } from '@/lib/api-response'
import { withRateLimit } from '@/lib/rate-limit'

/**
 * GET /api/domains/search?domain=example.com
 * Instant domain availability search with pricing.
 *
 * SECURITY:
 *   - Rate-limited (20 req/min per IP) to prevent Dynadot API abuse
 *   - Dynadot errors are logged server-side only — never returned to client
 */
async function getHandler(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const domain = searchParams.get('domain')
    if (!domain) {
      return apiError.badRequest('Domain query parameter is required')
    }

    const domainLower = domain.toLowerCase().trim()
    const tld = tldFromDomain(domainLower)

    // ─── Dynadot availability lookup ──────────────────────────────────
    // SECURITY: never leak Dynadot errors to the client. Log server-side.
    let dynadotAvailable: boolean | null = null
    let premium = false
    try {
      const result = await dynadotService.search(domainLower)
      dynadotAvailable = result.available
      premium = result.premium
    } catch (err) {
      console.error('[domains/search GET] registrar lookup failed:', err)
      // SECURITY: return generic error — don't expose Dynadot brand or error details
      if (!isDynadotDemoMode()) {
        return apiError.serverError(
          'Domain search is temporarily unavailable. Please try again.'
        )
      }
    }

    // ─── Pricing ────────────────────────────────────────────────────────
    // getPriceForDomain now always resolves (catalog + live markup fallback),
    // so search quotes exactly what checkout will charge.
    const priceRow = await getPriceForDomain(domainLower)
    const registrationPrice = priceRow?.registration ?? 0
    const renewalPrice = priceRow?.renewal ?? registrationPrice
    const transferPrice = priceRow?.transfer ?? registrationPrice

    // ─── Determine availability ─────────────────────────────────────────
    // Demo mode: fall back to a simple "taken"/"unavailable" keyword check
    // if Dynadot didn't return a result. Real mode: dynadotAvailable is
    // always set (or we already returned an error above).
    const simulatedTaken =
      domainLower.includes('taken') || domainLower.includes('unavailable')
    let available: boolean
    if (dynadotAvailable !== null) {
      available = dynadotAvailable
    } else {
      // Demo-mode fallback only
      available = !simulatedTaken
    }

    // ─── Suggestions across other TLDs ──────────────────────────────────
    const allPrices = await getAllPrices()
    // Suggest popular TLDs first — plain alphabetical order surfaces
    // .ac/.academy/.accountant, which nobody is shopping for.
    const POPULAR_TLDS = ['.com', '.net', '.org', '.io', '.co', '.dev', '.app', '.xyz', '.ai', '.store']
    const activeTldSet = new Set(allPrices.map((p) => p.tld))
    const popularFirst = POPULAR_TLDS.filter((t) => t !== tld && activeTldSet.has(t))
    const remaining = allPrices.map((p) => p.tld).filter((t) => t !== tld && !popularFirst.includes(t))
    const suggestionTlds = [...popularFirst, ...remaining].slice(0, 8)
    const baseName = domainLower.substring(0, domainLower.lastIndexOf('.'))
    const suggestionDomains = suggestionTlds.map((t) => `${baseName}${t}`)

    let suggestions: Array<{
      domain: string
      available: boolean
      premium: boolean
      registrationPrice: number
    }> = []
    try {
      const sugResults = await dynadotService.bulkSearch(suggestionDomains)
      suggestions = sugResults.map((r) => {
        const sugPrice = allPrices.find((p) => p.tld === tldFromDomain(r.domain))
        return {
          domain: r.domain,
          available: r.available,
          premium: r.premium,
          registrationPrice: sugPrice?.registration ?? registrationPrice,
        }
      })
    } catch {
      // Never claim availability we could not check: outside demo mode a
      // failed lookup means no suggestions, not "everything is free".
      suggestions = !isDynadotDemoMode() ? [] : suggestionDomains.map((d) => ({
        domain: d,
        available: true,
        premium: false,
        registrationPrice:
          allPrices.find((p) => p.tld === tldFromDomain(d))?.registration ?? registrationPrice,
      }))
    }

    return ok(
      {
        domain: domainLower,
        available,
        premium,
        registrationPrice: available ? registrationPrice : null,
        renewalPrice: available ? renewalPrice : null,
        transferPrice: available ? transferPrice : null,
        currency: 'USD',
        provider: isDynadotDemoMode() ? 'apsamo-demo' : 'apsamo',
        tld,
        suggestions,
      },
      available ? 'Domain is available' : 'Domain is not available'
    )
  } catch (error) {
    console.error('Domain search GET error:', error)
    return apiError.serverError('Internal server error')
  }
}

/**
 * POST /api/domains/search
 * Body: { domain: "x.com" } for single, or { domains: ["a.com","b.net"] } for bulk.
 *
 * SECURITY:
 *   - Rate-limited (20 req/min per IP)
 *   - Bulk search capped at 50 domains
 *   - Dynadot errors logged server-side only — never returned to client
 */
async function postHandler(request: Request) {
  try {
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const { domain, domains } = body

    // ─── Bulk search mode ───────────────────────────────────────────────
    if (Array.isArray(domains) && domains.length > 0) {
      const cleaned = domains.map((d: string) => d.toLowerCase().trim()).filter(Boolean)
      // SECURITY: cap bulk search at 50 domains (M9)
      if (cleaned.length > 50) {
        return apiError.badRequest('Maximum 50 domains per bulk search')
      }
      const results = await dynadotService.bulkSearch(cleaned)
      const allPrices = await getAllPrices()
      const priced = results.map((r) => {
        const price = allPrices.find((p) => p.tld === tldFromDomain(r.domain))
        return {
          domain: r.domain,
          available: r.available,
          premium: r.premium,
          registrationPrice: r.available
            ? price?.registration ?? r.registrationPrice ?? 19.99
            : null,
          renewalPrice: r.available ? price?.renewal ?? 19.99 : null,
          transferPrice: r.available ? price?.transfer ?? 19.99 : null,
          currency: 'USD',
        }
      })
      return ok(priced, `Bulk search completed (${priced.length} domains)`)
    }

    if (!domain) {
      return apiError.badRequest('Domain name is required')
    }

    const domainLower = domain.toLowerCase().trim()
    const lastDot = domainLower.lastIndexOf('.')
    const tld = lastDot >= 0 ? domainLower.substring(lastDot) : ''
    const baseName = lastDot >= 0 ? domainLower.substring(0, lastDot) : domainLower

    let dynadotAvailable: boolean | null = null
    try {
      const results = await searchDomains([domainLower])
      const hit = results.find((r) => r.domain.toLowerCase() === domainLower)
      if (hit) {
        dynadotAvailable = hit.available
      }
    } catch (err) {
      // SECURITY: log server-side, return generic error to client
      console.error('[domains/search POST] registrar lookup failed:', err)
      if (!isDynadotDemoMode()) {
        return NextResponse.json(
          {
            error: 'Domain search is temporarily unavailable. Please try again.',
            provider: 'apsamo',
          },
          { status: 502 }
        )
      }
    }

    // The registrar answered but said nothing about this domain. Guessing
    // "available" from the name sent customers to checkout for domains that
    // could not be registered. Outside demo mode, say we could not confirm.
    if (dynadotAvailable === null && !isDynadotDemoMode()) {
      return NextResponse.json(
        {
          error: 'We could not confirm whether this domain is available. Please try again.',
          provider: 'apsamo',
        },
        { status: 502 }
      )
    }

    // Demo-mode fallback only — real mode already returned above on error.
    const simulatedTaken =
      domainLower.includes('taken') || domainLower.includes('unavailable')

    let available: boolean
    if (dynadotAvailable !== null) {
      available = dynadotAvailable
    } else {
      // Demo-mode fallback only
      available = !simulatedTaken
    }

    // PRICING: always quote from the DomainPrice table (wholesale + markup).
    // The registrar search result carries the WHOLESALE price — quoting that
    // to the customer would forfeit the entire markup.
    // getPriceForDomain always resolves now (catalog + live markup fallback),
    // so the quote here always matches what checkout charges.
    const sellingRow = await getPriceForDomain(domainLower)
    const price: number | null = available
      ? sellingRow?.registration ?? 0
      : null

    const allSelling = await getAllPrices()
    const sellingFor = (d: string): number => {
      const sugTld = d.substring(d.lastIndexOf('.'))
      return allSelling.find((p) => p.tld === sugTld)?.registration ?? 0
    }

    const POPULAR_TLDS = ['.com', '.net', '.org', '.io', '.co', '.dev', '.app', '.xyz']
    const activeTldSet = new Set(allSelling.map((p) => p.tld))
    const suggestionTlds = POPULAR_TLDS.filter(
      (t) => t !== tld && activeTldSet.has(t)
    ).slice(0, 5)
    const suggestionDomains = suggestionTlds.map((t) => `${baseName}${t}`)

    let suggestions: { domain: string; available: boolean; price: number }[] = []
    try {
      const sugResults = await searchDomains(suggestionDomains)
      const sugByDomain = new Map(sugResults.map((r) => [r.domain.toLowerCase(), r]))
      // A suggestion the registrar did not report on is left out rather
      // than shown as available (`?? true` did that).
      suggestions = suggestionDomains
        .filter((d) => sugByDomain.has(d) || isDynadotDemoMode())
        .map((d) => ({
          domain: d,
          available: sugByDomain.get(d)?.available ?? true,
          price: sellingFor(d),
        }))
    } catch {
      suggestions = !isDynadotDemoMode() ? [] : suggestionDomains.map((d) => ({
        domain: d,
        available: true,
        price: sellingFor(d),
      }))
    }

    if (!available) {
      return NextResponse.json({
        domain: domainLower,
        available: false,
        price: null,
        message: 'Domain is not available',
        provider: isDynadotDemoMode() ? 'apsamo-demo' : 'apsamo',
        suggestions,
      })
    }

    // SECURITY: removed `dynadotUsed` + `dynadotError` fields — leaked registrar brand
    return NextResponse.json({
      domain: domainLower,
      available: true,
      price,
      message: 'Domain is available',
      provider: isDynadotDemoMode() ? 'apsamo-demo' : 'apsamo',
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
