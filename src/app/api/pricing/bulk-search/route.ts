/**
 * POST /api/pricing/bulk-search
 * Body: { domains: ["a.com", "b.net", ...] } or { base: "mybrand", tlds: [".com",".io"] }
 * Bulk search availability across many domains, returning selling prices.
 */
import { ok, apiError } from '@/lib/api-response'
import { dynadotService } from '@/lib/dynadot-service'
import { getAllPrices, tldFromDomain } from '@/lib/pricing'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { domains, base, tlds } = body

    let queryDomains: string[] = []

    if (Array.isArray(domains) && domains.length > 0) {
      queryDomains = domains.map((d: string) => String(d).toLowerCase().trim()).filter(Boolean)
    } else if (typeof base === 'string' && Array.isArray(tlds)) {
      const b = base.toLowerCase().split('.')[0]
      queryDomains = tlds.map((t: string) => (t.startsWith('.') ? b + t : b + '.' + t))
    } else {
      return apiError.badRequest('Provide either { domains: [] } or { base, tlds: [] }')
    }

    if (queryDomains.length === 0) return apiError.badRequest('No domains to search')
    if (queryDomains.length > 50) return apiError.badRequest('Maximum 50 domains per bulk search')

    const results = await dynadotService.bulkSearch(queryDomains)
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
        wholesale: price?.wholesale ?? null,
        markup: price?.markup ?? 6.5,
        currency: 'USD',
      }
    })

    const available = priced.filter((p) => p.available).length
    return ok(
      {
        total: priced.length,
        available,
        unavailable: priced.length - available,
        results: priced,
      },
      `Bulk search: ${available} of ${priced.length} domains available`
    )
  } catch (error) {
    console.error('[pricing/bulk-search] error:', error)
    return apiError.serverError()
  }
}
