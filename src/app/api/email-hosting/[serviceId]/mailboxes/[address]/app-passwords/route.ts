/**
 * /api/email-hosting/[serviceId]/mailboxes/[address]/app-passwords
 *   GET    — list (never returns the passwords themselves; Mailcow stores hashes)
 *   POST   — create { name, password }
 *   DELETE — remove { id }
 *
 * App passwords let a phone or mail client sign in without the account
 * password, and can be revoked individually. The plaintext is shown to the
 * customer once, by the caller, and is never persisted here.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logAudit } from '@/lib/audit'
import {
  resolveEmailService,
  emailServiceErrorResponse,
} from '@/lib/email-service-guard'
import {
  listAppPasswords,
  createAppPassword,
  deleteAppPassword,
} from '@/lib/mailcow-mailbox'

const createSchema = z.object({
  name: z.string().min(1).max(60),
  password: z.string().min(12).max(128),
})

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
    return NextResponse.json({ appPasswords: await listAppPasswords(address) })
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

    const body = createSchema.parse(await request.json())
    const result = await createAppPassword({
      mailbox: address,
      name: body.name,
      password: body.password,
    })

    await logAudit({
      userId: auth.userId,
      action: 'email.apppassword.create',
      resource: 'emailService',
      resourceId: service.id,
      req: request,
      status: result.success ? 'success' : 'failure',
      // The name only — never the password.
      metadata: { address, name: body.name, error: result.error },
    })

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 422 })
    }
    return NextResponse.json({ ok: true, name: body.name })
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

    const body = deleteSchema.parse(await request.json())

    // The id comes from the client, so confirm it is one of THIS mailbox's
    // passwords before deleting — ids are global across the mail server.
    const owned = await listAppPasswords(address)
    if (!owned.some((p) => p.id === body.id)) {
      return NextResponse.json({ error: 'App password not found' }, { status: 404 })
    }

    const result = await deleteAppPassword(body.id)

    await logAudit({
      userId: auth.userId,
      action: 'email.apppassword.delete',
      resource: 'emailService',
      resourceId: service.id,
      req: request,
      status: result.success ? 'success' : 'failure',
      metadata: { address, id: body.id, error: result.error },
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
    const { error, status } = emailServiceErrorResponse(err)
    return NextResponse.json({ error }, { status })
  }
}
