/**
 * /api/email-hosting/[serviceId]/mailboxes/[address]/autoreply
 *   GET — the current auto-reply
 *   PUT — save it { enabled, subject, message, startDate?, endDate?, intervalDays? }
 *
 * Mailcow has no out-of-office endpoint, so this is a managed sieve `vacation`
 * script. The customer never sees sieve.
 *
 * As with every mailbox route, the ADDRESS must sit on a service the caller
 * owns — owning *a* service is not enough.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logAudit } from '@/lib/audit'
import {
  resolveEmailService,
  emailServiceErrorResponse,
} from '@/lib/email-service-guard'
import { getAutoReply, setAutoReply } from '@/lib/mailcow-mailbox'

const saveSchema = z.object({
  enabled: z.boolean(),
  subject: z.string().min(1).max(200).default('Out of office'),
  message: z.string().max(5000).default(''),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .nullable()
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .nullable()
    .optional(),
  intervalDays: z.number().int().min(1).max(30).default(1),
})

async function resolveMailbox(
  request: Request,
  serviceId: string,
  rawAddress: string
) {
  const resolved = await resolveEmailService(request, serviceId)
  const address = decodeURIComponent(rawAddress).toLowerCase().trim()
  const domain = address.split('@')[1]
  if (!domain || domain !== resolved.service.domain.toLowerCase()) {
    return { ...resolved, address: null as string | null }
  }
  return { ...resolved, address }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ serviceId: string; address: string }> }
) {
  const { serviceId, address: raw } = await params
  try {
    const { address } = await resolveMailbox(request, serviceId, raw)
    if (!address) {
      return NextResponse.json({ error: 'Mailbox not found' }, { status: 404 })
    }
    return NextResponse.json({ autoReply: await getAutoReply(address) })
  } catch (err) {
    const { error, status } = emailServiceErrorResponse(err)
    return NextResponse.json({ error }, { status })
  }
}

export async function PUT(
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

    const body = saveSchema.parse(await request.json())
    if (body.enabled && !body.message.trim()) {
      return NextResponse.json(
        { error: 'Write the message people will receive' },
        { status: 400 }
      )
    }
    if (body.startDate && body.endDate && body.endDate < body.startDate) {
      return NextResponse.json(
        { error: 'The end date is before the start date' },
        { status: 400 }
      )
    }

    const result = await setAutoReply(address, {
      enabled: body.enabled,
      subject: body.subject,
      message: body.message,
      startDate: body.startDate ?? null,
      endDate: body.endDate ?? null,
      intervalDays: body.intervalDays,
    })

    await logAudit({
      userId: auth.userId,
      action: 'email.autoreply.save',
      resource: 'emailService',
      resourceId: service.id,
      req: request,
      status: result.success ? 'success' : 'failure',
      metadata: {
        address,
        enabled: body.enabled,
        window: [body.startDate, body.endDate],
        error: result.error,
      },
    })

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 422 })
    }
    return NextResponse.json({ ok: true, autoReply: await getAutoReply(address) })
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
