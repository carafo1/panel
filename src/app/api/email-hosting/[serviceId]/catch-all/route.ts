/**
 * /api/email-hosting/[serviceId]/catch-all
 *   GET — where unmatched mail currently goes, if anywhere
 *   PUT — set it { destination } or clear it { destination: null }
 *
 * A catch-all is an alias at `@domain`. It is kept out of the alias list and
 * given its own route because it behaves differently: there is at most one, and
 * turning it on means accepting mail for every address that does not exist —
 * which is why spam volume usually rises sharply afterwards.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logAudit } from '@/lib/audit'
import {
  resolveEmailService,
  emailServiceErrorResponse,
} from '@/lib/email-service-guard'
import { listAliases, setCatchAll } from '@/lib/mailcow-manage'

const saveSchema = z.object({
  destination: z
    .string()
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter an email address')
    .nullable(),
})

export async function GET(
  request: Request,
  { params }: { params: Promise<{ serviceId: string }> }
) {
  const { serviceId } = await params
  try {
    const { domains } = await resolveEmailService(request, serviceId)
    const all = await listAliases(domains)
    const catchAll = all.find((a) => a.isCatchAll) || null
    return NextResponse.json({
      catchAll: catchAll
        ? {
            id: catchAll.id,
            destinations: catchAll.destinations,
            active: catchAll.active,
          }
        : null,
    })
  } catch (err) {
    const { error, status } = emailServiceErrorResponse(err)
    return NextResponse.json({ error }, { status })
  }
}

export async function PUT(
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

    const body = saveSchema.parse(await request.json())
    const result = await setCatchAll(service.domain, body.destination, domains)

    await logAudit({
      userId: auth.userId,
      action: body.destination ? 'email.catchall.set' : 'email.catchall.clear',
      resource: 'emailService',
      resourceId: service.id,
      req: request,
      status: result.success ? 'success' : 'failure',
      metadata: { domain: service.domain, destination: body.destination, error: result.error },
    })

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 422 })
    }
    return NextResponse.json({ ok: true, destination: body.destination })
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
