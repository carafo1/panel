import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
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

    const decoded = await verifyTokenFresh(token)
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

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const { records } = body // Array of { type, name, value, ttl?, priority?, proxied? }

    if (!records || !Array.isArray(records) || records.length === 0) {
      return NextResponse.json(
        { error: 'DNS records array is required' },
        { status: 400 }
      )
    }

    const validTypes = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV']

    // SECURITY: validate DNS record values per type — H4
    const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/
    const IPV6_REGEX = /^[0-9a-f:]+$/i
    const FQDN_REGEX = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
    const DNS_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,63}[a-z0-9])?$|^\*$|^@$/

    function validateDnsRecord(rec: { type: string; name: string; value: string; ttl?: number; priority?: number }): string | null {
      const type = rec.type.toUpperCase()
      if (!validTypes.includes(type)) return `Invalid record type: ${rec.type}`
      if (!rec.name || !DNS_LABEL_REGEX.test(String(rec.name).toLowerCase())) {
        return `Invalid DNS name: ${rec.name}`
      }
      if (!rec.value || typeof rec.value !== 'string') return 'Record value is required'
      // Reject newlines in TXT values (DNS TXT records are single-line)
      if (rec.value.includes('\n')) return 'TXT record value must not contain newlines'
      // Type-specific validation
      switch (type) {
        case 'A':
          if (!IPV4_REGEX.test(rec.value)) return `A record value must be an IPv4 address (got: ${rec.value})`
          // Reject obviously invalid IPs like 999.999.999.999
          if (rec.value.split('.').some((o) => parseInt(o, 10) > 255)) return `A record IPv4 out of range: ${rec.value}`
          break
        case 'AAAA':
          if (!IPV6_REGEX.test(rec.value)) return `AAAA record value must be an IPv6 address (got: ${rec.value})`
          break
        case 'CNAME':
        case 'NS':
          if (!FQDN_REGEX.test(rec.value.toLowerCase())) return `CNAME/NS value must be an FQDN (got: ${rec.value})`
          break
        case 'MX':
          if (typeof rec.priority !== 'number' || rec.priority < 0 || rec.priority > 65535) {
            return `MX record requires a numeric priority (0-65535)`
          }
          if (!FQDN_REGEX.test(rec.value.toLowerCase())) return `MX value must be an FQDN (got: ${rec.value})`
          break
        case 'SRV':
          if (typeof rec.priority !== 'number') return `SRV record requires a numeric priority`
          break
        case 'TXT':
          if (rec.value.length > 4096) return `TXT record value too long (max 4096 chars)`
          break
      }
      // TTL validation
      const ttl = Number(rec.ttl) || 3600
      if (ttl < 60 || ttl > 86400) return `TTL must be between 60 and 86400 seconds (got: ${ttl})`
      return null
    }

    const createdRecords: Awaited<ReturnType<typeof db.dnsRecord.create>>[] = []
    for (const record of records) {
      if (!record.type || !record.name || !record.value) {
        continue
      }

      // SECURITY: validate the record before persisting — H4
      const validationError = validateDnsRecord(record)
      if (validationError) {
        return NextResponse.json(
          { error: validationError },
          { status: 400 }
        )
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
        console.error('[dns] registrar sync error:', err)
        // SECURITY: never expose the raw registrar error to the customer
        dynadotSync = {
          success: false,
          message: 'Registrar sync failed. Please try again or contact support.',
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
