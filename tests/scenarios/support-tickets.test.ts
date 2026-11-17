/**
 * Support tickets: who can see what, internal notes, status transitions and
 * the live-update rooms.
 */
import { describe, it, expect } from 'bun:test'
import { db } from '@/lib/db'
import * as tickets from '@/app/api/support/tickets/route'
import * as ticket from '@/app/api/support/tickets/[id]/route'
import * as messages from '@/app/api/support/tickets/[id]/messages/route'
import * as staffRoute from '@/app/api/support/staff/route'
import * as authorize from '@/app/api/realtime/authorize/route'
import { makeUser, makeProject, authed, params } from './helpers'

let ip = 0
const req = (token: string, path: string, init: RequestInit = {}) =>
  authed(token, path, { ...init, headers: { 'x-forwarded-for': `10.77.${++ip & 255}.${(ip >> 8) & 255}` } })

async function open(token: string, body: Record<string, unknown> = {}) {
  const res = await tickets.POST(
    req(token, '/api/support/tickets', { method: 'POST', body: JSON.stringify({ subject: 'Site is down', body: 'It shows 502', category: 'technical', ...body }) })
  )
  return { status: res.status, data: await res.json() }
}
const get = async (token: string, id: string) => {
  const res = await ticket.GET(req(token, `/api/support/tickets/${id}`), params({ id }))
  return { status: res.status, data: await res.json() }
}
const reply = async (token: string, id: string, body: string, internal = false) =>
  messages.POST(req(token, `/api/support/tickets/${id}/messages`, { method: 'POST', body: JSON.stringify({ body, internal }) }), params({ id }))
const patch = (token: string, id: string, data: Record<string, unknown>) =>
  ticket.PATCH(req(token, `/api/support/tickets/${id}`, { method: 'PATCH', body: JSON.stringify(data) }), params({ id }))
const canJoin = async (token: string, room: string) =>
  (await authorize.POST(authed(token, '/api/realtime/authorize', { method: 'POST', body: JSON.stringify({ room }) }))).status === 200

describe('support tickets', () => {
  it('a customer opens a ticket and only they and staff can read it', async () => {
    const alice = await makeUser('t-alice')
    const bob = await makeUser('t-bob')
    const admin = await makeUser('t-admin', 'admin')

    const created = await open(alice.token)
    expect(created.status).toBe(201)
    expect(created.data.ticket.reference).toMatch(/^[A-Z0-9-]+$/)
    const id = created.data.ticket.id

    expect((await get(alice.token, id)).status).toBe(200)
    expect((await get(admin.token, id)).status).toBe(200)
    expect((await get(bob.token, id)).status).toBe(404)
    expect((await reply(bob.token, id, 'let me in')).status).toBe(404)

    // Bob's own list doesn't include it; staff ?all=1 does; a customer's ?all=1 is ignored.
    const bobList = await (await tickets.GET(req(bob.token, '/api/support/tickets?all=1'))).json()
    expect(bobList.tickets.some((t: { id: string }) => t.id === id)).toBe(false)
    const staffList = await (await tickets.GET(req(admin.token, '/api/support/tickets?all=1'))).json()
    expect(staffList.tickets.some((t: { id: string }) => t.id === id)).toBe(true)
  })

  it('validates input and refuses a website the customer cannot see', async () => {
    const c = await makeUser('t-val')
    const other = await makeUser('t-val-other')
    const theirs = await makeProject(other.id)
    expect((await open(c.token, { subject: 'x' })).status).toBe(400)
    expect((await open(c.token, { body: '' })).status).toBe(400)
    expect((await open(c.token, { projectId: theirs.id })).status).toBe(404)
    const mine = await makeProject(c.id)
    expect((await open(c.token, { projectId: mine.id })).status).toBe(201)
  })

  it('customers cannot mark a ticket urgent', async () => {
    const c = await makeUser('t-urgent')
    const { data } = await open(c.token, { priority: 'urgent' })
    const t = await db.supportTicket.findUnique({ where: { id: data.ticket.id } })
    expect(t?.priority).toBe('high')
  })

  it('internal notes are hidden from the customer and staff names are not exposed', async () => {
    const c = await makeUser('t-notes')
    const admin = await makeUser('t-notes-admin', 'admin')
    const { data } = await open(c.token)
    const id = data.ticket.id

    expect((await reply(admin.token, id, 'customer is on the old plan', true)).status).toBe(201)
    expect((await reply(admin.token, id, 'We restarted your site.')).status).toBe(201)
    // A customer asking for an internal note just gets a normal message.
    expect((await reply(c.token, id, 'thanks', true)).status).toBe(201)

    const seenByCustomer = (await get(c.token, id)).data.ticket
    const bodies = seenByCustomer.messages.map((m: { body: string }) => m.body)
    expect(bodies).not.toContain('customer is on the old plan')
    expect(bodies).toContain('We restarted your site.')
    const staffMsg = seenByCustomer.messages.find((m: { body: string }) => m.body === 'We restarted your site.')
    expect(staffMsg.authorName).toBe('Support team')
    expect(seenByCustomer.messages.find((m: { body: string }) => m.body === 'thanks').internal).toBe(false)

    const seenByStaff = (await get(admin.token, id)).data.ticket
    expect(seenByStaff.messages.map((m: { body: string }) => m.body)).toContain('customer is on the old plan')
  })

  it('status follows the conversation and customers can only resolve, close or reopen', async () => {
    const c = await makeUser('t-status')
    const admin = await makeUser('t-status-admin', 'admin')
    const { data } = await open(c.token)
    const id = data.ticket.id
    const status = async () => (await db.supportTicket.findUnique({ where: { id } }))!.status

    await reply(admin.token, id, 'Can you send a screenshot?')
    expect(await status()).toBe('waiting_customer')
    await reply(c.token, id, 'here it is')
    expect(await status()).toBe('open')

    // An internal note doesn't put the ticket back on the customer.
    await reply(admin.token, id, 'checking logs', true)
    expect(await status()).toBe('open')

    expect((await patch(c.token, id, { status: 'waiting_customer' })).status).toBe(403)
    expect((await patch(c.token, id, { priority: 'urgent' })).status).toBeGreaterThanOrEqual(400)
    expect((await patch(c.token, id, { status: 'resolved' })).status).toBe(200)
    expect(await status()).toBe('resolved')
    expect((await patch(c.token, id, { status: 'open' })).status).toBe(200)
    expect((await patch(c.token, id, { status: 'closed' })).status).toBe(200)
    // Closed: the customer can't keep replying.
    expect((await reply(c.token, id, 'one more thing')).status).toBe(400)
  })

  it('staff can assign only to staff; the staff list is staff-only', async () => {
    const c = await makeUser('t-assign')
    const admin = await makeUser('t-assign-admin', 'admin')
    const { data } = await open(c.token)
    const id = data.ticket.id

    expect((await staffRoute.GET(req(c.token, '/api/support/staff'))).status).toBe(403)
    const staff = await (await staffRoute.GET(req(admin.token, '/api/support/staff'))).json()
    expect(staff.staff.some((s: { id: string }) => s.id === admin.id)).toBe(true)

    expect((await patch(admin.token, id, { assignedToId: c.id })).status).toBe(400)
    expect((await patch(admin.token, id, { assignedToId: admin.id, priority: 'urgent' })).status).toBe(200)
    const t = await db.supportTicket.findUnique({ where: { id } })
    expect(t?.assignedToId).toBe(admin.id)
    expect(t?.priority).toBe('urgent')
  })

  it('live-update rooms: the customer joins ticket:<id>, only staff join ticketstaff:<id>', async () => {
    const c = await makeUser('t-room')
    const stranger = await makeUser('t-room-x')
    const admin = await makeUser('t-room-admin', 'admin')
    const { data } = await open(c.token)
    const id = data.ticket.id

    expect(await canJoin(c.token, `ticket:${id}`)).toBe(true)
    expect(await canJoin(c.token, `ticketstaff:${id}`)).toBe(false)
    expect(await canJoin(stranger.token, `ticket:${id}`)).toBe(false)
    expect(await canJoin(admin.token, `ticketstaff:${id}`)).toBe(true)
    expect(await canJoin(admin.token, `ticket:${id}`)).toBe(true)
  })

  it('a customer replying is told when staff answered (notification)', async () => {
    const c = await makeUser('t-notify')
    const admin = await makeUser('t-notify-admin', 'admin')
    const { data } = await open(c.token)
    await reply(admin.token, data.ticket.id, 'Fixed it.')
    const n = await db.notification.findFirst({ where: { userId: c.id }, orderBy: { createdAt: 'desc' } })
    expect(n?.link).toBe(`/?tab=support&ticket=${data.ticket.id}`)
  })
})
