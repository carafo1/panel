/**
 * GET /api/email-hosting/[serviceId]/dns-health
 *
 * Checks what the customer has actually published against what we told them to
 * publish, live against real DNS.
 *
 * A separate endpoint rather than part of the service detail: this makes four
 * DNS lookups against the outside world, and the detail view should not wait
 * on that to render. The UI loads the page, then fills this in.
 */
import { NextResponse } from 'next/server'
import {
  resolveEmailService,
  emailServiceErrorResponse,
} from '@/lib/email-service-guard'
import { checkEmailDns } from '@/lib/email-dns-health'
import { getDomain } from '@/lib/mailcow'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ serviceId: string }> }
) {
  const { serviceId } = await params
  try {
    const { service } = await resolveEmailService(request, serviceId)

    // Read the real DKIM so the check compares against the key actually in
    // use, not a placeholder.
    let dkimValue: string | undefined
    let dkimSelector: string | undefined
    try {
      const d = await getDomain(service.domain)
      if (d.success && d.domain?.dkim?.public) {
        dkimValue = d.domain.dkim.public
        dkimSelector = d.domain.dkim.selector
      }
    } catch {
      /* the rest of the check is still worth running */
    }

    const health = await checkEmailDns(service.domain, { dkimValue, dkimSelector })
    return NextResponse.json(health, {
      // Cheap to recompute and the whole point is freshness — a cached
      // "your MX is missing" after the customer has fixed it is worse than
      // no check at all.
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    const { error, status } = emailServiceErrorResponse(err)
    return NextResponse.json({ error }, { status })
  }
}
