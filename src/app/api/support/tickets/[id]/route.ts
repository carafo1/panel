import { NextResponse } from 'next/server'
import { getTicket, updateTicket } from '@/lib/support'
import { supportViewer, unauthorized, supportFailure } from '@/lib/support-http'

/**
 * GET   /api/support/tickets/[id]   the ticket and its conversation
 * PATCH /api/support/tickets/[id]   { status } (customer: resolve/close/reopen)
 *                                   { priority, category, assignedToId } (staff)
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const viewer = await supportViewer(request)
    if (!viewer) return unauthorized()
    const { id } = await params
    return NextResponse.json({ ticket: await getTicket(id, viewer) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return supportFailure(error, '[support] get failed:')
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const viewer = await supportViewer(request)
    if (!viewer) return unauthorized()
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    return NextResponse.json(await updateTicket(id, viewer, body))
  } catch (error) {
    return supportFailure(error, '[support] update failed:')
  }
}
