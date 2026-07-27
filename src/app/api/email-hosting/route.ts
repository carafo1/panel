/**
 * GET /api/email-hosting
 * Every standalone email-hosting service the signed-in customer owns, with the
 * plan it runs on. This is the entry point for the email dashboard.
 */
import { NextResponse } from 'next/server'
import { listOwnEmailServices, emailServiceErrorResponse } from '@/lib/email-service-guard'
import { effectiveLimits, webmailUrl } from '@/lib/email-hosting'

export async function GET(request: Request) {
  try {
    const { services } = await listOwnEmailServices(request)
    return NextResponse.json({
      services: services.map((s) => ({
        id: s.id,
        domain: s.domain,
        status: s.status,
        plan: s.plan,
        limits: effectiveLimits(s),
        provisioned: s.mailcowDomainCreated,
        dkimGenerated: s.dkimGenerated,
        createdAt: s.createdAt,
      })),
      webmail: webmailUrl(),
    })
  } catch (err) {
    const { error, status } = emailServiceErrorResponse(err)
    return NextResponse.json({ error }, { status })
  }
}
