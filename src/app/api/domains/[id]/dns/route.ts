import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { setDnsRecords } from '@/lib/dynadot'
import { logAudit } from '@/lib/audit'

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
      include: { dnsRecords: true },
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

    // ─── Push to Dynadot if this is a Dynadot-managed domain ─────
    // Local DB remains the source of truth - Dynadot is synced best-effort.
    let dynadotSync: { success: boolean; message?: string } | null = null
    if (domain.provider === 'dynadot' && createdRecords.length > 0) {
      try {
        // Build the full set of records (existing + newly created) so Dynadot
        // gets a complete picture. We push at most the first 10 records.
        const allRecords = [...domain.dnsRecords, ...createdRecords]
          .slice(0, 10)
          .map((r) => ({
            type: r.type,
            name: r.name,
            value: r.value,
            ttl: r.ttl,
          }))

        const result = await setDnsRecords(domain.name, allRecords)
        dynadotSync = {
          success: result.success,
          message: result.success
            ? 'Pushed to the registrar'
            : 'Failed to push to the registrar',
        }
      } catch (err) {
        console.error('[dns] Dynadot sync error:', err)
        dynadotSync = {
          success: false,
          message:
            err instanceof Error
              ? err.message
              : 'Unknown registrar sync error',
        }
      }

      await logAudit({
        userId: decoded.userId,
        action: 'domain.dns.dynadot_sync',
        resource: 'domain',
        resourceId: domain.id,
        req: request,
        metadata: {
          addedCount: createdRecords.length,
          success: dynadotSync.success,
          message: dynadotSync.message,
        },
      })
    }

    return NextResponse.json({
      message: `${createdRecords.length} DNS records added`,
      records: createdRecords,
      dynadotSync,
    }, { status: 201 })
  } catch (error) {
    console.error('Update DNS error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
