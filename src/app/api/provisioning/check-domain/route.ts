/**
 * GET /api/provisioning/check-domain?domain=example.com
 * =====================================================
 *
 * Checks domain availability before a user commits to provisioning. Uses
 * Dynadot's searchDomains() to look up the requested domain; when the
 * requested domain is taken (or to give the user a few more options to
 * choose from), the endpoint also probes up to 5 alternative TLDs for the
 * same SLD and returns whichever ones are available.
 *
 * Auth: required.
 *
 * Response:
 *   {
 *     domain:     string,
 *     available:  boolean,
 *     price?:     number,
 *     alternatives?: Array<{ domain, available, price? }>
 *   }
 */
import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { searchDomains } from '@/lib/dynadot'

const DOMAIN_REGEX =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

// TLDs we'll try as alternatives when the requested domain is unavailable.
// Cheap, popular, and easy to remember.
const ALTERNATIVE_TLDS = ['com', 'net', 'org', 'io', 'app', 'dev', 'co']

export async function GET(request: Request) {
  try {
    // ── Auth ───────────────────────────────────────────────────────
    const token = extractTokenFromHeader(
      request.headers.get('authorization') || ''
    )
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const user = verifyToken(token)
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

    // ── Look up the requested domain ───────────────────────────────
    const primaryResults = await searchDomains([rawDomain])
    const primary = primaryResults[0]
    const available = !!primary?.available
    const price = primary?.price

    // ── Build alternatives list ────────────────────────────────────
    // If the requested domain is available we still return a few
    // alternatives so the user can compare prices. If it's taken we
    // surface up to 5 available alternatives so they have a fallback.
    const parts = rawDomain.split('.')
    const sld = parts[0] || ''
    const requestedTld = parts.slice(1).join('.')
    const altTlds = ALTERNATIVE_TLDS.filter((t) => t !== requestedTld)
    const altDomains = altTlds.map((tld) => `${sld}.${tld}`)

    let alternatives: Array<{ domain: string; available: boolean; price?: number }> = []
    if (altDomains.length > 0) {
      try {
        const altResults = await searchDomains(altDomains)
        alternatives = altResults
          .filter((r) => r.domain !== rawDomain)
          .map((r) => ({
            domain: r.domain,
            available: !!r.available,
            price: r.price,
          }))
        // Sort available-first, then by domain name for stable output
        alternatives.sort((a, b) => {
          if (a.available !== b.available) return a.available ? -1 : 1
          return a.domain.localeCompare(b.domain)
        })
        // If the primary is available, just return the top 3 alternatives
        // (for price comparison). If primary is taken, return up to 5
        // available alternatives.
        if (available) {
          alternatives = alternatives.slice(0, 3)
        } else {
          alternatives = alternatives.filter((a) => a.available).slice(0, 5)
        }
      } catch (err) {
        // Alternative lookup is best-effort; don't fail the whole request.
        console.warn(
          '[api/provisioning/check-domain] alternative lookup failed:',
          err instanceof Error ? err.message : err
        )
      }
    }

    return NextResponse.json({
      domain: rawDomain,
      available,
      ...(price !== undefined ? { price } : {}),
      ...(alternatives.length > 0 ? { alternatives } : {}),
    })
  } catch (error) {
    console.error('[api/provisioning/check-domain] error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: 'Internal server error',
      },
      { status: 500 }
    )
  }
}
