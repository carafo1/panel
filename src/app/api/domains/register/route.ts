import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { processEvent } from '@/lib/automation'
import { logAudit } from '@/lib/audit'
import { isAdmin } from '@/lib/security'
import {
  registerDomain as dynadotRegister,
  isDynadotDemoMode,
} from '@/lib/dynadot'
import { getPriceForDomain } from '@/lib/pricing'
import { NS1_HOSTNAME, NS2_HOSTNAME } from '@/lib/brand-config'
import crypto from 'crypto'

/**
 * Generate a random verification code used for DNS TXT-record verification.
 * Format: apsamo-verify-<32 hex chars>
 */
function generateVerificationCode(): string {
  return `apsamo-verify-${crypto.randomBytes(16).toString('hex')}`
}

// SECURITY: validate domain name format (FQDN) — H5
const FQDN_REGEX = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

export async function POST(request: Request) {
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
    const userIsAdmin = isAdmin(decoded.role)

    const body = await request.json()
    const { name, projectId, provider, duration } = body

    if (!name) {
      return NextResponse.json(
        { error: 'Domain name is required' },
        { status: 400 }
      )
    }

    const domainLower = name.toLowerCase().trim()

    // SECURITY: validate FQDN format — H5
    if (!FQDN_REGEX.test(domainLower)) {
      return NextResponse.json(
        { error: 'Invalid domain name format. Must be a valid FQDN (e.g. example.com).' },
        { status: 400 }
      )
    }

    const providerValue = (provider || 'dynadot').toLowerCase() // 'dynadot' | 'custom'
    // SECURITY: cap duration at 10 years — M10 (was unbounded)
    const durationYears = Math.min(Math.max(Number(duration) > 0 ? Number(duration) : 1, 1), 10)

    // Check if domain is already registered in our DB
    const existingDomain = await db.domain.findUnique({
      where: { name: domainLower },
    })
    if (existingDomain) {
      return NextResponse.json(
        { error: 'Domain is already registered' },
        { status: 409 }
      )
    }

    // Find a server for DNS records (pick least loaded)
    const server = await db.server.findFirst({
      where: { status: 'active' },
      orderBy: { usedRamGB: 'asc' },
    })

    // ─── Branch: Custom domain (user claims they own it) ────────
    // These require DNS verification before going active.
    if (providerValue === 'custom') {
      // Create the domain in 'pending_verification' status
      const domain = await db.domain.create({
        data: {
          userId: decoded.userId,
          projectId: projectId || null,
          name: domainLower,
          status: 'pending_verification',
          registrar: 'custom',
          provider: 'custom',
          registeredAt: new Date(),
          autoRenew: false,
          whoisPrivacy: false,
          nameservers: JSON.stringify([]),
        },
      })

      // Create a DomainVerification record with a random TXT code
      const verificationCode = generateVerificationCode()
      await db.domainVerification.create({
        data: {
          domainId: domain.id,
          verificationCode,
          verified: false,
        },
      })

      // Link domain to project if projectId is provided
      if (projectId) {
        await db.project.update({
          where: { id: projectId },
          data: { customDomain: domainLower },
        })
      }

      // Trigger automation for domain_requested event
      const automationResult = await processEvent({
        type: 'domain_requested',
        userId: decoded.userId,
        payload: {
          domainId: domain.id,
          domainName: domainLower,
          projectId: projectId || null,
          provider: 'custom',
        },
      })

      // Audit
      await logAudit({
        userId: decoded.userId,
        action: 'domain.register',
        resource: 'domain',
        resourceId: domain.id,
        req: request,
        metadata: {
          name: domainLower,
          projectId: projectId || null,
          provider: 'custom',
          status: 'pending_verification',
        },
      })

      return NextResponse.json({
        domain: {
          id: domain.id,
          name: domain.name,
          status: domain.status,
          registrar: domain.registrar,
          provider: domain.provider,
          registeredAt: domain.registeredAt,
          expiresAt: domain.expiresAt,
          autoRenew: domain.autoRenew,
          whoisPrivacy: domain.whoisPrivacy,
          nameservers: [],
          projectId: domain.projectId,
          dnsRecords: [],
          verification: {
            code: verificationCode,
            verified: false,
            instructions: `Add a TXT record with name @ and value: ${verificationCode}`,
          },
        },
        automation: automationResult,
        message: 'Domain added. Verify ownership by adding the DNS TXT record.',
      }, { status: 201 })
    }

    // ─── Branch: Register through Dynadot ────────────────────────
    // Default flow - register the domain via Dynadot (or demo mode).
    let dynadotResult: {
      success: boolean
      orderId?: string
      registrationPrice?: number
    } | null = null
    let dynadotError: string | null = null

    try {
      dynadotResult = await dynadotRegister(domainLower, durationYears)
    } catch (err) {
      dynadotError = err instanceof Error ? err.message : String(err)
      console.error('[domains/register] Dynadot registration failed:', dynadotError)
    }

    if (!dynadotResult || !dynadotResult.success) {
      // SECURITY: return generic error — never expose Dynadot brand or raw error
      return NextResponse.json(
        {
          error: 'Domain registration failed. Please try again or contact support.',
          provider: 'apsamo',
        },
        { status: 502 }
      )
    }

    const expiryDate = new Date(
      Date.now() + durationYears * 365 * 24 * 60 * 60 * 1000
    )

    // Create the domain with status 'active' immediately (registered through us)
    const domain = await db.domain.create({
      data: {
        userId: decoded.userId,
        projectId: projectId || null,
        name: domainLower,
        status: 'active',
        registrar: 'dynadot',
        provider: 'dynadot',
        externalId: dynadotResult.orderId || null,
        registeredAt: new Date(),
        expiresAt: expiryDate,
        autoRenew: true,
        whoisPrivacy: true,
        nameservers: JSON.stringify([NS1_HOSTNAME, NS2_HOSTNAME]),
      },
    })

    // Also create a DomainVerification record marked as already verified
    // (we trust Dynadot-registered domains). Useful for the /sync flow later.
    await db.domainVerification.create({
      data: {
        domainId: domain.id,
        verificationCode: generateVerificationCode(),
        verified: true,
        verifiedAt: new Date(),
      },
    })

    // Auto-create default DNS records
    const dnsRecords = []

    // A record pointing to server IP
    if (server) {
      const aRecord = await db.dnsRecord.create({
        data: {
          domainId: domain.id,
          type: 'A',
          name: '@',
          value: server.ip,
          ttl: 3600,
          proxied: true,
        },
      })
      dnsRecords.push(aRecord)
    }

    // CNAME for www
    const cnameRecord = await db.dnsRecord.create({
      data: {
        domainId: domain.id,
        type: 'CNAME',
        name: 'www',
        value: domainLower,
        ttl: 3600,
        proxied: true,
      },
    })
    dnsRecords.push(cnameRecord)

    // Link domain to project if projectId is provided
    if (projectId) {
      await db.project.update({
        where: { id: projectId },
        data: { customDomain: domainLower },
      })
    }

    // Trigger automation for domain_requested event
    const automationResult = await processEvent({
      type: 'domain_requested',
      userId: decoded.userId,
      payload: {
        domainId: domain.id,
        domainName: domainLower,
        projectId: projectId || null,
        provider: 'dynadot',
        orderId: dynadotResult.orderId,
      },
    })

    // Audit domain registration
    await logAudit({
      userId: decoded.userId,
      action: 'domain.register',
      resource: 'domain',
      resourceId: domain.id,
      req: request,
      metadata: {
        name: domainLower,
        projectId: projectId || null,
        registrar: domain.registrar,
        provider: 'dynadot',
        orderId: dynadotResult.orderId,
        price: dynadotResult.registrationPrice,
      },
    })

    return NextResponse.json({
      domain: {
        id: domain.id,
        name: domain.name,
        status: domain.status,
        // SECURITY: hide Dynadot brand + external ID from non-admin customers
        registrar: userIsAdmin ? domain.registrar : 'apsamo',
        provider: userIsAdmin ? domain.provider : 'apsamo',
        ...(userIsAdmin ? { externalId: domain.externalId } : {}),
        registeredAt: domain.registeredAt,
        expiresAt: domain.expiresAt,
        autoRenew: domain.autoRenew,
        whoisPrivacy: domain.whoisPrivacy,
        nameservers: JSON.parse(domain.nameservers || '[]'),
        projectId: domain.projectId,
        dnsRecords,
      },
      automation: automationResult,
      provider: 'apsamo',
      // SECURITY: hide the registrar order ID from non-admin customers
      ...(userIsAdmin ? { orderId: dynadotResult.orderId } : {}),
      // SECURITY: return selling price (not wholesale) to customer
      registrationPrice: (await getPriceForDomain(domainLower))?.registration ?? null,
    }, { status: 201 })
  } catch (error) {
    console.error('Register domain error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
