/**
 * /api/hosting/[id]/email/quarantine
 *   GET  — messages held for this project's mailboxes
 *   POST — { action: 'release'|'delete', ids: number[] }
 *
 * Mailcow's quarantine is server-wide; mailcow-manage filters it to the
 * caller's recipients and re-checks ownership before acting on any id.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logAudit } from '@/lib/audit'
import { resolveMailTenant, mailErrorResponse } from '@/lib/mailcow-tenant'
import { listQuarantine, quarantineAction } from '@/lib/mailcow-manage'

const actionSchema = z.object({
  action: z.enum(['release', 'delete']),
  ids: z.array(z.number().int().positive()).min(1).max(200),
})

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const { domains } = await resolveMailTenant(request, id)
    const messages = await listQuarantine(domains)
    return NextResponse.json({ messages })
  } catch (err) {
    const { error, status } = mailErrorResponse(err)
    return NextResponse.json({ error }, { status })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const { domains, auth } = await resolveMailTenant(request, id)
    const body = actionSchema.parse(await request.json())
    const result = await quarantineAction(body.action, body.ids, domains)
    await logAudit({
      userId: auth.userId,
      action: `email.quarantine.${body.action}`,
      resource: 'project',
      resourceId: id,
      req: request,
      status: result.success ? 'success' : 'failure',
      metadata: { count: body.ids.length, error: result.error },
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
