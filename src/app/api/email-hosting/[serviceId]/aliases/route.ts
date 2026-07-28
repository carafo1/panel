/**
 * /api/email-hosting/[serviceId]/aliases
 *   GET    — aliases on this service's domain
 *   POST   — create { localPart, destinations[], active? }
 *   PATCH  — update { id, destinations?, active? }
 *   DELETE — remove { id }
 *
 * One object covers three products: a single destination is a forwarder, several
 * destinations is a distribution list, and `@domain` is the catch-all (which has
 * its own route). Mailcow models them all as an alias, so this does too rather
 * than inventing a distinction the mail server does not have.
 *
 * Scoping is `resolveEmailService` → `domains: [service.domain]`, and every
 * mailcow-manage alias call re-checks ownership against that list before
 * touching anything, so an id from the client cannot reach another tenant.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logAudit } from '@/lib/audit'
import {
  resolveEmailService,
  emailServiceErrorResponse,
} from '@/lib/email-service-guard'
import {
  listAliases,
  createAlias,
  updateAlias,
  deleteAlias,
} from '@/lib/mailcow-manage'

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const createSchema = z.object({
  localPart: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9._+-]+$/i, 'Use letters, digits, dots, dashes or underscores'),
  destinations: z
    .array(z.string().regex(emailRe, 'Each destination must be an email address'))
    .min(1, 'Add at least one destination')
    .max(100),
  active: z.boolean().optional(),
})

const patchSchema = z.object({
  id: z.number().int().positive(),
  destinations: z
    .array(z.string().regex(emailRe, 'Each destination must be an email address'))
    .min(1)
    .max(100)
    .optional(),
  active: z.boolean().optional(),
})

const deleteSchema = z.object({ id: z.number().int().positive() })

export async function GET(
  request: Request,
  { params }: { params: Promise<{ serviceId: string }> }
) {
  const { serviceId } = await params
  try {
    const { domains } = await resolveEmailService(request, serviceId)
    const all = await listAliases(domains)
    // The catch-all is managed separately; keep it out of the alias list so it
    // cannot be deleted from here by accident.
    return NextResponse.json({ aliases: all.filter((a) => !a.isCatchAll) })
  } catch (err) {
    const { error, status } = emailServiceErrorResponse(err)
    return NextResponse.json({ error }, { status })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ serviceId: string }> }
) {
  const { serviceId } = await params
  try {
    const { service, auth, domains } = await resolveEmailService(request, serviceId)
    if (service.status !== 'active') {
      return NextResponse.json(
        { error: 'This email service is not active.' },
        { status: 409 }
      )
    }

    const body = createSchema.parse(await request.json())
    const address = `${body.localPart.toLowerCase()}@${service.domain}`
    const result = await createAlias(
      address,
      body.destinations,
      domains,
      body.active !== false
    )

    await logAudit({
      userId: auth.userId,
      action: 'email.alias.create',
      resource: 'emailService',
      resourceId: service.id,
      req: request,
      status: result.success ? 'success' : 'failure',
      metadata: {
        address,
        destinations: body.destinations.length,
        error: result.error,
      },
    })

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 422 })
    }
    return NextResponse.json({ ok: true, address })
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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ serviceId: string }> }
) {
  const { serviceId } = await params
  try {
    const { service, auth, domains } = await resolveEmailService(request, serviceId)
    const body = patchSchema.parse(await request.json())

    const result = await updateAlias(
      body.id,
      { destinations: body.destinations, active: body.active },
      domains
    )

    await logAudit({
      userId: auth.userId,
      action: 'email.alias.update',
      resource: 'emailService',
      resourceId: service.id,
      req: request,
      status: result.success ? 'success' : 'failure',
      metadata: { id: body.id, active: body.active, error: result.error },
    })

    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: result.error === 'Alias not found' ? 404 : 422 }
      )
    }
    return NextResponse.json({ ok: true })
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
  { params }: { params: Promise<{ serviceId: string }> }
) {
  const { serviceId } = await params
  try {
    const { service, auth, domains } = await resolveEmailService(request, serviceId)
    const body = deleteSchema.parse(await request.json())

    const result = await deleteAlias(body.id, domains)

    await logAudit({
      userId: auth.userId,
      action: 'email.alias.delete',
      resource: 'emailService',
      resourceId: service.id,
      req: request,
      status: result.success ? 'success' : 'failure',
      metadata: { id: body.id, error: result.error },
    })

    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: result.error === 'Alias not found' ? 404 : 422 }
      )
    }
    return NextResponse.json({ ok: true })
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
