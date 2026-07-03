import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { isAdmin } from '@/lib/security'

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
        // SECURITY: hide the Dynadot brand from non-admin customers —
        // show "apsamo" as the registrar/provider instead. Admins see
        // the real registrar/provider for debugging + support.
        registrar: userIsAdmin ? d.registrar : 'apsamo',
        provider: userIsAdmin ? d.provider : 'apsamo',
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
