import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { isAdmin } from '@/lib/security'
import { domainMode, isRegistrarManaged } from '@/lib/domain-ownership'

export async function GET(request: Request) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }
    const userIsAdmin = isAdmin(decoded.role)

    const domains = await db.domain.findMany({
      where: { userId: decoded.userId },
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
          },
        },
        verification: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    // For an external domain, `Domain.status` is not evidence of anything — it
    // is whatever was written when the row was created, and nothing ever
    // revalidates it. The real connection state lives in WebsiteDomain, which
    // the worker updates every couple of minutes from actual DNS. Join it so we
    // can report what is true rather than what was once typed.
    const connections = await db.websiteDomain.findMany({
      where: { domain: { in: domains.map((d) => d.name) } },
      select: {
        domain: true,
        verified: true,
        sslStatus: true,
        zoneCreated: true,
        connectionMethod: true,
        lastCheckError: true,
        lastCheckedAt: true,
      },
    })
    const connectionByDomain = new Map(connections.map((c) => [c.domain, c]))

    return NextResponse.json({
      domains: domains.map((d) => {
        const managed = isRegistrarManaged(d)
        const conn = connectionByDomain.get(d.name)
        return {
        id: d.id,
        name: d.name,
        // Managed domains carry a real registrar lifecycle. External ones do
        // not, so report their connection state instead of a stored string
        // that claims "active" for a domain still pointing somewhere else.
        status: managed
          ? d.status
          : conn?.verified
          ? 'connected'
          : conn
          ? 'pending_dns'
          : 'not_connected',
        // What the worker last observed, so the UI can explain the state
        // instead of asserting one.
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
        // Whether we actually hold this domain at the registrar, or the
        // customer registered it elsewhere and merely pointed it here. The UI
        // keys every registrar-only control off this.
        mode: domainMode(d),
        // SECURITY: hide the Dynadot brand from non-admin customers — show
        // "apsamo" as the registrar/provider instead. Admins see the real
        // values for debugging + support.
        //
        // Only claim to be the registrar for domains we genuinely hold.
        // Labelling an external domain "apsamo" is what made the panel look
        // like it owned domains registered at other providers.
        registrar: userIsAdmin ? d.registrar : managed ? 'apsamo' : 'external',
        provider: userIsAdmin ? d.provider : managed ? 'apsamo' : 'external',
        // SECURITY: hide the external/registrar order ID from non-admins
        ...(userIsAdmin ? { externalId: d.externalId } : {}),
        registeredAt: d.registeredAt,
        // Registrar-only facts. For an external domain these columns hold
        // schema defaults nobody ever validated — `autoRenew` and
        // `whoisPrivacy` default to true, so the UI cheerfully reported
        // "Privacy: On" for a domain at a registrar we cannot even query.
        // Send null so the UI shows nothing rather than a confident lie.
        expiresAt: managed ? d.expiresAt : null,
        autoRenew: managed ? d.autoRenew : null,
        whoisPrivacy: managed ? d.whoisPrivacy : null,
        // `locked` and `premium` were never sent at all, so `d.locked` was
        // undefined in the client and rendered as a definite "Unlocked".
        locked: managed ? d.locked : null,
        premium: d.premium,
        nameservers: d.nameservers ? JSON.parse(d.nameservers) : [],
        project: d.project,
        dnsRecords: d.dnsRecords,
        verification: d.verification
          ? {
              verified: d.verification.verified,
              verifiedAt: d.verification.verifiedAt,
              code: d.verification.verificationCode,
            }
          : null,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        }
      }),
    })
  } catch (error) {
    console.error('List domains error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
