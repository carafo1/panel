/**
 * POST /api/admin/email/[serviceId]
 *
 * Operator actions on one email service:
 *   suspend | resume | terminate | set-plan | set-addons
 *
 * `terminate` destroys every mailbox and all stored mail, so it requires the
 * caller to echo the domain back — the same confirmation the customer-facing
 * delete uses, applied to a far more destructive action.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAdminRole } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import {
  suspendEmailService,
  resumeEmailService,
  terminateEmailService,
  applyPlanToService,
  syncMailcowLimits,
} from '@/lib/email-hosting'
import { createNotification } from '@/lib/notifications'

const bodySchema = z.object({
  action: z.enum(['suspend', 'resume', 'terminate', 'set-plan', 'set-addons']),
  planId: z.string().optional(),
  extraMailboxes: z.number().int().min(0).max(500).optional(),
  extraStorageGB: z.number().int().min(0).max(10_000).optional(),
  /** Must equal the domain for `terminate`. */
  confirm: z.string().optional(),
  reason: z.string().max(500).optional(),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ serviceId: string }> }
) {
  const { serviceId } = await params
  // Role is re-read from the database rather than trusted from the token, and
  // suspended/closed accounts are rejected.
  const decoded = await requireAdminRole(request)
  if (!decoded) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await request.json())
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof z.ZodError
            ? err.issues[0]?.message || 'Invalid request'
            : 'Invalid request',
      },
      { status: 400 }
    )
  }

  const service = await db.emailService.findUnique({ where: { id: serviceId } })
  if (!service) {
    return NextResponse.json({ error: 'Service not found' }, { status: 404 })
  }

  let result: { success: boolean; error?: string } = { success: false }
  let note = ''

  switch (body.action) {
    case 'suspend':
      result = await suspendEmailService(serviceId)
      note = 'suspended'
      if (result.success) {
        await createNotification({
          userId: service.userId,
          title: 'Email hosting suspended',
          message: `Mail for ${service.domain} has been suspended.${body.reason ? ` Reason: ${body.reason}` : ''} Your mailboxes and messages are not deleted.`,
          type: 'error',
          link: '/?tab=email',
        }).catch(() => {})
      }
      break

    case 'resume':
      result = await resumeEmailService(serviceId)
      note = 'resumed'
      if (result.success) {
        await createNotification({
          userId: service.userId,
          title: 'Email hosting restored',
          message: `Mail for ${service.domain} is active again.`,
          type: 'success',
          link: '/?tab=email',
        }).catch(() => {})
      }
      break

    case 'terminate':
      if ((body.confirm || '').toLowerCase().trim() !== service.domain.toLowerCase()) {
        return NextResponse.json(
          {
            error: `Type the domain (${service.domain}) to confirm — this deletes every mailbox and all stored mail.`,
          },
          { status: 400 }
        )
      }
      result = await terminateEmailService(serviceId)
      note = 'terminated'
      break

    case 'set-plan': {
      if (!body.planId) {
        return NextResponse.json({ error: 'planId is required' }, { status: 400 })
      }
      result = await applyPlanToService(serviceId, body.planId)
      note = 'plan changed'
      break
    }

    case 'set-addons': {
      const updated = await db.emailService.update({
        where: { id: serviceId },
        data: {
          ...(body.extraMailboxes !== undefined
            ? { extraMailboxes: body.extraMailboxes }
            : {}),
          ...(body.extraStorageGB !== undefined
            ? { extraStorageGB: body.extraStorageGB }
            : {}),
        },
      })
      // The allowance only becomes real once Mailcow's ceiling matches.
      result = await syncMailcowLimits(updated)
      note = 'add-ons changed'
      break
    }
  }

  await logAudit({
    userId: decoded.userId,
    action: `admin.email.${body.action}`,
    resource: 'emailService',
    resourceId: serviceId,
    req: request,
    status: result.success ? 'success' : 'failure',
    metadata: {
      domain: service.domain,
      owner: service.userId,
      reason: body.reason,
      planId: body.planId,
      extraMailboxes: body.extraMailboxes,
      extraStorageGB: body.extraStorageGB,
      error: result.error,
    },
  })

  if (!result.success) {
    return NextResponse.json(
      { error: result.error || `Could not complete ${body.action}` },
      { status: 422 }
    )
  }

  const fresh = await db.emailService.findUnique({ where: { id: serviceId } })
  return NextResponse.json({ ok: true, note, status: fresh?.status })
}
