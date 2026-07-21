import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'

// In-memory SSL state per domain (simulated)
const sslState = new Map<string, {
  status: 'active' | 'pending' | 'expired' | 'renewing'
  type: 'auto' | 'custom'
  issuer: string
  issuedAt: Date
  expiresAt: Date
  autoRenew: boolean
  fingerprint: string
  sans: string[]
  keySize: number
  protocol: string
  customIssuer?: string
}>()

function generateFingerprint(domainName: string): string {
  const hash = domainName.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  return Array.from({ length: 32 }, (_, i) =>
    ((hash * (i + 7) + i * 13) % 256).toString(16).padStart(2, '0')
  ).join(':')
}

function getOrCreateSslState(domainId: string, domainName: string) {
  if (sslState.has(domainId)) {
    return sslState.get(domainId)!
  }

  const hash = domainName.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  const now = new Date()

  // 70% active, 15% expired, 15% pending
  const statusRoll = hash % 20
  let status: 'active' | 'pending' | 'expired' | 'renewing'
  if (statusRoll < 14) {
    status = 'active'
  } else if (statusRoll < 17) {
    status = 'expired'
  } else {
    status = 'pending'
  }

  const isAuto = hash % 3 !== 0
  const issuedAt = new Date(now)
  issuedAt.setDate(issuedAt.getDate() - (30 + (hash % 60))) // issued 30-90 days ago

  const expiresAt = new Date(issuedAt)
  if (status === 'expired') {
    expiresAt.setDate(expiresAt.getDate() - (hash % 30)) // expired 0-29 days ago
  } else {
    expiresAt.setDate(expiresAt.getDate() + 90) // Let's Encrypt: 90 days
  }

  const state = {
    status,
    type: isAuto ? 'auto' as const : 'custom' as const,
    issuer: isAuto ? "Let's Encrypt Authority X3" : 'DigiCert Inc.',
    issuedAt,
    expiresAt,
    autoRenew: isAuto,
    fingerprint: generateFingerprint(domainName),
    sans: [domainName, `*.${domainName}`],
    keySize: 2048,
    protocol: 'TLSv1.3',
  }

  sslState.set(domainId, state)
  return state
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
    })

    if (!domain) {
      return NextResponse.json(
        { error: 'Domain not found' },
        { status: 404 }
      )
    }

    const state = getOrCreateSslState(domain.id, domain.name)

    const now = new Date()
    const daysRemaining = Math.max(
      0,
      Math.ceil((state.expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    )

    return NextResponse.json({
      certificate: {
        id: `ssl_${domain.id}`,
        domain: domain.name,
        issuer: state.customIssuer || state.issuer,
        status: state.status,
        type: state.type,
        issuedAt: state.issuedAt.toISOString(),
        expiresAt: state.expiresAt.toISOString(),
        autoRenew: state.autoRenew,
        daysRemaining,
        fingerprint: state.fingerprint,
        sans: state.sans,
        keySize: state.keySize,
        protocol: state.protocol,
      },
    })
  } catch (error) {
    console.error('Get SSL error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function POST(
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
    })

    if (!domain) {
      return NextResponse.json(
        { error: 'Domain not found' },
        { status: 404 }
      )
    }

    const body = await request.json()
    const { action, certificate, privateKey } = body

    if (action === 'renew') {
      // Set status to renewing
      const state = getOrCreateSslState(domain.id, domain.name)
      state.status = 'renewing'
      sslState.set(domain.id, state)

      // Simulate renewal completing after a delay (in a real app this would be a background job)
      // For the API we just return the renewing state immediately
      // The client will poll or we simulate completion
      setTimeout(() => {
        const currentState = sslState.get(domain.id)
        if (currentState) {
          const now = new Date()
          currentState.status = 'active'
          currentState.issuedAt = now
          currentState.expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
          currentState.fingerprint = generateFingerprint(domain.name + Date.now())
          sslState.set(domain.id, currentState)
        }
      }, 2000)

      return NextResponse.json({
        message: 'Certificate renewal initiated',
        certificate: {
          id: `ssl_${domain.id}`,
          domain: domain.name,
          issuer: state.issuer,
          status: 'renewing',
          type: state.type,
          issuedAt: state.issuedAt.toISOString(),
          expiresAt: state.expiresAt.toISOString(),
          autoRenew: state.autoRenew,
          daysRemaining: 0,
          fingerprint: state.fingerprint,
          sans: state.sans,
          keySize: state.keySize,
          protocol: state.protocol,
        },
      })
    }

    if (action === 'upload') {
      if (!certificate || !privateKey) {
        return NextResponse.json(
          { error: 'Certificate and private key are required' },
          { status: 400 }
        )
      }

      const now = new Date()
      const newState = {
        status: 'active' as const,
        type: 'custom' as const,
        issuer: 'Custom Upload',
        customIssuer: 'Custom Upload',
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000), // 1 year for custom
        autoRenew: false,
        fingerprint: generateFingerprint(domain.name + Date.now()),
        sans: [domain.name, `*.${domain.name}`],
        keySize: 2048,
        protocol: 'TLSv1.3',
      }
      sslState.set(domain.id, newState)

      const daysRemaining = Math.ceil(
        (newState.expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      )

      return NextResponse.json({
        message: 'Custom certificate uploaded successfully',
        certificate: {
          id: `ssl_${domain.id}`,
          domain: domain.name,
          issuer: newState.issuer,
          status: 'active',
          type: 'custom',
          issuedAt: newState.issuedAt.toISOString(),
          expiresAt: newState.expiresAt.toISOString(),
          autoRenew: false,
          daysRemaining,
          fingerprint: newState.fingerprint,
          sans: newState.sans,
          keySize: newState.keySize,
          protocol: newState.protocol,
        },
      })
    }

    return NextResponse.json(
      { error: 'Invalid action. Use "renew" or "upload"' },
      { status: 400 }
    )
  } catch (error) {
    console.error('SSL POST error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
