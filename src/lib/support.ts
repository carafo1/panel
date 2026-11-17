/**
 * src/lib/support.ts
 * ════════════════════════════════════════════════════════════════════════════
 * Support tickets with a live conversation.
 *
 * Customers open tickets and see only their own. Staff (admins) see every
 * ticket, reply, assign, set priority and status, and can add internal notes.
 * New messages are pushed over the realtime service:
 *   ticket:<id>       the conversation (customer + staff)
 *   ticketstaff:<id>  internal notes — staff only, so a note can never reach
 *                     the customer even through a live update
 * Room access is checked by /api/realtime/authorize using canViewTicket().
 * ════════════════════════════════════════════════════════════════════════════
 */
import crypto from 'crypto'
import { db } from '@/lib/db'
import { createNotification } from '@/lib/notifications'
import { sendEmail } from '@/lib/email'
import { getProjectAccess } from '@/lib/project-access'
import { broadcastToRoom } from '@/lib/realtime'

export const TICKET_STATUSES = ['open', 'waiting_customer', 'resolved', 'closed'] as const
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export const TICKET_CATEGORIES = ['billing', 'technical', 'domain', 'email', 'account', 'other'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

export class SupportError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 = 400
  ) {
    super(message)
    this.name = 'SupportError'
  }
}

export interface Viewer {
  userId: string
  role: string
  email?: string
}

export const isStaff = (v: Viewer) => v.role === 'admin' || v.role === 'super_admin'

function cleanText(value: unknown, label: string, min: number, max: number): string {
  const v = typeof value === 'string' ? value.trim() : ''
  if (v.length < min) throw new SupportError(min <= 1 ? `${label} is required.` : `${label} must be at least ${min} characters.`)
  if (v.length > max) throw new SupportError(`${label} is too long (${max} characters max).`)
  return v
}

async function newReference(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const ref = `T-${crypto.randomInt(10000, 999999)}`
    if (!(await db.supportTicket.findUnique({ where: { reference: ref }, select: { id: true } }))) return ref
  }
  return `T-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
}

const messageView = (m: { id: string; body: string; fromStaff: boolean; internal: boolean; createdAt: Date; author: { name: string } }) => ({
  id: m.id,
  body: m.body,
  fromStaff: m.fromStaff,
  internal: m.internal,
  createdAt: m.createdAt,
  // Customers see "Support team", not which admin answered.
  authorName: m.author.name,
})

/** May this viewer see the ticket (and join its live room)? */
export async function canViewTicket(ticketId: string, viewer: Viewer, staffRoom = false): Promise<boolean> {
  if (isStaff(viewer)) return true
  if (staffRoom) return false
  const t = await db.supportTicket.findUnique({ where: { id: ticketId }, select: { userId: true } })
  return !!t && t.userId === viewer.userId
}

async function notifyStaff(title: string, message: string, link: string, onlyUserId?: string | null) {
  const staff = onlyUserId
    ? [{ id: onlyUserId }]
    : await db.user.findMany({ where: { role: { in: ['admin', 'super_admin'] }, status: 'active' }, select: { id: true } })
  await Promise.all(staff.map((s) => createNotification({ userId: s.id, title, message, type: 'info', link }).catch(() => {})))
}

// ─── Customer + staff operations ───────────────────────────────────────────

export async function createTicket(
  viewer: Viewer,
  input: { subject?: unknown; body?: unknown; category?: unknown; priority?: unknown; projectId?: unknown }
) {
  const subject = cleanText(input.subject, 'Subject', 3, 150)
  const body = cleanText(input.body, 'Message', 1, 10000)
  const category = TICKET_CATEGORIES.includes(input.category as never) ? (input.category as string) : 'other'
  // Customers may say "high"; only staff can mark something urgent.
  const asked = TICKET_PRIORITIES.includes(input.priority as never) ? (input.priority as string) : 'normal'
  const priority = asked === 'urgent' && !isStaff(viewer) ? 'high' : asked

  let projectId: string | null = null
  if (typeof input.projectId === 'string' && input.projectId) {
    const access = await getProjectAccess({ userId: viewer.userId, role: viewer.role }, input.projectId)
    if (!access?.can('view')) throw new SupportError('That website was not found.', 404)
    projectId = input.projectId
  }

  const open = await db.supportTicket.count({ where: { userId: viewer.userId, status: { in: ['open', 'waiting_customer'] } } })
  if (open >= 20) throw new SupportError('You have 20 open tickets. Please wait for those to be answered or close some first.')

  const ticket = await db.supportTicket.create({
    data: {
      reference: await newReference(),
      userId: viewer.userId,
      subject,
      category,
      priority,
      projectId,
      lastReplyBy: 'customer',
      messages: { create: { authorId: viewer.userId, body, fromStaff: false } },
    },
    select: { id: true, reference: true },
  })

  await notifyStaff(`New support ticket ${ticket.reference}`, subject, `/?tab=admin&ticket=${ticket.id}`)
  return ticket
}

export async function listTickets(viewer: Viewer, opts: { all?: boolean; status?: string; q?: string } = {}) {
  const staffView = opts.all && isStaff(viewer)
  const where: Record<string, unknown> = staffView ? {} : { userId: viewer.userId }
  if (opts.status && opts.status !== 'all') {
    where.status = opts.status === 'active' ? { in: ['open', 'waiting_customer'] } : opts.status
  }
  if (staffView && opts.q?.trim()) {
    const q = opts.q.trim()
    where.OR = [{ reference: { contains: q } }, { subject: { contains: q } }, { user: { email: { contains: q } } }]
  }
  const rows = await db.supportTicket.findMany({
    where,
    orderBy: [{ lastMessageAt: 'desc' }],
    take: 200,
    select: {
      id: true, reference: true, subject: true, status: true, priority: true, category: true,
      lastMessageAt: true, lastReplyBy: true, createdAt: true,
      user: { select: { email: true, name: true } },
      assignedTo: { select: { id: true, name: true } },
      _count: { select: { messages: true } },
    },
  })
  return rows.map((r) => ({
    ...r,
    // What the viewer should do next.
    needsAttention: staffView ? r.lastReplyBy === 'customer' && r.status === 'open' : r.status === 'waiting_customer',
    user: staffView ? r.user : undefined,
    assignedTo: staffView ? r.assignedTo : undefined,
  }))
}

export async function getTicket(ticketId: string, viewer: Viewer) {
  const t = await db.supportTicket.findUnique({
    where: { id: ticketId },
    include: {
      user: { select: { id: true, email: true, name: true } },
      assignedTo: { select: { id: true, name: true } },
      messages: { orderBy: { createdAt: 'asc' }, include: { author: { select: { name: true } } } },
    },
  })
  if (!t || (!isStaff(viewer) && t.userId !== viewer.userId)) throw new SupportError('Ticket not found', 404)
  const staff = isStaff(viewer)
  return {
    id: t.id,
    reference: t.reference,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    category: t.category,
    projectId: t.projectId,
    createdAt: t.createdAt,
    closedAt: t.closedAt,
    customer: staff ? t.user : undefined,
    assignedTo: staff ? t.assignedTo : undefined,
    messages: t.messages
      .filter((m) => staff || !m.internal)
      .map((m) => {
        const v = messageView(m)
        return staff ? v : { ...v, authorName: m.fromStaff ? 'Support team' : v.authorName }
      }),
  }
}

export async function addMessage(ticketId: string, viewer: Viewer, input: { body?: unknown; internal?: unknown }) {
  const body = cleanText(input.body, 'Message', 1, 10000)
  const staff = isStaff(viewer)
  const internal = staff && input.internal === true
  const t = await db.supportTicket.findUnique({
    where: { id: ticketId },
    select: { id: true, userId: true, status: true, reference: true, subject: true, assignedToId: true, user: { select: { email: true, name: true } } },
  })
  if (!t || (!staff && t.userId !== viewer.userId)) throw new SupportError('Ticket not found', 404)
  if (t.status === 'closed' && !staff) throw new SupportError('This ticket is closed. Open a new ticket if you still need help.')

  const msg = await db.supportMessage.create({
    data: { ticketId, authorId: viewer.userId, body, fromStaff: staff, internal },
    include: { author: { select: { name: true } } },
  })

  if (!internal) {
    await db.supportTicket.update({
      where: { id: ticketId },
      data: {
        lastMessageAt: new Date(),
        lastReplyBy: staff ? 'staff' : 'customer',
        // A staff answer waits on the customer; a customer reply reopens it.
        status: staff ? (t.status === 'closed' ? 'closed' : 'waiting_customer') : 'open',
        closedAt: staff ? undefined : null,
      },
    })
  }

  const view = messageView(msg)
  if (internal) {
    await broadcastToRoom(`ticketstaff:${ticketId}`, 'ticket:message', view)
  } else {
    await broadcastToRoom(`ticket:${ticketId}`, 'ticket:message', { ...view, authorName: staff ? 'Support team' : view.authorName })
    await broadcastToRoom(`ticketstaff:${ticketId}`, 'ticket:message', view)
  }

  if (staff && !internal) {
    await createNotification({
      userId: t.userId,
      title: `Support replied to ${t.reference}`,
      message: t.subject,
      type: 'info',
      link: `/?tab=support&ticket=${ticketId}`,
    }).catch(() => {})
    const safe = body.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)
    await sendEmail({
      to: t.user.email,
      subject: `[${t.reference}] ${t.subject}`,
      html: `<p>Hello ${t.user.name.replace(/[<>&]/g, '')},</p><p>Our support team replied to your ticket:</p><blockquote style="border-left:3px solid #6366f1;padding-left:12px;white-space:pre-wrap">${safe}</blockquote><p>Reply from the Support section of your panel.</p>`,
    }).catch(() => {})
  } else if (!staff) {
    await notifyStaff(`Customer replied to ${t.reference}`, t.subject, `/?tab=admin&ticket=${ticketId}`, t.assignedToId)
  }
  return view
}

export async function updateTicket(
  ticketId: string,
  viewer: Viewer,
  input: { status?: unknown; priority?: unknown; category?: unknown; assignedToId?: unknown }
) {
  const staff = isStaff(viewer)
  const t = await db.supportTicket.findUnique({ where: { id: ticketId }, select: { userId: true, status: true } })
  if (!t || (!staff && t.userId !== viewer.userId)) throw new SupportError('Ticket not found', 404)

  const data: Record<string, unknown> = {}
  if (input.status !== undefined) {
    if (!TICKET_STATUSES.includes(input.status as never)) throw new SupportError('Unknown status.')
    // Customers can close, mark resolved, or reopen — not set "waiting on customer".
    if (!staff && input.status === 'waiting_customer') throw new SupportError('Not allowed.', 403)
    data.status = input.status
    data.closedAt = input.status === 'closed' || input.status === 'resolved' ? new Date() : null
  }
  if (input.priority !== undefined || input.category !== undefined || input.assignedToId !== undefined) {
    if (!staff) throw new SupportError('Only the support team can change that.', 403)
    if (input.priority !== undefined) {
      if (!TICKET_PRIORITIES.includes(input.priority as never)) throw new SupportError('Unknown priority.')
      data.priority = input.priority
    }
    if (input.category !== undefined) {
      if (!TICKET_CATEGORIES.includes(input.category as never)) throw new SupportError('Unknown category.')
      data.category = input.category
    }
    if (input.assignedToId !== undefined) {
      if (input.assignedToId === null || input.assignedToId === '') data.assignedToId = null
      else {
        const a = await db.user.findUnique({ where: { id: String(input.assignedToId) }, select: { role: true } })
        if (!a || (a.role !== 'admin' && a.role !== 'super_admin')) throw new SupportError('Tickets can only be assigned to staff.')
        data.assignedToId = String(input.assignedToId)
      }
    }
  }
  await db.supportTicket.update({ where: { id: ticketId }, data })
  await broadcastToRoom(`ticket:${ticketId}`, 'ticket:updated', { status: data.status })
  await broadcastToRoom(`ticketstaff:${ticketId}`, 'ticket:updated', data)
  return { ok: true }
}

/** Staff members a ticket can be assigned to. */
export async function listStaff() {
  return db.user.findMany({
    where: { role: { in: ['admin', 'super_admin'] }, status: 'active' },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
  })
}
