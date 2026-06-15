import { NextResponse } from 'next/server'

// Domain TLD pricing
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

    // Check if domain contains "taken" or "unavailable"
    const isTaken =
      domainLower.includes('taken') ||
      domainLower.includes('unavailable')

    // Extract TLD
    const tld = domainLower.substring(domainLower.lastIndexOf('.'))
    const price = TLD_PRICES[tld] || 19.99

    if (isTaken) {
      return NextResponse.json({
        domain: domainLower,
        available: false,
        price: null,
        message: 'Domain is not available',
      })
    }

    // Generate alternative suggestions
    const baseName = domainLower.substring(0, domainLower.lastIndexOf('.'))
    const suggestions = Object.keys(TLD_PRICES)
      .filter((t) => t !== tld)
      .slice(0, 5)
      .map((t) => ({
        domain: `${baseName}${t}`,
        available: true,
        price: TLD_PRICES[t],
      }))

    return NextResponse.json({
      domain: domainLower,
      available: true,
      price,
      message: 'Domain is available',
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
