/**
 * GET /api/hosting/[id]/email/stats
 * Dashboard figures for the project's mail: mailbox counts, storage, messages,
 * quarantine and queue depth. Scoped to the project's own domains.
 */
import { NextResponse } from 'next/server'
import { resolveMailTenant, mailErrorResponse } from '@/lib/mailcow-tenant'
import { getMailStats } from '@/lib/mailcow-manage'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const { domains } = await resolveMailTenant(request, id)
    const stats = await getMailStats(domains)
    return NextResponse.json({ stats, domains })
  } catch (err) {
    const { error, status } = mailErrorResponse(err)
    return NextResponse.json({ error }, { status })
  }
}
