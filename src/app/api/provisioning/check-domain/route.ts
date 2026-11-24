/**
 * GET /api/provisioning/check-domain?domain=example.com
 * =====================================================
 *
 * Checks domain availability before a user commits to provisioning, and
 * probes a few alternative TLDs for the same SLD.
 *
 * Auth: required. Rate-limited (20 req/min per IP): every call costs
 * registrar API quota.
 *
 * Prices are SELLING prices from active price rows only — never the
 * registrar's wholesale price — and are omitted for premium names, for TLDs we
 * do not sell, and for anything whose availability is unknown.
 *
 * Response:
 *   {
 *     domain:     string,
 *     available:  boolean,
 *     status:     'available' | 'unavailable' | 'premium',
 *     price?:     number,
 *     alternatives?: Array<{ domain, available, status, price? }>
 *   }
 * 503 when the registrar could not confirm availability.
 */
import { NextResponse } from 'next/server'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { dynadotService, type DomainSearchResult } from '@/lib/dynadot-service'
import { getAllPrices, tldFromDomain } from '@/lib/pricing'
import { withRateLimit } from '@/lib/rate-limit'

const DOMAIN_REGEX =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

// TLDs we'll try as alternatives when the requested domain is unavailable.
const ALTERNATIVE_TLDS = ['com', 'net', 'org', 'io', 'app', 'dev', 'co']

async function lookup(domains: string[]): Promise<DomainSearchResult[]> {
  try {
    return await dynadotService.bulkSearch(domains)
  } catch (err) {
    console.warn(
      '[api/provisioning/check-domain] registrar lookup failed:',
      err instanceof Error ? err.message : err
    )
    return domains.map((d) => ({ domain: d, available: false, premium: false, status: 'unknown' as const }))
  }
}

async function getHandler(request: Request) {
  try {
    // ── Auth ───────────────────────────────────────────────────────
    const token = extractTokenFromHeader(
      request.headers.get('authorization') || ''
    )
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const user = await verifyTokenFresh(token)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // ── Parse + validate domain ────────────────────────────────────
    const url = new URL(request.url)
    const rawDomain = (url.searchParams.get('domain') || '').trim().toLowerCase()
    if (!rawDomain) {
      return NextResponse.json(
        { error: 'domain query parameter is required' },
        { status: 400 }
      )
    }
    if (!DOMAIN_REGEX.test(rawDomain)) {
      return NextResponse.json(
        { error: 'domain must be a valid domain (e.g. example.com)' },
        { status: 400 }
      )
    }

    const prices = await getAllPrices() // active rows only
    const sellingFor = (d: string, status: DomainSearchResult['status']): number | undefined => {
      if (status !== 'available') return undefined
      const row = prices.find((p) => p.tld === tldFromDomain(d))
      return row && row.registration > 0 ? row.registration : undefined
    }

    // ── Look up the requested domain ───────────────────────────────
    const [primary] = await lookup([rawDomain])
    if (!primary || primary.status === 'unknown') {
      return NextResponse.json(
        { error: 'We could not confirm whether this domain is available. Please try again.', status: 'unknown' },
        { status: 503 }
      )
    }
    const available = primary.status === 'available'
    const price = sellingFor(rawDomain, primary.status)

    // ── Build alternatives list ────────────────────────────────────
    const parts = rawDomain.split('.')
    const sld = parts[0] || ''
    const requestedTld = parts.slice(1).join('.')
    const altTlds = ALTERNATIVE_TLDS.filter((t) => t !== requestedTld)
    const altDomains = altTlds.map((tld) => `${sld}.${tld}`)

    let alternatives: Array<{ domain: string; available: boolean; status: string; price?: number }> = []
    if (altDomains.length > 0) {
      const altResults = await lookup(altDomains)
      alternatives = altResults
        // Unknown and premium alternatives are not offered.
        .filter((r) => r.domain !== rawDomain && (r.status === 'available' || r.status === 'unavailable'))
        .map((r) => {
          const p = sellingFor(r.domain, r.status)
          return {
            domain: r.domain,
            available: r.status === 'available',
            status: r.status,
            ...(p !== undefined ? { price: p } : {}),
          }
        })
      alternatives.sort((a, b) => {
        if (a.available !== b.available) return a.available ? -1 : 1
        return a.domain.localeCompare(b.domain)
      })
      if (available) {
        alternatives = alternatives.slice(0, 3)
      } else {
        alternatives = alternatives.filter((a) => a.available).slice(0, 5)
      }
    }

    return NextResponse.json({
      domain: rawDomain,
      available,
      status: primary.status,
      ...(price !== undefined ? { price } : {}),
      ...(alternatives.length > 0 ? { alternatives } : {}),
    })
  } catch (error) {
    console.error('[api/provisioning/check-domain] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export const GET = withRateLimit(getHandler, { limit: 20, windowMs: 60_000 })
