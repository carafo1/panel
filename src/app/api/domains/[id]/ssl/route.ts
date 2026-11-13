/**
 * GET/POST /api/domains/[id]/ssl
 *
 * Reports the certificate actually being served on the domain, by opening a
 * TLS connection to it and reading the peer certificate.
 *
 * This previously kept a fabricated certificate in a module-level Map: issuer,
 * expiry, fingerprint and status were derived from a hash of the domain name,
 * "renewal" was a two-second setTimeout, and everything vanished on restart.
 * Customers were making trust decisions from invented data.
 *
 * Certificates themselves are issued and renewed automatically by the edge
 * proxy's ACME client — there is nothing to provision here, only to observe.
 */
import { NextResponse } from 'next/server'
import tls from 'tls'
import { lookup } from 'dns/promises'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { isBlockedAddress } from '@/lib/ssrf'
import { forceRenew } from '@/lib/vps/ssl'

const TLS_TIMEOUT_MS = 6000

interface LiveCertificate {
  domain: string
  reachable: boolean
  status: 'active' | 'expiring' | 'expired' | 'unreachable' | 'invalid'
  issuer: string | null
  subject: string | null
  issuedAt: string | null
  expiresAt: string | null
  daysRemaining: number | null
  fingerprint: string | null
  sans: string[]
  protocol: string | null
  keySize: number | null
  authorized: boolean
  authorizationError: string | null
  /** Managed by the platform's ACME client rather than uploaded by hand. */
  autoRenew: boolean
  message?: string
}

function unreachable(domain: string, message: string): LiveCertificate {
  return {
    domain,
    reachable: false,
    status: 'unreachable',
    issuer: null,
    subject: null,
    issuedAt: null,
    expiresAt: null,
    daysRemaining: null,
    fingerprint: null,
    sans: [],
    protocol: null,
    keySize: null,
    authorized: false,
    authorizationError: null,
    autoRenew: true,
    message,
  }
}

/**
 * A certificate name field (O, CN, …) is an array when the certificate carries
 * that attribute more than once. Join them so the value is reported in full.
 */
function certName(value: string | string[] | undefined): string | null {
  const text = Array.isArray(value) ? value.filter(Boolean).join(', ') : value
  return text || null
}

/**
 * Open a TLS connection and read the served certificate.
 *
 * `rejectUnauthorized: false` so we can still REPORT an expired or mismatched
 * certificate instead of throwing — the validation result is surfaced through
 * `authorized`/`authorizationError` rather than being swallowed.
 */
async function probeCertificate(domain: string): Promise<LiveCertificate> {
  // Don't let a domain record point our prober at internal infrastructure.
  try {
    const { address } = await lookup(domain)
    if (isBlockedAddress(address)) {
      return unreachable(domain, 'Domain resolves to a non-public address.')
    }
  } catch {
    return unreachable(
      domain,
      'Domain does not resolve yet. DNS may still be propagating.'
    )
  }

  return new Promise<LiveCertificate>((resolve) => {
    let settled = false
    const done = (result: LiveCertificate) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    const socket = tls.connect(
      {
        host: domain,
        port: 443,
        servername: domain,
        rejectUnauthorized: false,
        timeout: TLS_TIMEOUT_MS,
      },
      () => {
        const cert = socket.getPeerCertificate(false)
        if (!cert || Object.keys(cert).length === 0) {
          return done(unreachable(domain, 'No certificate was presented.'))
        }

        const validFrom = cert.valid_from ? new Date(cert.valid_from) : null
        const validTo = cert.valid_to ? new Date(cert.valid_to) : null
        const now = Date.now()
        const daysRemaining = validTo
          ? Math.ceil((validTo.getTime() - now) / 86_400_000)
          : null

        const authorized = socket.authorized
        const authorizationError = socket.authorizationError
          ? String(socket.authorizationError)
          : null

        let status: LiveCertificate['status'] = 'active'
        if (validTo && validTo.getTime() <= now) status = 'expired'
        else if (!authorized) status = 'invalid'
        else if (daysRemaining !== null && daysRemaining <= 21) status = 'expiring'

        const sans = (cert.subjectaltname || '')
          .split(',')
          .map((s) => s.trim().replace(/^DNS:/, ''))
          .filter(Boolean)

        done({
          domain,
          reachable: true,
          status,
          issuer: certName(cert.issuer?.O) || certName(cert.issuer?.CN),
          subject: certName(cert.subject?.CN),
          issuedAt: validFrom ? validFrom.toISOString() : null,
          expiresAt: validTo ? validTo.toISOString() : null,
          daysRemaining,
          fingerprint: cert.fingerprint256 || cert.fingerprint || null,
          sans,
          protocol: socket.getProtocol(),
          keySize: typeof cert.bits === 'number' ? cert.bits : null,
          authorized,
          authorizationError,
          autoRenew: true,
        })
      }
    )

    socket.on('timeout', () =>
      done(unreachable(domain, 'Timed out connecting on port 443.'))
    )
    socket.on('error', (err: NodeJS.ErrnoException) => {
      const message =
        err.code === 'ECONNREFUSED'
          ? 'Nothing is listening on port 443 yet.'
          : err.code === 'ENOTFOUND'
          ? 'Domain does not resolve yet.'
          : `Could not establish a TLS connection (${err.code || 'error'}).`
      done(unreachable(domain, message))
    })
  })
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = extractTokenFromHeader(request.headers.get('Authorization'))
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
      return NextResponse.json({ error: 'Domain not found' }, { status: 404 })
    }

    const certificate = await probeCertificate(domain.name)

    return NextResponse.json({
      certificate: { id: `ssl_${domain.id}`, ...certificate },
      checkedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Get SSL error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = extractTokenFromHeader(request.headers.get('Authorization'))
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
      return NextResponse.json({ error: 'Domain not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const { action } = body

    if (action === 'renew') {
      // Certificates renew themselves via the edge proxy's ACME client. A
      // manual renew is only meaningful for a domain attached to a site we
      // host — that path reloads the proxy and forces re-issuance.
      if (!domain.projectId) {
        const certificate = await probeCertificate(domain.name)
        return NextResponse.json({
          message:
            'This domain is not attached to a site hosted here, so there is no certificate for us to renew. Certificates are issued automatically once the domain points at your site.',
          renewed: false,
          certificate: { id: `ssl_${domain.id}`, ...certificate },
        })
      }

      const result = await forceRenew(domain.projectId)
      const certificate = await probeCertificate(domain.name)
      return NextResponse.json({
        message: result.message,
        renewed: result.ok,
        certificate: { id: `ssl_${domain.id}`, ...certificate },
      })
    }

    if (action === 'upload') {
      // Uploading a custom certificate would mean writing key material to the
      // edge proxy and pinning it out of the ACME rotation. That isn't wired
      // up, and storing a private key in memory (as this endpoint used to)
      // achieves nothing while implying it worked.
      return NextResponse.json(
        {
          error:
            'Custom certificates are not supported on this platform. Certificates are issued and renewed automatically at no cost. Contact support if you have a specific requirement.',
          code: 'not_supported',
        },
        { status: 501 }
      )
    }

    return NextResponse.json(
      { error: 'Invalid action. Use "renew".' },
      { status: 400 }
    )
  } catch (error) {
    console.error('SSL POST error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
