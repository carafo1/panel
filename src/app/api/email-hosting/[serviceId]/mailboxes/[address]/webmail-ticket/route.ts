/**
 * POST /api/email-hosting/[serviceId]/mailboxes/[address]/webmail-ticket
 *
 * Mints a short-lived, single-use ticket the browser can use to open webmail
 * sign-in. This is the Bearer-authenticated half of the flow: ownership of the
 * mailbox is proven here, so the page the browser opens next only has to
 * redeem the ticket.
 *
 * Answers `available: false` when the panel holds no credential for the
 * mailbox, so the UI can send the customer to normal webmail login instead of
 * opening a window that cannot sign them in.
 */
import { NextResponse } from 'next/server'
import {
  resolveEmailService,
  emailServiceErrorResponse,
} from '@/lib/email-service-guard'
import { hasStoredPassword } from '@/lib/webmail-sso'
import { issueWebmailTicket } from '@/lib/webmail-ticket'
import { webmailUrl } from '@/lib/email-hosting'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ serviceId: string; address: string }> }
) {
  const { serviceId, address: raw } = await params
  try {
    const { service, auth } = await resolveEmailService(request, serviceId)

    const address = decodeURIComponent(raw).toLowerCase().trim()
    const domain = address.split('@')[1]
    if (!domain || domain !== service.domain.toLowerCase()) {
      return NextResponse.json({ error: 'Mailbox not found' }, { status: 404 })
    }

    if (!(await hasStoredPassword(address))) {
      return NextResponse.json({
        available: false,
        webmail: webmailUrl(),
        reason:
          'This mailbox was created or its password changed outside the panel, so we cannot sign you in automatically.',
      })
    }

    const { ticket, expiresInSeconds } = issueWebmailTicket({
      userId: auth.userId,
      serviceId: service.id,
      address,
    })

    return NextResponse.json(
      {
        available: true,
        url: `/api/email-hosting/${service.id}/mailboxes/${encodeURIComponent(
          address
        )}/webmail?t=${ticket}`,
        expiresInSeconds,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (err) {
    const { error, status } = emailServiceErrorResponse(err)
    return NextResponse.json({ error }, { status })
  }
}
