import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { verifyTxtRecord } from '@/lib/dns'
import { logAudit } from '@/lib/audit'
import { getProjectAccess } from '@/lib/project-access'
import { findConflict } from '@/lib/custom-domains'
import { isProtectedDnsDomain } from '@/lib/dynadot'
import {
  decideCustomDomainLink,
  customDomainLinkMessage,
  type CustomDomainLinkDecision,
} from '@/lib/custom-domain-link'

/**
 * Gather everything the link decision needs — read-only, no writes.
 * The caller must hold 'configure' on the project (owner, platform admin,
 * or a team admin/developer).
 */
async function planProjectLink(
  user: { userId: string; role?: string | null },
  domain: { name: string; provider: string; projectId: string | null }
): Promise<CustomDomainLinkDecision> {
  if ((domain.provider || '').toLowerCase() !== 'custom' || !domain.projectId) {
    return decideCustomDomainLink({
      provider: domain.provider,
      domainName: domain.name,
      projectId: domain.projectId,
      canConfigure: false,
      projectCustomDomain: null,
      inUseElsewhere: false,
      reserved: false,
    })
  }
  const access = await getProjectAccess(user, domain.projectId)
  const canConfigure = Boolean(access?.can('configure'))
  const project = canConfigure
    ? await db.project.findUnique({
        where: { id: domain.projectId },
        select: { customDomain: true },
      })
    : null
  const conflict = canConfigure
    ? await findConflict(domain.name.toLowerCase(), domain.projectId)
    : { conflict: false as const }
  return decideCustomDomainLink({
    provider: domain.provider,
    domainName: domain.name,
    projectId: domain.projectId,
    canConfigure: canConfigure && Boolean(project),
    projectCustomDomain: project?.customDomain ?? null,
    inUseElsewhere: conflict.conflict,
    reserved: isProtectedDnsDomain(domain.name),
  })
}

function linkNote(decision: CustomDomainLinkDecision): { linkMessage?: string } {
  if (decision.action !== 'skip') return {}
  const msg = customDomainLinkMessage(decision.reason)
  return msg ? { linkMessage: msg } : {}
}

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
 *   - a provider "custom" domain with a projectId the caller may configure is
 *     linked as that project's customDomain, if the project has none yet
 *     (see lib/custom-domain-link for the rules)
 *
 * Returns: { verified, linkedToProject?, linkMessage?, message }
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

    // Already verified - short-circuit success. Still (idempotently) attempt
    // the project link, so a domain verified before linking moved here is
    // attached on the next click.
    if (domain.verification.verified) {
      const decision = await planProjectLink(decoded, domain)
      let linked = decision.action === 'already_linked'
      if (decision.action === 'link') {
        const res = await db.project.updateMany({
          where: { id: domain.projectId as string, customDomain: null },
          data: { customDomain: domain.name },
        })
        linked = res.count === 1
      }
      return NextResponse.json({
        verified: true,
        linkedToProject: linked,
        message: 'Domain is already verified.',
        ...linkNote(decision),
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

    // Decide the project link (access, conflicts, reserved names) BEFORE any
    // write. Register no longer sets project.customDomain for an unverified
    // custom domain; this is where it is attached once DNS proves control.
    const decision = await planProjectLink(decoded, domain)

    // Verified! Update both records — and link the project in the same
    // transaction. The link is conditional on customDomain still being empty,
    // so a primary set concurrently is never overwritten.
    const results = await db.$transaction([
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
      ...(decision.action === 'link'
        ? [
            db.project.updateMany({
              where: { id: domain.projectId as string, customDomain: null },
              data: { customDomain: domain.name },
            }),
          ]
        : []),
    ])
    const linked =
      decision.action === 'already_linked' ||
      (decision.action === 'link' && (results[2] as { count: number } | undefined)?.count === 1)

    await logAudit({
      userId: decoded.userId,
      action: 'domain.verify',
      resource: 'domain',
      resourceId: domain.id,
      req: request,
      metadata: {
        result: 'success',
        provider: domain.provider,
        projectId: domain.projectId,
        linkedToProject: linked,
        ...(decision.action === 'skip' ? { linkSkipped: decision.reason } : {}),
      },
    })

    return NextResponse.json({
      verified: true,
      linkedToProject: linked,
      message: 'Domain verified successfully! Your domain is now active.',
      ...linkNote(decision),
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
