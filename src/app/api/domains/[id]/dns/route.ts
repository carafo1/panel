import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'

export async function PUT(
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

    // Verify domain ownership
    const domain = await db.domain.findFirst({
      where: { id, userId: decoded.userId },
    })

    if (!domain) {
      return NextResponse.json(
        { error: 'Domain not found' },
        { status: 404 }
      )
    }

    const body = await request.json()
    const { records } = body // Array of { type, name, value, ttl?, priority?, proxied? }

    if (!records || !Array.isArray(records) || records.length === 0) {
      return NextResponse.json(
        { error: 'DNS records array is required' },
        { status: 400 }
      )
    }

    const validTypes = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV']

    const createdRecords = []
    for (const record of records) {
      if (!record.type || !record.name || !record.value) {
        continue
      }

      if (!validTypes.includes(record.type.toUpperCase())) {
        continue
      }

      const dnsRecord = await db.dnsRecord.create({
        data: {
          domainId: domain.id,
          type: record.type.toUpperCase(),
          name: record.name,
          value: record.value,
          ttl: record.ttl || 3600,
          priority: record.priority || null,
          proxied: record.proxied || false,
        },
      })
      createdRecords.push(dnsRecord)
    }

    return NextResponse.json({
      message: `${createdRecords.length} DNS records added`,
      records: createdRecords,
    }, { status: 201 })
  } catch (error) {
    console.error('Update DNS error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
