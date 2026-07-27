/**
 * GET /api/email-hosting/[serviceId]
 * One service in full: plan, limits, live usage from Mailcow, the DNS the
 * customer must publish, and the webmail entry point.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  resolveEmailService,
  emailServiceErrorResponse,
} from '@/lib/email-service-guard'
import {
  effectiveLimits,
  getEmailUsage,
  emailDnsRecords,
  webmailUrl,
} from '@/lib/email-hosting'
import { getDomain } from '@/lib/mailcow'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ serviceId: string }> }
) {
  const { serviceId } = await params
  try {
    const { service } = await resolveEmailService(request, serviceId)

    // DKIM lives in Mailcow, not our database — read it so the DNS panel can
    // show the real record rather than a placeholder.
    let dkimValue: string | undefined
    let dkimSelector: string | undefined
    try {
      // Shape is { success, domain: { dkim: { public, selector } } } — the key
      // is `public`, not `publicKey`.
      const d = await getDomain(service.domain)
      const dk = d.success ? d.domain?.dkim : undefined
      if (dk?.public) {
        dkimValue = dk.public
        dkimSelector = dk.selector
      }
    } catch {
      /* DNS panel still renders without it */
    }

    const [plan, usage] = await Promise.all([
      db.plan.findUnique({
        where: { id: service.planId },
        select: { id: true, name: true, slug: true, price: true, currency: true },
      }),
      getEmailUsage(service).catch(() => null),
    ])

    return NextResponse.json({
      service: {
        id: service.id,
        domain: service.domain,
        status: service.status,
        provisioned: service.mailcowDomainCreated,
        dkimGenerated: service.dkimGenerated,
        createdAt: service.createdAt,
      },
      plan,
      limits: effectiveLimits(service),
      usage,
      dns: emailDnsRecords(service.domain, { dkimValue, dkimSelector }),
      webmail: webmailUrl(),
    })
  } catch (err) {
    const { error, status } = emailServiceErrorResponse(err)
    return NextResponse.json({ error }, { status })
  }
}
