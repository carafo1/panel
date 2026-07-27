/**
 * /api/hosting/[id]/email/aliases
 *   GET  — aliases and forwarders on the project's domains
 *   POST — create one  { address, destinations[], active? }
 *
 * An alias with several destinations IS a forwarder, and one whose address is
 * `@domain` is the catch-all; they are the same Mailcow object, so they are
 * managed together here.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logAudit } from '@/lib/audit'
import { resolveMailTenant, mailErrorResponse } from '@/lib/mailcow-tenant'
import { listAliases, createAlias } from '@/lib/mailcow-manage'

const createSchema = z.object({
  address: z.string().min(3).max(255),
  destinations: z.array(z.string().min(3).max(255)).min(1).max(50),
  active: z.boolean().optional(),
})

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const { domains } = await resolveMailTenant(request, id)
    const aliases = await listAliases(domains)
    return NextResponse.json({ aliases, domains })
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
    const body = createSchema.parse(await request.json())
    const result = await createAlias(
      body.address,
      body.destinations,
      domains,
      body.active ?? true
    )
    await logAudit({
      userId: auth.userId,
      action: 'email.alias.create',
      resource: 'project',
      resourceId: id,
      req: request,
      status: result.success ? 'success' : 'failure',
      metadata: {
        address: body.address,
        destinations: body.destinations.length,
        error: result.error,
      },
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
