/**
 * GET /api/domains/[id]/propagation
 *
 * Reports how far each DNS record has propagated by querying a spread of public
 * resolvers and comparing what they return against what we have on record.
 *
 * This used to hash the domain name into a plausible-looking percentage. It
 * always showed roughly 75% propagated regardless of reality, which is worse
 * than showing nothing: customers used it to decide whether their DNS was
 * working.
 */
import { NextResponse } from 'next/server'
import { Resolver } from 'dns/promises'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { NS1_HOSTNAME, NS2_HOSTNAME } from '@/lib/brand-config'

interface PropagationChecker {
  location: string
  ip: string
  status: 'propagated' | 'pending' | 'failed'
  checkedAt: string
  latency?: number
  /** What this resolver actually returned, for debugging a mismatch. */
  observed?: string[]
}

interface RecordPropagation {
  id: string
  type: string
  name: string
  value: string
  propagation: {
    overall: number
    checkers: PropagationChecker[]
  }
}

/**
 * Geographically spread anycast resolvers. Anycast means "US East" is where
 * that operator's nearest node is rather than a guaranteed region, but querying
 * several independent operators is what actually catches partial propagation.
 */
const CHECK_LOCATIONS: { location: string; ip: string }[] = [
  { location: 'Cloudflare', ip: '1.1.1.1' },
  { location: 'Google', ip: '8.8.8.8' },
  { location: 'Quad9', ip: '9.9.9.9' },
  { location: 'Cloudflare (secondary)', ip: '1.0.0.1' },
  { location: 'OpenDNS', ip: '208.67.222.222' },
]

/** Record types we can meaningfully verify over DNS. */
const RESOLVABLE = new Set(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'])

const QUERY_TIMEOUT_MS = 4000

/** Build the FQDN a record lives at: "@" is the zone apex. */
function fqdn(recordName: string, domain: string): string {
  const name = recordName.trim()
  if (!name || name === '@') return domain
  if (name.endsWith('.')) return name.slice(0, -1)
  if (name.endsWith(domain)) return name
  return `${name}.${domain}`
}

/** Normalise for comparison — DNS is case-insensitive and trailing dots vary. */
function norm(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '')
}

/**
 * Query one resolver for one record and flatten the answer to comparable
 * strings. Node's resolver returns a different shape per record type.
 */
async function queryResolver(
  resolverIp: string,
  host: string,
  type: string
): Promise<string[]> {
  const resolver = new Resolver({ timeout: QUERY_TIMEOUT_MS, tries: 1 })
  resolver.setServers([resolverIp])

  switch (type) {
    case 'A':
      return await resolver.resolve4(host)
    case 'AAAA':
      return await resolver.resolve6(host)
    case 'CNAME':
      return await resolver.resolveCname(host)
    case 'NS':
      return await resolver.resolveNs(host)
    case 'TXT':
      return (await resolver.resolveTxt(host)).map((chunks) => chunks.join(''))
    case 'MX':
      return (await resolver.resolveMx(host)).map((r) => r.exchange)
    case 'SRV':
      return (await resolver.resolveSrv(host)).map((r) => r.name)
    case 'CAA':
      return (await resolver.resolveCaa(host)).map(
        (r) => (r.issue || r.issuewild || r.iodef || '') as string
      )
    default:
      return []
  }
}

/**
 * Check one record against every resolver, in parallel.
 *
 * - propagated: the resolver returned our value
 * - pending:    the resolver answered, but not with our value yet (or NXDOMAIN,
 *               which is what you see before a new record has spread)
 * - failed:     the resolver could not be reached / timed out
 */
async function checkRecord(
  host: string,
  type: string,
  expected: string
): Promise<{ overall: number; checkers: PropagationChecker[] }> {
  const checkers = await Promise.all(
    CHECK_LOCATIONS.map(async (loc): Promise<PropagationChecker> => {
      const startedAt = Date.now()
      const checkedAt = new Date().toISOString()
      try {
        const answers = await queryResolver(loc.ip, host, type)
        const latency = Date.now() - startedAt
        const wanted = norm(expected)
        const matched = answers.some(
          (a) => norm(a) === wanted || norm(a).includes(wanted)
        )
        return {
          location: loc.location,
          ip: loc.ip,
          status: matched ? 'propagated' : 'pending',
          checkedAt,
          latency,
          observed: answers.slice(0, 5),
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code || ''
        // The record simply isn't visible from here yet — that's propagation
        // in progress, not a broken resolver.
        const notFound = code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN'
        return {
          location: loc.location,
          ip: loc.ip,
          status: notFound ? 'pending' : 'failed',
          checkedAt,
          latency: Date.now() - startedAt,
          observed: [],
        }
      }
    })
  )

  const propagated = checkers.filter((c) => c.status === 'propagated').length
  return {
    overall: Math.round((propagated / checkers.length) * 100),
    checkers,
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { id } = await params

    const domain = await db.domain.findFirst({
      where: { id, userId: decoded.userId },
      include: {
        dnsRecords: {
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    if (!domain) {
      return NextResponse.json({ error: 'Domain not found' }, { status: 404 })
    }

    const nameservers: string[] = domain.nameservers
      ? JSON.parse(domain.nameservers)
      : [NS1_HOSTNAME, NS2_HOSTNAME]

    // Every record against every resolver, all at once — serially this would
    // take records × resolvers × timeout and blow the request budget.
    const records: RecordPropagation[] = await Promise.all(
      domain.dnsRecords.map(async (record) => {
        if (!RESOLVABLE.has(record.type)) {
          return {
            id: record.id,
            type: record.type,
            name: record.name,
            value: record.value,
            propagation: { overall: 0, checkers: [] },
          }
        }
        const propagation = await checkRecord(
          fqdn(record.name, domain.name),
          record.type,
          record.value
        )
        return {
          id: record.id,
          type: record.type,
          name: record.name,
          value: record.value,
          propagation,
        }
      })
    )

    // Average only over records we could actually check, so a CAA record we
    // don't query can't drag the headline number down.
    const checked = records.filter((r) => r.propagation.checkers.length > 0)
    const overallPropagation =
      checked.length > 0
        ? Math.round(
            checked.reduce((sum, r) => sum + r.propagation.overall, 0) / checked.length
          )
        : 0

    return NextResponse.json({
      domain: domain.name,
      nameservers,
      records,
      overallPropagation,
      checkedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Get propagation error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
