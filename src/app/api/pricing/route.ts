/**
 * GET /api/pricing
 * Returns all domain pricing with wholesale + markup + selling prices.
 * Optional query: ?tld=.com to fetch a single TLD.
 */
import { ok, apiError } from '@/lib/api-response'
import { getAllPrices, getPriceForTld, seedPricing, DEFAULT_MARKUP_USD } from '@/lib/pricing'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const tld = searchParams.get('tld')

    if (tld) {
      const price = await getPriceForTld(tld)
      if (!price) return apiError.notFound(`No pricing found for ${tld}`)
      return ok(price, `Pricing for ${tld}`)
    }

    let prices = await getAllPrices()
    // Auto-seed the pricing table on first access
    if (prices.length === 0) {
      await seedPricing()
      prices = await getAllPrices()
    }

    return ok(
      {
        markup: DEFAULT_MARKUP_USD,
        currency: 'USD',
        formula: 'Selling Price = Wholesale Price + $6.50 USD',
        count: prices.length,
        tlds: prices,
      },
      `Retrieved pricing for ${prices.length} TLDs`
    )
  } catch (error) {
    console.error('[pricing GET] error:', error)
    return apiError.serverError()
  }
}
