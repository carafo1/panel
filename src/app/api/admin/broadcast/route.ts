/**
 * POST /api/admin/broadcast
 *
 * Tell customers something — planned maintenance, an incident, a price change.
 * There was no way to reach them at all: notifications were only ever raised
 * by automated events, so an operator with news had to email people by hand
 * out of the database.
 *
 * **Preview by default.** A call without `confirm: true` sends nothing and
 * returns who WOULD be reached, with a sample. Broadcasting is irreversible
 * and outward-facing — an operator who mis-picks the audience cannot unsend
 * it — so the destructive step is opt-in rather than the default.
 *
 * In-app notifications are the primary channel and always written. Email is
 * opt-in per broadcast, because most announcements do not warrant landing in
 * everyone's inbox, and a mail server that suddenly emits hundreds of
 * identical messages is how a sending domain gets a reputation problem.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAdminRole } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { createNotification } from '@/lib/notifications'
import { sendEmail } from '@/lib/email'

const schema = z.object({
  title: z.string().min(3).max(120),
  message: z.string().min(3).max(4000),
  type: z.enum(['info', 'success', 'warning', 'error']).default('info'),
  audience: z
    .enum(['all', 'active', 'suspended', 'with-hosting', 'with-email', 'paying'])
    .default('active'),
  /** Also send it as an email, not just an in-app notification. */
  sendEmail: z.boolean().default(false),
  /** Must be true to actually send. Absent = preview only. */
  confirm: z.boolean().default(false),
})

type Audience = z.infer<typeof schema>['audience']

/** Resolve an audience to real recipients. */
async function resolveRecipients(audience: Audience) {
  const select = { id: true, email: true, name: true, status: true }

  switch (audience) {
    case 'all':
      return db.user.findMany({ select })
    case 'suspended':
      return db.user.findMany({
        where: { status: { in: ['suspended', 'fraud'] } },
        select,
      })
    case 'with-hosting':
      return db.user.findMany({
        where: { status: 'active', projects: { some: {} } },
        select,
      })
    case 'with-email':
      return db.user.findMany({
        where: { status: 'active', emailServices: { some: {} } },
        select,
      })
    case 'paying':
      return db.user.findMany({
        where: {
          status: 'active',
          subscriptions: { some: { status: { in: ['active', 'trialing'] } } },
        },
        select,
      })
    case 'active':
    default:
      // The sane default: people who can actually log in and read it.
      return db.user.findMany({ where: { status: 'active' }, select })
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdminRole(request)
    if (!auth) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const body = schema.parse(await request.json())
    const recipients = await resolveRecipients(body.audience)

    if (recipients.length === 0) {
      return NextResponse.json(
        { error: 'That audience matches nobody.', audience: body.audience },
        { status: 400 }
      )
    }

    // ── Preview ──
    if (!body.confirm) {
      return NextResponse.json({
        preview: true,
        audience: body.audience,
        recipientCount: recipients.length,
        willEmail: body.sendEmail,
        sample: recipients.slice(0, 5).map((r) => r.email),
        message:
          `This will notify ${recipients.length} customer(s)` +
          (body.sendEmail ? ' and email them.' : ' in the panel only.') +
          ' Send again with confirm: true to go ahead — it cannot be undone.',
      })
    }

    // ── Send ──
    let notified = 0
    let emailed = 0
    const failures: string[] = []

    for (const r of recipients) {
      try {
        await createNotification({
          userId: r.id,
          title: body.title,
          message: body.message,
          type: body.type,
        })
        notified++
      } catch {
        failures.push(`notify ${r.email}`)
      }

      if (body.sendEmail && r.email) {
        try {
          await sendEmail({
            to: r.email,
            subject: body.title,
            html: `<p>Hi ${r.name || 'there'},</p><p>${body.message
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/\n/g, '<br>')}</p><p>— Apsamo Technology</p>`,
          })
          emailed++
        } catch {
          failures.push(`email ${r.email}`)
        }
      }
    }

    await logAudit({
      userId: auth.userId,
      action: 'admin.broadcast',
      resource: 'user',
      resourceId: 'broadcast',
      req: request,
      status: failures.length ? 'failure' : 'success',
      metadata: {
        title: body.title,
        audience: body.audience,
        recipients: recipients.length,
        notified,
        emailed,
        failures: failures.slice(0, 20),
      },
    }).catch(() => {})

    return NextResponse.json({
      sent: true,
      recipientCount: recipients.length,
      notified,
      emailed,
      failed: failures.length,
      message:
        `Notified ${notified} customer(s)` +
        (body.sendEmail ? `, emailed ${emailed}` : '') +
        (failures.length ? `. ${failures.length} failed — see the audit log.` : '.'),
    })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: err.issues[0]?.message || 'Invalid request' },
        { status: 400 }
      )
    }
    console.error('Broadcast error:', err)
    return NextResponse.json({ error: 'Broadcast failed' }, { status: 500 })
  }
}
