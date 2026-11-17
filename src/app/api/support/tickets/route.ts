import { NextResponse } from 'next/server'
import { createTicket, listTickets } from '@/lib/support'
import { supportViewer, unauthorized, supportFailure } from '@/lib/support-http'
import { withRateLimit } from '@/lib/rate-limit'

/**
 * GET  /api/support/tickets[?all=1&status=&q=]   your tickets (staff: all with ?all=1)
 * POST /api/support/tickets   { subject, body, category?, priority?, projectId? }
 */
export async function GET(request: Request) {
  try {
    const viewer = await supportViewer(request)
    if (!viewer) return unauthorized()
    const sp = new URL(request.url).searchParams
    const tickets = await listTickets(viewer, {
      all: sp.get('all') === '1',
      status: sp.get('status') || undefined,
      q: sp.get('q') || undefined,
    })
    return NextResponse.json({ tickets }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return supportFailure(error, '[support] list failed:')
  }
}

async function postHandler(request: Request) {
  try {
    const viewer = await supportViewer(request)
    if (!viewer) return unauthorized()
    const body = await request.json().catch(() => ({}))
    const ticket = await createTicket(viewer, body)
    return NextResponse.json({ ticket }, { status: 201 })
  } catch (error) {
    return supportFailure(error, '[support] create failed:')
  }
}

export const POST = withRateLimit(postHandler, { limit: 10, windowMs: 60_000 })
