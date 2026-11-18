import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import {
  setDnsRecords,
  isProtectedDnsDomain,
  DnsWriteRefusedError,
  dnsRefusalStatus,
} from '@/lib/dynadot'
import { isRegistrarManaged } from '@/lib/domain-ownership'
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

    // Validate EVERYTHING before writing anything. The old loop created rows
    // one by one and could return 400 halfway, leaving a partial set behind.
    const toCreate: Array<{
      type: string
      name: string
      value: string
      ttl: number
      priority: number | null
      proxied: boolean
    }> = []
    for (const record of records) {
      if (!record || typeof record !== 'object') continue
      if (!record.type || !record.name || !record.value) {
        continue
      }
      if (typeof record.type !== 'string' || typeof record.name !== 'string') {
        return NextResponse.json({ error: 'Invalid DNS record' }, { status: 400 })
      }

      // SECURITY: validate the record before persisting — H4
      const validationError = validateDnsRecord(record)
      if (validationError) {
        return NextResponse.json(
          { error: validationError },
          { status: 400 }
        )
      }
      toCreate.push({
        type: record.type.toUpperCase(),
        name: record.name,
        value: record.value,
        ttl: Number(record.ttl) || 3600,
        priority: typeof record.priority === 'number' ? record.priority : null,
        proxied: record.proxied === true,
      })
    }

    if (toCreate.length === 0) {
      return NextResponse.json(
        { error: 'No valid DNS records were supplied' },
        { status: 400 }
      )
    }

    // The brand/panel zones are never edited from here.
    if (isProtectedDnsDomain(domain.name)) {
      return NextResponse.json(
        {
          error: 'DNS for this domain is managed by the platform and cannot be changed from the panel.',
          code: 'protected_domain',
        },
        { status: 403 }
      )
    }

    // ─── Registrar-managed domain: publish first, then record ─────
    // The DB rows are created only once the registrar confirmed the write, so
    // the panel never lists records that are not actually live. The write
    // APPENDS to the live zone; it never replaces it.
    let dynadotSync: { success: boolean; message?: string } | null = null
    if (isRegistrarManaged(domain)) {
      let failure: { status: number; error: string; code?: string } | null = null
      try {
        const result = await setDnsRecords(domain.name, toCreate)
        dynadotSync = result.success
          ? {
              success: true,
              message:
                result.written === 0
                  ? 'Already present at the registrar'
                  : 'Pushed to the registrar',
            }
          : { success: false, message: 'The registrar did not confirm the DNS update' }
        if (!result.success) {
          failure = { status: 502, error: 'The registrar did not confirm the DNS update. Nothing was changed.' }
        }
      } catch (err) {
        if (err instanceof DnsWriteRefusedError) {
          failure = { status: dnsRefusalStatus(err.code), error: err.message, code: err.code }
        } else {
          console.error('[dns] registrar sync error:', err)
          // SECURITY: never expose the raw registrar error to the customer
          failure = {
            status: 502,
            error: 'Registrar sync failed. Nothing was changed. Please try again or contact support.',
          }
        }
        dynadotSync = { success: false, message: failure.error }
      }

      await logAudit({
        userId: decoded.userId,
        action: 'domain.dns.dynadot_sync',
        resource: 'domain',
        resourceId: domain.id,
        req: request,
        metadata: {
          addedCount: toCreate.length,
          success: dynadotSync?.success ?? false,
          message: dynadotSync?.message,
        },
      })

      if (failure) {
        return NextResponse.json(
          { error: failure.error, ...(failure.code ? { code: failure.code } : {}), dynadotSync },
          { status: failure.status }
        )
      }
    }

    // The DNS editor re-sends its whole list on every save; only store rows
    // the panel does not already have, so saving twice does not duplicate.
    // (The registrar write above is de-duplicated against the live zone, so
    // re-saving also retries any record a previous sync failed to publish.)
    const existing = await db.dnsRecord.findMany({
      where: { domainId: domain.id },
      select: { type: true, name: true, value: true, priority: true },
    })
    const key = (r: { type: string; name: string; value: string; priority: number | null }) =>
      `${r.type.toUpperCase()}|${r.name.toLowerCase()}|${r.value}|${r.priority ?? ''}`
    const seen = new Set(existing.map(key))
    const fresh = toCreate.filter((r) => {
      const k = key(r)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })

    const createdRecords = fresh.length
      ? await db.$transaction(
          fresh.map((r) =>
            db.dnsRecord.create({
              data: { domainId: domain.id, ...r },
            })
          )
        )
      : []

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
