/**
 * POST /api/hosting/[id]/email/catch-all
 * body: { domain, destination }   — destination null/empty disables it
 *
 * A catch-all is an alias at `@domain`, so this is a thin, clearly-named
 * wrapper over the alias operations rather than a separate concept.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logAudit } from '@/lib/audit'
import { resolveMailTenant, mailErrorResponse } from '@/lib/mailcow-tenant'
import { setCatchAll } from '@/lib/mailcow-manage'

const schema = z.object({
  domain: z.string().min(3).max(253),
  destination: z.string().max(255).nullable().optional(),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const { domains, auth } = await resolveMailTenant(request, id)
    const body = schema.parse(await request.json())
    const dest = body.destination?.trim() ? body.destination.trim() : null
    const result = await setCatchAll(body.domain, dest, domains)
    await logAudit({
      userId: auth.userId,
      action: dest ? 'email.catchall.enable' : 'email.catchall.disable',
      resource: 'project',
      resourceId: id,
      req: request,
      status: result.success ? 'success' : 'failure',
      metadata: { domain: body.domain, destination: dest, error: result.error },
    })
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 422 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: err.issues[0]?.message || 'Invalid request' },
        { status: 400 }
      )
    }
    const { error, status } = mailErrorResponse(err)
    return NextResponse.json({ error }, { status })
  }
}
