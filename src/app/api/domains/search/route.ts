import { NextResponse } from 'next/server'
import { searchDomains, isDynadotDemoMode } from '@/lib/dynadot'

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

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { domain } = body

    if (!domain) {
      return NextResponse.json(
        { error: 'Domain name is required' },
        { status: 400 }
      )
    }

    const domainLower = domain.toLowerCase().trim()

    // Extract TLD (with the leading dot, e.g. ".com")
    const lastDot = domainLower.lastIndexOf('.')
    const tld = lastDot >= 0 ? domainLower.substring(lastDot) : ''
    const baseName = lastDot >= 0 ? domainLower.substring(0, lastDot) : domainLower

    // ─── Try Dynadot first ───────────────────────────────────────
    let dynadotAvailable: boolean | null = null
    let dynadotPrice: number | null = null
    let dynadotError: string | null = null
    try {
      const results = await searchDomains([domainLower])
      const hit = results.find(
        (r) => r.domain.toLowerCase() === domainLower
      )
      if (hit) {
        dynadotAvailable = hit.available
        dynadotPrice = typeof hit.price === 'number' ? hit.price : null
      }
    } catch (err) {
      // Graceful fallback - record error but continue
      dynadotError = err instanceof Error ? err.message : String(err)
      console.error('[domains/search] Dynadot lookup failed, falling back to simulated search:', dynadotError)
    }

    // ─── Fallback simulation (used when Dynadot gave us nothing) ──
    // Check if domain contains "taken" or "unavailable"
    const simulatedTaken =
      domainLower.includes('taken') || domainLower.includes('unavailable')

    let available: boolean
    let price: number | null

    if (dynadotAvailable !== null) {
      // Dynadot returned a definitive answer - use it
      available = dynadotAvailable
      price = dynadotPrice ?? TLD_PRICES[tld] ?? 19.99
    } else {
      // No Dynadot result - use simulated availability
      available = !simulatedTaken
      price = available ? TLD_PRICES[tld] ?? 19.99 : null
    }

    // Generate alternative suggestions
    // Try a few TLDs via Dynadot in parallel for accurate pricing/availability
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
      // Fall back to simulated suggestions
      suggestions = suggestionDomains.map((d) => {
        const sugTld = d.substring(d.lastIndexOf('.'))
        return {
          domain: d,
          available: true,
          price: TLD_PRICES[sugTld] ?? 19.99,
        }
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
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
