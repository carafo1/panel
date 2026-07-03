import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { setDnsRecords } from '@/lib/dynadot'
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

    const decoded = verifyToken(token)
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
      include: { dnsRecords: true },
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

    await db.dnsRecord.delete({
      where: { id: recordId },
    })

    // ─── Push the updated record set to Dynadot ────────────────
    let dynadotSync: { success: boolean; message?: string } | null = null
    if (domain.provider === 'dynadot') {
      try {
        // Pull the remaining records (post-delete)
        const remaining = await db.dnsRecord.findMany({
          where: { domainId: domain.id },
        })
        const dynadotRecords = remaining.slice(0, 10).map((r) => ({
          type: r.type,
          name: r.name,
          value: r.value,
          ttl: r.ttl,
        }))
        const result = await setDnsRecords(domain.name, dynadotRecords)
        dynadotSync = {
          success: result.success,
          message: result.success
            ? 'Pushed to the registrar'
            : 'Failed to push to the registrar',
        }
      } catch (err) {
        console.error('[dns] registrar sync error (delete):', err)
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
          afterDelete: true,
          success: dynadotSync.success,
          message: dynadotSync.message,
        },
      })
    }

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
