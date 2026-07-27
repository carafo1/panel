/**
 * /api/hosting/[id]/email/spam
 *   GET    — spam threshold plus the project's whitelist / blacklist
 *   POST   — add a sender or domain  { list: 'wl'|'bl', domain, value }
 *   DELETE — remove an entry         { list: 'wl'|'bl', prefid }
 *
 * The threshold is a server-wide Mailcow setting and is therefore reported
 * read-only; the allow/deny lists are per-domain and fully managed here.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logAudit } from '@/lib/audit'
import { resolveMailTenant, mailErrorResponse } from '@/lib/mailcow-tenant'
import { getSpamPolicy, addPolicy, deletePolicy } from '@/lib/mailcow-manage'

const addSchema = z.object({
  list: z.enum(['wl', 'bl']),
  domain: z.string().min(3).max(253),
  value: z.string().min(1).max(255),
})
const delSchema = z.object({
  list: z.enum(['wl', 'bl']),
  prefid: z.number().int().positive(),
})

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const { domains } = await resolveMailTenant(request, id)
    const policy = await getSpamPolicy(domains)
    return NextResponse.json({ policy, domains })
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
    const body = addSchema.parse(await request.json())
    const result = await addPolicy(body.list, body.domain, body.value, domains)
    await logAudit({
      userId: auth.userId,
      action: body.list === 'wl' ? 'email.whitelist.add' : 'email.blacklist.add',
      resource: 'project',
      resourceId: id,
      req: request,
      status: result.success ? 'success' : 'failure',
      metadata: { domain: body.domain, value: body.value, error: result.error },
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

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const { domains, auth } = await resolveMailTenant(request, id)
    const body = delSchema.parse(await request.json())
    const result = await deletePolicy(body.list, body.prefid, domains)
    await logAudit({
      userId: auth.userId,
      action: body.list === 'wl' ? 'email.whitelist.remove' : 'email.blacklist.remove',
      resource: 'project',
      resourceId: id,
      req: request,
      status: result.success ? 'success' : 'failure',
      metadata: { prefid: body.prefid, error: result.error },
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
