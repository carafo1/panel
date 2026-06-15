import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'

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

    const decoded = verifyToken(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

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
      },
    })

    if (!domain) {
      return NextResponse.json(
        { error: 'Domain not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({
      domain: {
        id: domain.id,
        name: domain.name,
        status: domain.status,
        registrar: domain.registrar,
        registeredAt: domain.registeredAt,
        expiresAt: domain.expiresAt,
        autoRenew: domain.autoRenew,
        whoisPrivacy: domain.whoisPrivacy,
        nameservers: domain.nameservers ? JSON.parse(domain.nameservers) : [],
        project: domain.project,
        dnsRecords: domain.dnsRecords,
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
