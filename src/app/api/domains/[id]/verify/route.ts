import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { verifyTxtRecord } from '@/lib/dns'
import { logAudit } from '@/lib/audit'

/**
 * POST /api/domains/[id]/verify
 *
 * Verify ownership of a custom domain by checking that the DNS TXT record
 * on the apex domain matches the verification code stored in the
 * DomainVerification table.
 *
 * On success:
 *   - Domain.status is set to 'active'
 *   - DomainVerification.verified = true, verifiedAt = now
 *
 * Returns: { verified: boolean, message: string }
 */
export async function POST(
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

    // Look up the domain and its verification record
    const domain = await db.domain.findFirst({
      where: { id, userId: decoded.userId },
      include: { verification: true },
    })

    if (!domain) {
      return NextResponse.json(
        { error: 'Domain not found' },
        { status: 404 }
      )
    }

    if (!domain.verification) {
      return NextResponse.json(
        {
          verified: false,
          message:
            'No verification record exists for this domain. This domain does not require DNS verification.',
        },
        { status: 400 }
      )
    }

    // Already verified - short-circuit success
    if (domain.verification.verified) {
      return NextResponse.json({
        verified: true,
        message: 'Domain is already verified.',
      })
    }

    // Perform real DNS lookup against the apex domain
    const expectedCode = domain.verification.verificationCode
    const matched = await verifyTxtRecord(domain.name, expectedCode)

    if (!matched) {
      await logAudit({
        userId: decoded.userId,
        action: 'domain.verify',
        resource: 'domain',
        resourceId: domain.id,
        req: request,
        metadata: { result: 'failed', provider: domain.provider },
        status: 'failure',
      })

      return NextResponse.json({
        verified: false,
        message:
          'Verification failed. The TXT record was not found or does not match. DNS changes can take a few minutes to propagate - try again shortly.',
      })
    }

    // Verified! Update both records.
    await db.$transaction([
      db.domain.update({
        where: { id: domain.id },
        data: { status: 'active' },
      }),
      db.domainVerification.update({
        where: { domainId: domain.id },
        data: {
          verified: true,
          verifiedAt: new Date(),
        },
      }),
    ])

    await logAudit({
      userId: decoded.userId,
      action: 'domain.verify',
      resource: 'domain',
      resourceId: domain.id,
      req: request,
      metadata: { result: 'success', provider: domain.provider },
    })

    return NextResponse.json({
      verified: true,
      message: 'Domain verified successfully! Your domain is now active.',
    })
  } catch (error) {
    console.error('Verify domain error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * GET /api/domains/[id]/verify
 * Convenience: returns the current verification status without performing
 * a fresh DNS lookup. (Use the /verify-code route for the code itself.)
 */
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

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { id } = await params
    const domain = await db.domain.findFirst({
      where: { id, userId: decoded.userId },
      include: { verification: true },
    })

    if (!domain) {
      return NextResponse.json(
        { error: 'Domain not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({
      domainId: domain.id,
      status: domain.status,
      provider: domain.provider,
      verified: domain.verification?.verified ?? false,
      verifiedAt: domain.verification?.verifiedAt ?? null,
      hasVerification: !!domain.verification,
    })
  } catch (error) {
    console.error('Get verification status error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
