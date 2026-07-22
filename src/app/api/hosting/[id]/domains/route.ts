import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { isAdmin } from '@/lib/security'
import { logAudit } from '@/lib/audit'
import {
  isValidHostname,
  isReservedHostname,
  findConflict,
  generateVerificationToken,
  getServerIps,
  VERIFY_PREFIX,
  describeConnection,
} from '@/lib/custom-domains'
import { APSAMO_NAMESERVERS } from '@/lib/dns-zones'
import { BRAND_DOMAIN } from '@/lib/brand-config'

/**
 * Project Domains Endpoint (collection)
 * =====================================
 *
 *   GET  /api/hosting/[id]/domains   — list all domains attached to the project
 *                                       (the primary `project.customDomain` plus all
 *                                       WebsiteDomain rows).
 *   POST /api/hosting/[id]/domains   — attach a new domain.
 *            body: { domain, sslEnabled?, isPrimary? }
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId } = await params
    const project = await db.project.findFirst({ where: isAdmin(decoded.role) ? { id: projectId } : { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const rows = await db.websiteDomain.findMany({
      where: { projectId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    })

    // Build the unified list. The primary is either project.customDomain
    // (legacy primary) OR any WebsiteDomain with isPrimary=true.
    const domains: Array<{
      id: string
      domain: string
      isPrimary: boolean
      sslEnabled: boolean
      sslStatus: string
      verified: boolean
      createdAt: string
      verificationToken?: string | null
      verifiedAt?: string | null
      verificationMethod?: string | null
      lastCheckError?: string | null
      lastCheckedAt?: string | null
      connectionMethod?: string
      zoneCreated?: boolean
      connection?: ReturnType<typeof describeConnection>
    }> = []

    if (project.customDomain) {
      domains.push({
        id: 'primary',
        domain: project.customDomain,
        isPrimary: true,
        sslEnabled: project.sslEnabled,
        sslStatus: project.sslCertStatus,
        verified: true,
        createdAt: project.createdAt.toISOString(),
      })
    }
    for (const r of rows) {
      domains.push({
        id: r.id,
        domain: r.domain,
        isPrimary: r.isPrimary,
        sslEnabled: r.sslEnabled,
        sslStatus: r.sslStatus,
        verified: r.verified,
        createdAt: r.createdAt.toISOString(),
        // Exact records the customer must publish. Returned here so the UI
        // shows real values instead of a "your.server.ip" placeholder.
        verificationToken: r.verified ? null : r.verificationToken,
        verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
        verificationMethod: r.verificationMethod,
        lastCheckError: r.lastCheckError,
        lastCheckedAt: r.lastCheckedAt ? r.lastCheckedAt.toISOString() : null,
        connectionMethod: r.connectionMethod,
        zoneCreated: r.zoneCreated,
        // Derived stage for the connection pipeline in the UI.
        connection: describeConnection(r),
      })
    }

    return NextResponse.json({
      domains,
      // Where an A record should point, and the TXT hostname prefix.
      // Nameservers are the DEFAULT connection method; the A/TXT records are
      // the advanced option for customers who want to keep their DNS host.
      connectTarget: {
        nameservers: APSAMO_NAMESERVERS,
        advanced: { ips: await getServerIps(), txtPrefix: VERIFY_PREFIX },
      },
    })
  } catch (error) {
    console.error('List project domains error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId } = await params
    const project = await db.project.findFirst({ where: isAdmin(decoded.role) ? { id: projectId } : { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body.domain !== 'string' || !body.domain.trim()) {
      return NextResponse.json({ error: 'domain is required' }, { status: 400 })
    }
    const domain = body.domain.toLowerCase().trim()
    const sslEnabled = body.sslEnabled !== false // default true
    const isPrimary = body.isPrimary === true

    if (!isValidHostname(domain)) {
      return NextResponse.json(
        { error: `"${domain}" is not a valid domain name.` },
        { status: 400 }
      )
    }

    // Platform-owned hostnames are never claimable: serving the control
    // panel's own name from a customer container is a phishing risk.
    if (isReservedHostname(domain, BRAND_DOMAIN)) {
      return NextResponse.json(
        {
          error: `${domain} belongs to the platform and cannot be attached. Use your own domain.`,
        },
        { status: 400 }
      )
    }

    if (project.customDomain === domain) {
      return NextResponse.json(
        { error: `${domain} is already the project's primary domain` },
        { status: 409 }
      )
    }

    // SECURITY: platform-wide conflict check, not per-project. The previous
    // check only looked within this project, so a second tenant could claim a
    // domain already serving someone else here and take over its traffic.
    const conflict = await findConflict(domain, projectId)
    if (conflict.conflict) {
      return NextResponse.json(
        {
          error: `${domain} is already in use on this platform. If you own it, remove it from the other website first or contact support.`,
        },
        { status: 409 }
      )
    }

    const ownDup = await db.websiteDomain.findFirst({ where: { projectId, domain } })
    if (ownDup) {
      return NextResponse.json(
        { error: `Domain ${domain} is already attached to this project` },
        { status: 409 }
      )
    }

    // Demote any existing primary if this one is primary.
    if (isPrimary) {
      await db.websiteDomain.updateMany({
        where: { projectId, isPrimary: true },
        data: { isPrimary: false },
      })
    }

    const verificationToken = generateVerificationToken()

    const row = await db.websiteDomain.create({
      data: {
        projectId,
        domain,
        isPrimary,
        sslEnabled,
        sslStatus: 'none',
        verified: false,
        verificationToken,
      },
    })

    // NOTE: `project.customDomain` is deliberately NOT written here, even for
    // a primary. That column is what the Caddy generator emits, so writing it
    // now would serve an unverified hostname. It is set by the verify
    // endpoint once ownership is proven.

    await logAudit({
      userId: decoded.userId,
      action: 'project.domain.add',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { domain, isPrimary, sslEnabled },
    })

    return NextResponse.json(
      {
        domain: {
          id: row.id,
          domain: row.domain,
          isPrimary: row.isPrimary,
          sslEnabled: row.sslEnabled,
          sslStatus: row.sslStatus,
          verified: row.verified,
          createdAt: row.createdAt.toISOString(),
        },
        // Everything the customer needs to complete setup at their registrar.
        // Returned on attach so the UI never has to guess or hardcode it.
        setup: {
          status: 'pending_verification',
          message:
            'Add ONE of these at your domain registrar, then press Verify. The site goes live once ownership is confirmed.',
          txtRecord: {
            type: 'TXT',
            name: `${VERIFY_PREFIX}.${row.domain}`,
            value: verificationToken,
          },
          aRecord: {
            type: 'A',
            name: row.domain,
            value: await getServerIps(),
          },
        },
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('Add project domain error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
