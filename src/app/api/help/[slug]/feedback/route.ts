import { NextResponse } from 'next/server'
import { recordFeedback, HelpError } from '@/lib/help'
import { withRateLimit } from '@/lib/rate-limit'

/** POST /api/help/[slug]/feedback   { helpful: boolean }  (public, rate-limited) */
async function postHandler(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const body = (await request.json().catch(() => ({}))) as { helpful?: unknown }
  if (typeof body.helpful !== 'boolean') return NextResponse.json({ error: 'helpful must be true or false' }, { status: 400 })
  try {
    await recordFeedback(slug, body.helpful)
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof HelpError) return NextResponse.json({ error: error.message }, { status: error.status })
    throw error
  }
}

export const POST = withRateLimit(postHandler, { limit: 10, windowMs: 60_000 })
