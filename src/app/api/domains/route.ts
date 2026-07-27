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

    return NextResponse.json({
      domains: domains.map((d) => ({
        id: d.id,
        name: d.name,
        status: d.status,
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
        registrar: userIsAdmin
          ? d.registrar
          : isRegistrarManaged(d)
          ? 'apsamo'
          : 'external',
        provider: userIsAdmin
          ? d.provider
          : isRegistrarManaged(d)
          ? 'apsamo'
          : 'external',
        // SECURITY: hide the external/registrar order ID from non-admins
        ...(userIsAdmin ? { externalId: d.externalId } : {}),
        registeredAt: d.registeredAt,
        expiresAt: d.expiresAt,
        autoRenew: d.autoRenew,
        whoisPrivacy: d.whoisPrivacy,
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
      })),
    })
  } catch (error) {
    console.error('List domains error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
