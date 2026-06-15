import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'

export async function GET(request: Request) {
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
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      domains: domains.map((d) => ({
        id: d.id,
        name: d.name,
        status: d.status,
        registrar: d.registrar,
        registeredAt: d.registeredAt,
        expiresAt: d.expiresAt,
        autoRenew: d.autoRenew,
        whoisPrivacy: d.whoisPrivacy,
        nameservers: d.nameservers ? JSON.parse(d.nameservers) : [],
        project: d.project,
        dnsRecords: d.dnsRecords,
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
