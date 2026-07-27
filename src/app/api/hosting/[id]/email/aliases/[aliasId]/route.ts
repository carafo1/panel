/**
 * /api/hosting/[id]/email/aliases/[aliasId]
 *   PATCH  — update destinations / enable / disable
 *   DELETE — remove the alias
 *
 * Ownership is re-checked against the caller's domains inside mailcow-manage:
 * an alias id on its own proves nothing about who it belongs to.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logAudit } from '@/lib/audit'
import { resolveMailTenant, mailErrorResponse } from '@/lib/mailcow-tenant'
import { updateAlias, deleteAlias } from '@/lib/mailcow-manage'

const patchSchema = z.object({
  destinations: z.array(z.string().min(3).max(255)).min(1).max(50).optional(),
  active: z.boolean().optional(),
})

type Ctx = { params: Promise<{ id: string; aliasId: string }> }

export async function PATCH(request: Request, { params }: Ctx) {
  const { id, aliasId } = await params
  try {
    const { domains, auth } = await resolveMailTenant(request, id)
    const body = patchSchema.parse(await request.json())
    const result = await updateAlias(Number(aliasId), body, domains)
    await logAudit({
      userId: auth.userId,
      action: 'email.alias.update',
      resource: 'project',
      resourceId: id,
      req: request,
      status: result.success ? 'success' : 'failure',
      metadata: { aliasId, ...body, error: result.error },
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

export async function DELETE(request: Request, { params }: Ctx) {
  const { id, aliasId } = await params
  try {
    const { domains, auth } = await resolveMailTenant(request, id)
    const result = await deleteAlias(Number(aliasId), domains)
    await logAudit({
      userId: auth.userId,
      action: 'email.alias.delete',
      resource: 'project',
      resourceId: id,
      req: request,
      status: result.success ? 'success' : 'failure',
      metadata: { aliasId, error: result.error },
    })
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 422 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    const { error, status } = mailErrorResponse(err)
    return NextResponse.json({ error }, { status })
  }
}
