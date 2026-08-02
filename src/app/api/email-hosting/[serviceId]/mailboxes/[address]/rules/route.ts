/**
 * /api/email-hosting/[serviceId]/mailboxes/[address]/rules
 *   GET    — the mailbox's rules
 *   POST   — create one
 *   PATCH  — update one { id, ...rule }
 *   DELETE — remove one { id }
 *
 * Rules are sieve scripts, but the customer only ever sees a form: the script
 * is generated from the rule so an invalid one cannot be saved, and a subtly
 * wrong one cannot quietly misfile their mail.
 *
 * Only scripts the panel generated are visible or editable here. A filter
 * written by hand in Mailcow is left alone rather than being rewritten by a
 * form that cannot represent it.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logAudit } from '@/lib/audit'
import {
  resolveEmailService,
  emailServiceErrorResponse,
} from '@/lib/email-service-guard'
import {
  listRules,
  createRule,
  updateRule,
  deleteRule,
  type MailRule,
} from '@/lib/mailcow-mailbox'
import { friendlyMailcowError } from '@/lib/mailcow'

const ruleSchema = z
  .object({
    name: z.string().min(1).max(80),
    field: z.enum(['from', 'to', 'subject']),
    match: z.enum(['contains', 'is']),
    value: z.string().min(1).max(255),
    action: z.enum(['fileinto', 'discard', 'markread', 'flag']),
    folder: z.string().max(120).optional(),
    stop: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (r) => r.action !== 'fileinto' || Boolean(r.folder && r.folder.trim()),
    { message: 'Choose a folder to move matching mail into' }
  )

const patchSchema = z.object({ id: z.number().int().positive() })
const deleteSchema = z.object({ id: z.number().int().positive() })

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

function toRule(body: z.infer<typeof ruleSchema>, id?: number): MailRule {
  return {
    id,
    name: body.name.trim(),
    field: body.field,
    match: body.match,
    value: body.value.trim(),
    action: body.action,
    folder: body.folder?.trim(),
    stop: body.stop ?? false,
    active: body.active ?? true,
  }
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
    return NextResponse.json({ rules: await listRules(address) })
  } catch (err) {
    const { error, status } = emailServiceErrorResponse(err)
    return NextResponse.json({ error }, { status })
  }
}

export async function POST(
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

    const body = ruleSchema.parse(await request.json())
    const result = await createRule(address, toRule(body))

    await logAudit({
      userId: auth.userId,
      action: 'email.rule.create',
      resource: 'emailService',
      resourceId: service.id,
      req: request,
      status: result.success ? 'success' : 'failure',
      metadata: { address, name: body.name, action: body.action, error: result.error },
    })

    if (!result.success) {
      return NextResponse.json(
        { error: friendlyMailcowError(result.error) },
        { status: 422 }
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

    const json = await request.json().catch(() => null)
    if (!json || typeof json !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const { id } = patchSchema.parse(json)
    const body = ruleSchema.parse(json)

    // The id comes from the client; confirm it is one of THIS mailbox's rules
    // before writing, since filter ids are global across the mail server.
    const mine = await listRules(address)
    if (!mine.some((r) => r.id === id)) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 })
    }

    const result = await updateRule(id, toRule(body, id))

    await logAudit({
      userId: auth.userId,
      action: 'email.rule.update',
      resource: 'emailService',
      resourceId: service.id,
      req: request,
      status: result.success ? 'success' : 'failure',
      metadata: { address, id, name: body.name, error: result.error },
    })

    if (!result.success) {
      return NextResponse.json(
        { error: friendlyMailcowError(result.error) },
        { status: 422 }
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
  { params }: { params: Promise<{ serviceId: string; address: string }> }
) {
  const { serviceId, address: raw } = await params
  try {
    const { service, auth, address } = await resolveMailbox(request, serviceId, raw)
    if (!address) {
      return NextResponse.json({ error: 'Mailbox not found' }, { status: 404 })
    }

    const { id } = deleteSchema.parse(await request.json())
    const result = await deleteRule(address, id)

    await logAudit({
      userId: auth.userId,
      action: 'email.rule.delete',
      resource: 'emailService',
      resourceId: service.id,
      req: request,
      status: result.success ? 'success' : 'failure',
      metadata: { address, id, error: result.error },
    })

    if (!result.success) {
      return NextResponse.json(
        { error: friendlyMailcowError(result.error) },
        { status: result.error === 'Rule not found' ? 404 : 422 }
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
