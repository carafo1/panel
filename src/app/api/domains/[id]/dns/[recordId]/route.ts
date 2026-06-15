import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'

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
    })

    if (!domain) {
      return NextResponse.json(
        { error: 'Domain not found' },
        { status: 404 }
      )
    }

    // Find and delete the DNS record
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

    return NextResponse.json({
      message: 'DNS record deleted successfully',
      recordId,
    })
  } catch (error) {
    console.error('Delete DNS record error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
