/**
 * GET /api/pricing
 * Returns domain pricing for the landing page + customer UI.
 *
 * SECURITY:
 *   - Auth required (any logged-in user can see selling prices)
 *   - Wholesale cost + markup formula hidden from non-admin customers
 *     (only admins see the full picture for margin management)
 */
import { ok, apiError } from '@/lib/api-response'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { isAdmin } from '@/lib/security'
import {
  getAllPrices,
  getPriceForTld,
  seedPricing,
  getGlobalMarkup,
} from '@/lib/pricing'

export async function GET(request: Request) {
  try {
    // SECURITY: require authentication — was public, leaked wholesale prices
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

    const { searchParams } = new URL(request.url)
    const tld = searchParams.get('tld')

    if (tld) {
      const price = await getPriceForTld(tld)
      if (!price) return apiError.notFound(`No pricing found for ${tld}`)
      // SECURITY: strip wholesale + markup from non-admin responses
      return ok(userIsAdmin ? price : stripWholesale(price), `Pricing for ${tld}`)
    }

    let prices = await getAllPrices()
    // Auto-seed the pricing table on first access
    if (prices.length === 0) {
      await seedPricing()
      prices = await getAllPrices()
    }

    const markup = await getGlobalMarkup()

    // SECURITY: strip wholesale + markup fields from per-TLD rows for non-admins
    const safePrices = userIsAdmin ? prices : prices.map(stripWholesale)

    return ok(
      {
        // SECURITY: hide markup + formula from non-admin customers
        ...(userIsAdmin ? { markup, formula: `Selling Price = Wholesale Price + $${markup.toFixed(2)} USD` } : {}),
        currency: 'USD',
        count: prices.length,
        tlds: safePrices,
      },
      `Retrieved pricing for ${prices.length} TLDs`
    )
  } catch (error) {
    console.error('[pricing GET] error:', error)
    return apiError.serverError()
  }
}

/** Strip wholesale + markup fields from a single TLD price row. */
function stripWholesale<T extends object>(row: T): Omit<T, 'wholesale' | 'markup'> {
  // Cast for the destructure only — the generic keeps the caller's type.
  const { wholesale: _w, markup: _m, ...rest } = row as T & {
    wholesale?: unknown
    markup?: unknown
  }
  return rest
}
