/**
 * /api/email-hosting/[serviceId]/mailboxes
 *   GET  — mailboxes on this service's domain, with usage
 *   POST — create one  { localPart, password, name?, quotaGB? }
 *
 * The plan is enforced here, not in the UI: a request that would exceed the
 * purchased mailbox count or per-mailbox quota is refused server-side, so a
 * customer cannot get more than they bought by calling the API directly.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logAudit } from '@/lib/audit'
import {
  resolveEmailService,
  emailServiceErrorResponse,
} from '@/lib/email-service-guard'
import { effectiveLimits, getEmailUsage } from '@/lib/email-hosting'
import { listMailboxes, createMailbox, friendlyMailcowError } from '@/lib/mailcow'

const createSchema = z.object({
  localPart: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9._-]+$/i, 'Use letters, digits, dots, dashes or underscores'),
  password: z.string().min(8).max(128),
  name: z.string().max(120).optional(),
  quotaGB: z.number().int().positive().max(1000).optional(),
})

export async function GET(
  request: Request,
  { params }: { params: Promise<{ serviceId: string }> }
) {
  const { serviceId } = await params
  try {
    const { service } = await resolveEmailService(request, serviceId)
    const [res, usage] = await Promise.all([
      listMailboxes(service.domain),
      getEmailUsage(service).catch(() => null),
    ])
    return NextResponse.json({
      mailboxes: res.success ? res.mailboxes || [] : [],
      usage,
      limits: effectiveLimits(service),
      error: res.success ? undefined : res.error,
    })
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
    const { service, auth } = await resolveEmailService(request, serviceId)

    if (service.status !== 'active') {
      return NextResponse.json(
        {
          error:
            service.status === 'suspended'
              ? 'This email service is suspended. Settle the outstanding invoice to continue.'
              : 'This email service is not active yet.',
        },
        { status: 409 }
      )
    }

    const body = createSchema.parse(await request.json())
    const limits = effectiveLimits(service)

    // ── Plan enforcement ──
    const usage = await getEmailUsage(service)
    if (usage.mailboxes >= limits.mailboxLimit) {
      return NextResponse.json(
        {
          error: `Your plan includes ${limits.mailboxLimit} mailboxes and all of them are in use. Upgrade your plan or add an extra mailbox to create another.`,
          code: 'MAILBOX_LIMIT',
        },
        { status: 409 }
      )
    }
    const quotaGB = Math.min(
      body.quotaGB ?? limits.storagePerMailboxGB,
      limits.storagePerMailboxGB
    )

    const address = `${body.localPart.toLowerCase()}@${service.domain}`
    const result = await createMailbox({
      localPart: body.localPart.toLowerCase(),
      domain: service.domain,
      password: body.password,
      name: body.name || body.localPart,
      quota: quotaGB * 1024, // Mailcow takes MB
    })

    await logAudit({
      userId: auth.userId,
      action: 'email.mailbox.create',
      resource: 'emailService',
      resourceId: service.id,
      req: request,
      status: result.success ? 'success' : 'failure',
      metadata: { address, quotaGB, error: result.error },
    })

    if (!result.success) {
      return NextResponse.json(
        { error: friendlyMailcowError(result.error) },
        { status: 422 }
      )
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
