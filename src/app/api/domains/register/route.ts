import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { processEvent } from '@/lib/automation'

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

    const body = await request.json()
    const { name, projectId } = body

    if (!name) {
      return NextResponse.json(
        { error: 'Domain name is required' },
        { status: 400 }
      )
    }

    const domainLower = name.toLowerCase().trim()

    // Check if domain is already registered
    const existingDomain = await db.domain.findUnique({
      where: { name: domainLower },
    })
    if (existingDomain) {
      return NextResponse.json(
        { error: 'Domain is already registered' },
        { status: 409 }
      )
    }

    // Find a server for DNS records
    const server = await db.server.findFirst({
      where: { status: 'active' },
      orderBy: { usedRamGB: 'asc' },
    })

    // Create the domain
    const domain = await db.domain.create({
      data: {
        userId: decoded.userId,
        projectId: projectId || null,
        name: domainLower,
        status: 'active',
        registrar: 'openprovider',
        registeredAt: new Date(),
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year from now
        autoRenew: true,
        whoisPrivacy: true,
        nameservers: JSON.stringify([
          'ns1.deployhub.io',
          'ns2.deployhub.io',
          'ns3.deployhub.io',
        ]),
      },
    })

    // Create default DNS records
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

    // Link domain to project if projectId provided
    if (projectId) {
      await db.project.update({
        where: { id: projectId },
        data: { customDomain: domainLower },
      })
    }

    // Trigger automation
    await processEvent({
      type: 'domain_requested',
      userId: decoded.userId,
      payload: {
        domainId: domain.id,
        domainName: domainLower,
        projectId: projectId || null,
      },
    })

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
        nameservers: JSON.parse(domain.nameservers || '[]'),
        dnsRecords,
      },
    }, { status: 201 })
  } catch (error) {
    console.error('Register domain error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
