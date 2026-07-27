import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { isAdmin } from '@/lib/security'
import { domainMode, isRegistrarManaged } from '@/lib/domain-ownership'

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
    const userIsAdmin = isAdmin(decoded.role)

    const { id } = await params

    const domain = await db.domain.findFirst({
      where: { id, userId: decoded.userId },
      include: {
        dnsRecords: {
          orderBy: { createdAt: 'asc' },
        },
        project: {
          select: {
            id: true,
            name: true,
            slug: true,
            subdomain: true,
            status: true,
          },
        },
        verification: true,
      },
    })

    if (!domain) {
      return NextResponse.json(
        { error: 'Domain not found' },
        { status: 404 }
      )
    }

    const managed = isRegistrarManaged(domain)

    // The real connection state, observed by the worker from live DNS. For an
    // external domain this is the only trustworthy status we have — the stored
    // `status` column was written once at creation and never revalidated.
    const conn = await db.websiteDomain.findUnique({
      where: { domain: domain.name },
      select: {
        verified: true,
        sslStatus: true,
        zoneCreated: true,
        connectionMethod: true,
        lastCheckError: true,
        lastCheckedAt: true,
      },
    })

    return NextResponse.json({
      domain: {
        id: domain.id,
        name: domain.name,
        status: managed
          ? domain.status
          : conn?.verified
          ? 'connected'
          : conn
          ? 'pending_dns'
          : 'not_connected',
        connection: conn
          ? {
              verified: conn.verified,
              sslStatus: conn.sslStatus,
              zoneCreated: conn.zoneCreated,
              method: conn.connectionMethod,
              lastError: conn.lastCheckError,
              lastCheckedAt: conn.lastCheckedAt,
            }
          : null,
        // Whether we hold this at the registrar, or it is registered elsewhere
        // and merely pointed here. Gates every registrar-only control.
        mode: domainMode(domain),
        // SECURITY: hide Dynadot brand + external ID from non-admin customers.
        // Only claim to be the registrar for domains we genuinely hold.
        registrar: userIsAdmin ? domain.registrar : managed ? 'apsamo' : 'external',
        provider: userIsAdmin ? domain.provider : managed ? 'apsamo' : 'external',
        ...(userIsAdmin ? { externalId: domain.externalId } : {}),
        registeredAt: domain.registeredAt,
        // Registrar-held facts — null for external domains, where these columns
        // are schema defaults rather than anything we observed.
        expiresAt: managed ? domain.expiresAt : null,
        autoRenew: managed ? domain.autoRenew : null,
        whoisPrivacy: managed ? domain.whoisPrivacy : null,
        locked: managed ? domain.locked : null,
        nameservers: domain.nameservers ? JSON.parse(domain.nameservers) : [],
        project: domain.project,
        dnsRecords: domain.dnsRecords,
        verification: domain.verification
          ? {
              verified: domain.verification.verified,
              verifiedAt: domain.verification.verifiedAt,
              code: domain.verification.verificationCode,
              createdAt: domain.verification.createdAt,
            }
          : null,
        createdAt: domain.createdAt,
        updatedAt: domain.updatedAt,
      },
    })
  } catch (error) {
    console.error('Get domain error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function DELETE(
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

    // Find the domain and verify ownership
    const domain = await db.domain.findFirst({
      where: { id, userId: decoded.userId },
    })

    if (!domain) {
      return NextResponse.json(
        { error: 'Domain not found' },
        { status: 404 }
      )
    }

    const domainName = domain.name
    const domainStatus = domain.status

    // Unlink from any project first (if linked)
    if (domain.projectId) {
      await db.project.updateMany({
        where: { customDomain: domainName },
        data: { customDomain: null },
      })
    }

    // Delete DNS records then the domain itself
    await db.dnsRecord.deleteMany({ where: { domainId: id } })
    await db.domain.delete({ where: { id } })

    // Audit domain deletion
    await logAudit({
      userId: decoded.userId,
      action: 'domain.delete',
      resource: 'domain',
      resourceId: id,
      req: request,
      metadata: {
        name: domainName,
        previousStatus: domainStatus,
        projectId: domain.projectId,
      },
    })

    return NextResponse.json({
      message: 'Domain deleted successfully',
      domain: { id, name: domainName },
    })
  } catch (error) {
    console.error('Delete domain error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
