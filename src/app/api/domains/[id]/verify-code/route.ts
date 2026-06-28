import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'

/**
 * GET /api/domains/[id]/verify-code
 *
 * Returns the DNS verification code and setup instructions for a custom
 * domain. Used by the UI to render a "verify your domain" panel.
 *
 * Returns: {
 *   code: string,
 *   instructions: string,
 *   txtName: string,        // "@" (apex)
 *   txtValue: string,       // the verification code
 *   verified: boolean,
 *   verifiedAt: string | null,
 *   requiresVerification: boolean
 * }
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
      include: { verification: true },
    })

    if (!domain) {
      return NextResponse.json(
        { error: 'Domain not found' },
        { status: 404 }
      )
    }

    // Domains registered through Dynadot (or default APSAMO flow) are
    // already trusted and do not require DNS verification.
    const requiresVerification =
      domain.provider === 'custom' ||
      domain.status === 'pending_verification'

    if (!domain.verification) {
      return NextResponse.json({
        code: null,
        instructions: requiresVerification
          ? 'No verification record found. Please contact support.'
          : 'This domain does not require DNS verification.',
        txtName: '@',
        txtValue: null,
        verified: false,
        verifiedAt: null,
        requiresVerification,
      })
    }

    const code = domain.verification.verificationCode

    return NextResponse.json({
      code,
      txtName: '@',
      txtValue: code,
      instructions: `Add a TXT record with name @ and value: ${code}`,
      verified: domain.verification.verified,
      verifiedAt: domain.verification.verifiedAt,
      requiresVerification,
      domainName: domain.name,
      status: domain.status,
      provider: domain.provider,
    })
  } catch (error) {
    console.error('Get verify-code error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
