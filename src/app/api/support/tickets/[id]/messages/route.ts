import { NextResponse } from 'next/server'
import { addMessage } from '@/lib/support'
import { supportViewer, unauthorized, supportFailure } from '@/lib/support-http'
import { withRateLimit } from '@/lib/rate-limit'

/** POST /api/support/tickets/[id]/messages   { body, internal? (staff only) } */
async function postHandler(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const viewer = await supportViewer(request)
    if (!viewer) return unauthorized()
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    return NextResponse.json({ message: await addMessage(id, viewer, body) }, { status: 201 })
  } catch (error) {
    return supportFailure(error, '[support] message failed:')
  }
}

export const POST = withRateLimit(postHandler, { limit: 30, windowMs: 60_000 })
