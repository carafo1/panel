import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { NS1_HOSTNAME, NS2_HOSTNAME } from '@/lib/brand-config'

interface PropagationChecker {
  location: string
  ip: string
  status: 'propagated' | 'pending' | 'failed'
  checkedAt: string
  latency?: number
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

const CHECK_LOCATIONS: { location: string; ip: string }[] = [
  { location: 'US East', ip: '1.1.1.1' },
  { location: 'US West', ip: '8.8.8.8' },
  { location: 'EU West', ip: '9.9.9.9' },
  { location: 'Asia Pacific', ip: '1.0.0.1' },
  { location: 'South America', ip: '208.67.222.222' },
]

function simulatePropagation(
  domainName: string,
  recordType: string,
  recordName: string,
  recordIndex: number
): { overall: number; checkers: PropagationChecker[] } {
  const hash = domainName.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  const now = new Date()

  const checkers: PropagationChecker[] = CHECK_LOCATIONS.map((loc, i) => {
    const seed = (hash * (i + 3 + recordIndex * 7) + recordIndex * 13) % 100
    // ~75% propagated, ~15% pending, ~10% failed
    let status: 'propagated' | 'pending' | 'failed'
    if (seed < 75) {
      status = 'propagated'
    } else if (seed < 90) {
      status = 'pending'
    } else {
      status = 'failed'
    }

    const checkedAt = new Date(now.getTime() - Math.floor(Math.random() * 300000))
    const latency = status === 'propagated' ? Math.floor(10 + (seed % 150)) : undefined

    return {
      location: loc.location,
      ip: loc.ip,
      status,
      checkedAt: checkedAt.toISOString(),
      latency,
    }
  })

  const propagatedCount = checkers.filter((c) => c.status === 'propagated').length
  const overall = Math.round((propagatedCount / checkers.length) * 100)

  return { overall, checkers }
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

    const decoded = verifyToken(token)
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
      return NextResponse.json(
        { error: 'Domain not found' },
        { status: 404 }
      )
    }

    const nameservers: string[] = domain.nameservers
      ? JSON.parse(domain.nameservers)
      : [NS1_HOSTNAME, NS2_HOSTNAME]

    const records: RecordPropagation[] = domain.dnsRecords.map((record, index) => {
      const propagation = simulatePropagation(
        domain.name,
        record.type,
        record.name,
        index
      )
      return {
        id: record.id,
        type: record.type,
        name: record.name,
        value: record.value,
        propagation,
      }
    })

    // Calculate overall propagation across all records
    const overallPropagation =
      records.length > 0
        ? Math.round(
            records.reduce((sum, r) => sum + r.propagation.overall, 0) / records.length
          )
        : 0

    return NextResponse.json({
      domain: domain.name,
      nameservers,
      records,
      overallPropagation,
    })
  } catch (error) {
    console.error('Get propagation error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
