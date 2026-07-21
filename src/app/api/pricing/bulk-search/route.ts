/**
 * POST /api/pricing/bulk-search
 * Body: { domains: ["a.com", "b.net", ...] } or { base: "mybrand", tlds: [".com",".io"] }
 *
 * SECURITY:
 *   - Auth required (was public — anyone could hammer the Dynadot API)
 *   - Rate-limited via withRateLimit (max 10 requests per minute per IP)
 *   - Wholesale cost + markup hidden from non-admin customers
 */
import { ok, apiError } from '@/lib/api-response'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { isAdmin } from '@/lib/security'
import { withRateLimit } from '@/lib/rate-limit'
import { dynadotService } from '@/lib/dynadot-service'
import { getAllPrices, tldFromDomain, getGlobalMarkup } from '@/lib/pricing'

async function handler(request: Request) {
  try {
    // SECURITY: require auth — was public
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) {
      return apiError.unauthorized('Authentication required')
    }
    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return apiError.unauthorized('Invalid or expired token')
    }
    const userIsAdmin = isAdmin(decoded.role)

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
    // SECURITY: reduce cap from 50 to 20 to limit Dynadot API load
    if (queryDomains.length > 20) return apiError.badRequest('Maximum 20 domains per bulk search')

    const results = await dynadotService.bulkSearch(queryDomains)
    const allPrices = await getAllPrices()
    const globalMarkup = await getGlobalMarkup()

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
        // SECURITY: hide wholesale + markup from non-admin customers
        ...(userIsAdmin
          ? {
              wholesale: price?.wholesale ?? null,
              markup: price?.markup ?? globalMarkup,
            }
          : {}),
        currency: 'USD',
      }
    })

    const available = priced.filter((p) => p.available).length
    return ok(
      {
        total: priced.length,
        available,
        unavailable: priced.length - available,
        // SECURITY: hide markup from non-admin customers
        ...(userIsAdmin ? { markup: globalMarkup } : {}),
        results: priced,
      },
      `Bulk search: ${available} of ${priced.length} domains available`
    )
  } catch (error) {
    console.error('[pricing/bulk-search] error:', error)
    return apiError.serverError()
  }
}

// SECURITY: rate limit — 10 requests per minute per IP
export const POST = withRateLimit(handler, { limit: 10, windowMs: 60_000 })
