/**
 * GET /api/hosting/[id]/email/logs?kind=postfix|dovecot|rspamd-history|sogo&limit=
 *
 * Recent mail-server activity mentioning one of the project's domains:
 * delivery (postfix), mailbox logins (dovecot), spam decisions (rspamd) and
 * webmail (sogo). Mailcow returns these server-wide, so mailcow-manage filters
 * them to the caller — an unfiltered response would leak other tenants' mail.
 */
import { NextResponse } from 'next/server'
import { resolveMailTenant, mailErrorResponse } from '@/lib/mailcow-tenant'
import { getLogs, type LogKind } from '@/lib/mailcow-manage'

const KINDS: LogKind[] = ['postfix', 'dovecot', 'rspamd-history', 'sogo']

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const { domains } = await resolveMailTenant(request, id)
    const q = new URL(request.url).searchParams
    const kindParam = (q.get('kind') || 'postfix') as LogKind
    const kind = KINDS.includes(kindParam) ? kindParam : 'postfix'
    const limit = Math.min(Math.max(Number(q.get('limit')) || 200, 1), 1000)
    const entries = await getLogs(kind, domains, limit)
    return NextResponse.json({ kind, entries })
  } catch (err) {
    const { error, status } = mailErrorResponse(err)
    return NextResponse.json({ error }, { status })
  }
}
