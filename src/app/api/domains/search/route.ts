import { NextResponse } from 'next/server'
import { searchDomains, isDynadotDemoMode } from '@/lib/dynadot'
import { dynadotService } from '@/lib/dynadot-service'
import { getPriceForDomain, tldFromDomain, getAllPrices } from '@/lib/pricing'
import { ok, apiError } from '@/lib/api-response'

// Domain TLD pricing (used as a fallback when Dynadot returns nothing useful)
const TLD_PRICES: Record<string, number> = {
  '.com': 12.99,
  '.net': 11.99,
  '.org': 10.99,
  '.io': 39.99,
  '.dev': 14.99,
  '.app': 14.99,
  '.co': 29.99,
  '.xyz': 3.99,
  '.tech': 9.99,
  '.ai': 69.99,
}

/**
 * GET /api/domains/search?domain=example.com
 * Instant domain availability search with pricing.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const domain = searchParams.get('domain')
    if (!domain) {
      return apiError.badRequest('Domain query parameter is required')
    }

    const domainLower = domain.toLowerCase().trim()
    const tld = tldFromDomain(domainLower)

    // ─── Dynadot availability lookup (REAL — no simulation fallback) ──
    // In real mode, if Dynadot fails we surface the error honestly rather
    // than faking availability. In demo mode, dynadotService.search returns
    // simulated data without throwing.
    let dynadotAvailable: boolean | null = null
    let dynadotError: string | null = null
    let premium = false
    try {
      const result = await dynadotService.search(domainLower)
      dynadotAvailable = result.available
      premium = result.premium
    } catch (err) {
      dynadotError = err instanceof Error ? err.message : String(err)
      console.error('[domains/search GET] Dynadot lookup failed:', dynadotError)
      // In real mode, surface the error instead of simulating.
      if (!isDynadotDemoMode()) {
        return apiError.serverError(
          `Dynadot search failed: ${dynadotError}. Domain availability could not be determined.`
        )
      }
    }

    // ─── Pricing ────────────────────────────────────────────────────────
    const priceRow = await getPriceForDomain(domainLower)
    const registrationPrice = priceRow?.registration ?? TLD_PRICES[tld] ?? 19.99
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
    const suggestionTlds = allPrices
      .filter((p) => p.tld !== tld)
      .slice(0, 8)
      .map((p) => p.tld)
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
      suggestions = suggestionDomains.map((d) => ({
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
        provider: isDynadotDemoMode() ? 'dynadot-demo' : 'dynadot',
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
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { domain, domains } = body

    // ─── Bulk search mode ───────────────────────────────────────────────
    if (Array.isArray(domains) && domains.length > 0) {
      const cleaned = domains.map((d: string) => d.toLowerCase().trim()).filter(Boolean)
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
    let dynadotPrice: number | null = null
    let dynadotError: string | null = null
    try {
      const results = await searchDomains([domainLower])
      const hit = results.find((r) => r.domain.toLowerCase() === domainLower)
      if (hit) {
        dynadotAvailable = hit.available
        dynadotPrice = typeof hit.price === 'number' ? hit.price : null
      }
    } catch (err) {
      dynadotError = err instanceof Error ? err.message : String(err)
      console.error('[domains/search] Dynadot lookup failed:', dynadotError)
      // In real mode, surface the error instead of simulating.
      if (!isDynadotDemoMode()) {
        return NextResponse.json(
          {
            error: `Dynadot search failed: ${dynadotError}`,
            provider: 'dynadot',
          },
          { status: 502 }
        )
      }
    }

    // Demo-mode fallback only — real mode already returned above on error.
    const simulatedTaken =
      domainLower.includes('taken') || domainLower.includes('unavailable')

    let available: boolean
    let price: number | null

    if (dynadotAvailable !== null) {
      available = dynadotAvailable
      price = dynadotPrice ?? TLD_PRICES[tld] ?? 19.99
    } else {
      // Demo-mode fallback only
      available = !simulatedTaken
      price = available ? TLD_PRICES[tld] ?? 19.99 : null
    }

    const suggestionTlds = Object.keys(TLD_PRICES).filter((t) => t !== tld).slice(0, 5)
    const suggestionDomains = suggestionTlds.map((t) => `${baseName}${t}`)

    let suggestions: { domain: string; available: boolean; price: number }[] = []
    try {
      const sugResults = await searchDomains(suggestionDomains)
      const sugByDomain = new Map(sugResults.map((r) => [r.domain.toLowerCase(), r]))
      suggestions = suggestionDomains.map((d) => {
        const hit = sugByDomain.get(d)
        const sugTld = d.substring(d.lastIndexOf('.'))
        return {
          domain: d,
          available: hit ? hit.available : true,
          price: hit && typeof hit.price === 'number' ? hit.price : TLD_PRICES[sugTld] ?? 19.99,
        }
      })
    } catch {
      suggestions = suggestionDomains.map((d) => {
        const sugTld = d.substring(d.lastIndexOf('.'))
        return { domain: d, available: true, price: TLD_PRICES[sugTld] ?? 19.99 }
      })
    }

    if (!available) {
      return NextResponse.json({
        domain: domainLower,
        available: false,
        price: null,
        message: 'Domain is not available',
        provider: isDynadotDemoMode() ? 'dynadot-demo' : 'dynadot',
        suggestions,
      })
    }

    return NextResponse.json({
      domain: domainLower,
      available: true,
      price,
      message: 'Domain is available',
      provider: isDynadotDemoMode() ? 'dynadot-demo' : 'dynadot',
      dynadotUsed: dynadotAvailable !== null,
      dynadotError,
      suggestions,
    })
  } catch (error) {
    console.error('Domain search error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
