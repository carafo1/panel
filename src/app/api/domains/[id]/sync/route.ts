import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { getDomainInfo, isDynadotDemoMode } from '@/lib/dynadot'
import { logAudit } from '@/lib/audit'

/**
 * POST /api/domains/[id]/sync
 *
 * Sync a domain's info (status, expiry, nameservers) from Dynadot into our
 * database. Only available to the domain's owner or an admin.
 *
 * Returns: {
 *   synced: boolean,
 *   domain: { ...updated fields },
 *   dynadotInfo: { status, expiry, nameservers },
 *   demo: boolean
 * }
 */
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

    const decoded = verifyToken(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { id } = await params

    // Owner OR admin may sync. Admins can access any domain.
    const isAdmin = decoded.role === 'admin'
    const domain = isAdmin
      ? await db.domain.findUnique({ where: { id } })
      : await db.domain.findFirst({ where: { id, userId: decoded.userId } })

    if (!domain) {
      return NextResponse.json(
        { error: 'Domain not found' },
        { status: 404 }
      )
    }

    if (domain.provider !== 'dynadot') {
      return NextResponse.json(
        {
          error:
            'Sync is only available for domains registered through Apsamo.',
          provider: domain.provider,
        },
        { status: 400 }
      )
    }

    // Fetch the latest info from Dynadot (or demo data if no API key)
    const info = await getDomainInfo(domain.name)

    // Map Dynadot status to our internal status vocabulary
    const mapStatus = (s: string): string => {
      const lower = s.toLowerCase()
      if (lower.includes('active') || lower.includes('ok')) return 'active'
      if (lower.includes('expired')) return 'expired'
      if (lower.includes('transfer')) return 'transferring'
      if (lower.includes('pending')) return 'pending'
      return domain.status // keep existing if unknown
    }

    const newStatus = mapStatus(info.status)
    const newExpiry = info.expiry ? new Date(info.expiry) : domain.expiresAt
    const newNameservers =
      info.nameservers.length > 0
        ? JSON.stringify(info.nameservers)
        : domain.nameservers

    const updated = await db.domain.update({
      where: { id: domain.id },
      data: {
        status: newStatus,
        expiresAt: newExpiry,
        nameservers: newNameservers,
      },
    })

    await logAudit({
      userId: decoded.userId,
      action: 'domain.sync',
      resource: 'domain',
      resourceId: domain.id,
      req: request,
      metadata: {
        provider: 'dynadot',
        externalId: domain.externalId,
        newStatus,
        newExpiry: newExpiry?.toISOString(),
        nameservers: info.nameservers,
        demo: isDynadotDemoMode(),
      },
    })

    return NextResponse.json({
      synced: true,
      demo: isDynadotDemoMode(),
      domain: {
        id: updated.id,
        name: updated.name,
        status: updated.status,
        provider: updated.provider,
        externalId: updated.externalId,
        expiresAt: updated.expiresAt,
        nameservers: updated.nameservers
          ? JSON.parse(updated.nameservers)
          : [],
      },
      dynadotInfo: {
        status: info.status,
        expiry: info.expiry,
        nameservers: info.nameservers,
      },
    })
  } catch (error) {
    console.error('Sync domain error:', error)
    const msg = error instanceof Error ? error.message : 'Internal server error'
    // Surface registrar-specific errors (e.g. "could not find domain in your
    // account") as 400s so the UI can show the real reason instead of a
    // generic 500. Strip any internal registrar name from the message.
    if (msg.includes('Dynadot API error:') || msg.includes('Dynadot IP not authorized')) {
      const cleanMsg = msg
        .replace('Dynadot API error: ', '')
        .replace('Dynadot IP not authorized', 'IP not authorized by registrar')
      return NextResponse.json(
        { error: cleanMsg },
        { status: 400 }
      )
    }
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
