import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import {
  deleteDnsRecord,
  isProtectedDnsDomain,
  DnsWriteRefusedError,
  dnsRefusalStatus,
} from '@/lib/dynadot'
import { isRegistrarManaged } from '@/lib/domain-ownership'
import { logAudit } from '@/lib/audit'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; recordId: string }> }
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

    const { id, recordId } = await params

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

    // Find the DNS record
    const dnsRecord = await db.dnsRecord.findFirst({
      where: { id: recordId, domainId: domain.id },
    })

    if (!dnsRecord) {
      return NextResponse.json(
        { error: 'DNS record not found' },
        { status: 404 }
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

    // ─── Registrar-managed domain: remove at the registrar first ─────
    // deleteDnsRecord reads the LIVE zone, drops only this record and writes
    // back every other record (including ones the panel never created). The
    // DB row is removed only once the registrar confirmed that write, or when
    // the record was not in the live zone at all.
    let dynadotSync: { success: boolean; message?: string } | null = null
    if (isRegistrarManaged(domain)) {
      let failure: { status: number; error: string; code?: string } | null = null
      try {
        const result = await deleteDnsRecord(domain.name, {
          type: dnsRecord.type,
          name: dnsRecord.name,
          value: dnsRecord.value,
          priority: dnsRecord.priority,
        })
        if (result.notFound) {
          dynadotSync = { success: true, message: 'Record was not present at the registrar' }
        } else if (result.success) {
          dynadotSync = { success: true, message: 'Removed at the registrar' }
        } else {
          failure = {
            status: 502,
            error: 'The registrar did not confirm the DNS update. The record was kept.',
          }
        }
      } catch (err) {
        if (err instanceof DnsWriteRefusedError) {
          failure = { status: dnsRefusalStatus(err.code), error: err.message, code: err.code }
        } else {
          console.error('[dns] registrar sync error (delete):', err)
          // SECURITY: never expose the raw registrar error to the customer
          failure = {
            status: 502,
            error: 'Registrar sync failed. The record was kept. Please try again or contact support.',
          }
        }
      }
      if (failure) dynadotSync = { success: false, message: failure.error }

      await logAudit({
        userId: decoded.userId,
        action: 'domain.dns.dynadot_sync',
        resource: 'domain',
        resourceId: domain.id,
        req: request,
        metadata: {
          afterDelete: true,
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

    await db.dnsRecord.delete({
      where: { id: recordId },
    })

    return NextResponse.json({
      message: 'DNS record deleted successfully',
      recordId,
      dynadotSync,
    })
  } catch (error) {
    console.error('Delete DNS record error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
