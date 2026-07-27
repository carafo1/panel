/**
 * /api/email-hosting/[serviceId]/mailboxes/[address]
 *   PATCH  — change password, display name, quota or active state
 *   DELETE — remove the mailbox and everything stored in it
 *
 * The address is never trusted from the URL alone: it must sit on the domain
 * of a service the caller owns. Without that check, a customer who owns one
 * service could pass any address here and edit another tenant's mailbox.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logAudit } from '@/lib/audit'
import {
  resolveEmailService,
  emailServiceErrorResponse,
} from '@/lib/email-service-guard'
import { effectiveLimits } from '@/lib/email-hosting'
import { deleteMailbox, updateMailbox } from '@/lib/mailcow'

const patchSchema = z.object({
  password: z.string().min(8).max(128).optional(),
  name: z.string().max(120).optional(),
  quotaGB: z.number().int().positive().max(1000).optional(),
  active: z.boolean().optional(),
})

/** Resolve the service and prove `address` belongs to it. */
async function resolveMailbox(
  request: Request,
  serviceId: string,
  rawAddress: string
) {
  const resolved = await resolveEmailService(request, serviceId)
  const address = decodeURIComponent(rawAddress).toLowerCase().trim()
  const domain = address.split('@')[1]
  if (!domain || domain !== resolved.service.domain.toLowerCase()) {
    // Same response as a genuinely missing mailbox — probing for addresses on
    // other domains should not be distinguishable from a typo.
    return { ...resolved, address: null as string | null }
  }
  return { ...resolved, address }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ serviceId: string; address: string }> }
) {
  const { serviceId, address: raw } = await params
  try {
    const { service, auth, address } = await resolveMailbox(request, serviceId, raw)
    if (!address) {
      return NextResponse.json({ error: 'Mailbox not found' }, { status: 404 })
    }
    if (service.status !== 'active') {
      return NextResponse.json(
        { error: 'This email service is not active.' },
        { status: 409 }
      )
    }

    const body = patchSchema.parse(await request.json())
    const limits = effectiveLimits(service)
    // A quota request is clamped rather than rejected: the customer asked for
    // more than they bought, so give them exactly what the plan allows.
    const quotaGB =
      body.quotaGB === undefined
        ? undefined
        : Math.min(body.quotaGB, limits.storagePerMailboxGB)

    const result = await updateMailbox({
      address,
      password: body.password,
      name: body.name,
      quotaMB: quotaGB === undefined ? undefined : quotaGB * 1024,
      active: body.active,
    })

    await logAudit({
      userId: auth.userId,
      action: 'email.mailbox.update',
      resource: 'emailService',
      resourceId: service.id,
      req: request,
      status: result.success ? 'success' : 'failure',
      // Never log the password itself — only that one was set.
      metadata: {
        address,
        passwordChanged: Boolean(body.password),
        name: body.name,
        quotaGB,
        active: body.active,
        error: result.error,
      },
    })

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 422 })
    }
    return NextResponse.json({ ok: true, address, quotaGB })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: err.issues[0]?.message || 'Invalid request' },
        { status: 400 }
      )
    }
    const { error, status } = emailServiceErrorResponse(err)
    return NextResponse.json({ error }, { status })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ serviceId: string; address: string }> }
) {
  const { serviceId, address: raw } = await params
  try {
    const { service, auth, address } = await resolveMailbox(request, serviceId, raw)
    if (!address) {
      return NextResponse.json({ error: 'Mailbox not found' }, { status: 404 })
    }

    const result = await deleteMailbox(address)

    await logAudit({
      userId: auth.userId,
      action: 'email.mailbox.delete',
      resource: 'emailService',
      resourceId: service.id,
      req: request,
      status: result.success ? 'success' : 'failure',
      metadata: { address, error: result.error },
    })

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 422 })
    }
    return NextResponse.json({ ok: true, address })
  } catch (err) {
    const { error, status } = emailServiceErrorResponse(err)
    return NextResponse.json({ error }, { status })
  }
}
