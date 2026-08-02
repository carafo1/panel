/**
 * GET /api/email-hosting/[serviceId]/mailboxes/[address]/webmail
 *
 * Signs the customer into webmail for this mailbox. Returns an HTML page that
 * posts the stored credential straight into the mail server's login form.
 *
 * Authentication is by short-lived ticket rather than the usual Bearer header,
 * because this is opened by the BROWSER (a link or window.open), which cannot
 * attach an Authorization header. The ticket is minted by the authenticated
 * mailbox owner, is single-use, expires in seconds, and is bound to the exact
 * address it was issued for.
 *
 * Returns 409 (not an error page) when the panel holds no credential — the
 * caller then falls back to sending the customer to normal webmail login.
 */
import { NextResponse } from 'next/server'
import { logAudit } from '@/lib/audit'
import { consumeWebmailTicket } from '@/lib/webmail-ticket'
import { getMailboxPassword, buildSsoPage } from '@/lib/webmail-sso'
import { db } from '@/lib/db'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ serviceId: string; address: string }> }
) {
  const { serviceId, address: raw } = await params
  const address = decodeURIComponent(raw).toLowerCase().trim()
  const ticket = new URL(request.url).searchParams.get('t') || ''

  // The ticket proves the panel user owns this mailbox; it was issued only
  // after resolveEmailService succeeded on the POST that minted it.
  const claim = consumeWebmailTicket(ticket)
  if (!claim || claim.address !== address || claim.serviceId !== serviceId) {
    return new NextResponse('This sign-in link has expired. Please try again.', {
      status: 401,
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
    })
  }

  const password = await getMailboxPassword(address)
  if (!password) {
    return NextResponse.json(
      {
        error:
          'Automatic sign-in is not available for this mailbox. Open webmail and sign in with the mailbox password.',
        code: 'NO_STORED_CREDENTIAL',
      },
      { status: 409, headers: { 'Cache-Control': 'no-store' } }
    )
  }

  await db.emailMailboxSecret
    .updateMany({ where: { address }, data: { lastVerifiedAt: new Date() } })
    .catch(() => {})

  await logAudit({
    userId: claim.userId,
    action: 'email.webmail.sso',
    resource: 'emailService',
    resourceId: serviceId,
    req: request,
    status: 'success',
    metadata: { address },
  })

  return new NextResponse(buildSsoPage({ address, password }), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The page contains a credential: never cached, never framed, never
      // referred onward.
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
}
