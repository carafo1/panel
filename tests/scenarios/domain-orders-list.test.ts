/**
 * GET /api/domains/orders — the customer's own domain order list.
 *
 *   - auth required (401 without / with a bad token)
 *   - ownership isolation: user B never sees user A's orders, and cannot page
 *     with A's order id as a cursor
 *   - newest first, paginated, limit capped at 50
 *   - only allow-listed fields: no EPP code, registrar errors, registrar
 *     order ids, registrant data or wholesale/unit prices
 *   - awaiting-payment orders expose the invoice and a usable pay link
 *
 * Rows are written straight to the scenario database. Nothing here calls the
 * registrar or a payment gateway.
 */
import { describe, it, expect } from 'bun:test'
import { db } from '@/lib/db'
import { encrypt } from '@/lib/encryption'
import { GET } from '@/app/api/domains/orders/route'
import { makeUser, authed, uid } from './helpers'

const SECRET_EPP = 'EPP-SECRET-9f8e7d'
const REGISTRAR_ERROR = 'Dynadot API error: insufficient account balance (code 213)'

// Each request gets its own client IP so the per-IP rate limiter never trips
// across tests in this file.
let ipSeq = 0
function get(token: string | null, query = '') {
  ipSeq++
  return GET(
    authed(token, `/api/domains/orders${query}`, {
      headers: { 'x-forwarded-for': `10.77.${Math.floor(ipSeq / 250)}.${ipSeq % 250}` },
    })
  )
}

async function makeOrder(
  userId: string,
  extra: Record<string, unknown> = {},
  createdAt?: Date
) {
  return db.domainOrder.create({
    data: {
      userId,
      domainName: `${uid('ord')}.com`,
      type: 'register',
      duration: 1,
      status: 'pending_payment',
      unitPrice: 16.5,
      totalAmount: 16.5,
      currency: 'USD',
      provider: 'dynadot',
      ...(createdAt ? { createdAt } : {}),
      ...extra,
    },
  })
}

async function makeInvoice(userId: string, orderId: string, extra: Record<string, unknown> = {}) {
  return db.invoice.create({
    data: {
      number: uid('INV'),
      userId,
      orderId,
      items: '[]',
      subtotal: 16.5,
      total: 16.5,
      currency: 'USD',
      status: 'pending',
      ...extra,
    },
  })
}

describe('GET /api/domains/orders', () => {
  it('requires authentication', async () => {
    const none = await get(null)
    expect(none.status).toBe(401)
    const bad = await get('not-a-real-token')
    expect(bad.status).toBe(401)
  })

  it('returns only the caller’s own orders', async () => {
    const a = await makeUser('orders-a')
    const b = await makeUser('orders-b')
    const aOrder = await makeOrder(a.id)
    const bOrder = await makeOrder(b.id)

    const resB = await get(b.token)
    expect(resB.status).toBe(200)
    const bodyB = await resB.json()
    const idsB = bodyB.orders.map((o: { id: string }) => o.id)
    expect(idsB).toEqual([bOrder.id])
    expect(idsB).not.toContain(aOrder.id)

    const resA = await get(a.token)
    const idsA = (await resA.json()).orders.map((o: { id: string }) => o.id)
    expect(idsA).toEqual([aOrder.id])
  })

  it('refuses another user’s order id as a cursor', async () => {
    const a = await makeUser('orders-cur-a')
    const b = await makeUser('orders-cur-b')
    const aOrder = await makeOrder(a.id)
    await makeOrder(b.id)

    const res = await get(b.token, `?cursor=${aOrder.id}`)
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).not.toContain(aOrder.domainName)
  })

  it('does not admit admins to other customers’ orders', async () => {
    const admin = await makeUser('orders-admin', 'admin')
    const customer = await makeUser('orders-cust')
    const order = await makeOrder(customer.id)
    const res = await get(admin.token)
    expect(res.status).toBe(200)
    const ids = (await res.json()).orders.map((o: { id: string }) => o.id)
    expect(ids).not.toContain(order.id)
  })

  it('lists newest first and paginates with a cursor', async () => {
    const u = await makeUser('orders-page')
    const base = Date.now() - 10 * 60_000
    const created = []
    for (let i = 0; i < 5; i++) {
      created.push(await makeOrder(u.id, {}, new Date(base + i * 1000)))
    }
    const newestFirst = [...created].reverse().map((o) => o.id)

    const all = await (await get(u.token)).json()
    expect(all.orders.map((o: { id: string }) => o.id)).toEqual(newestFirst)
    expect(all.nextCursor).toBeNull()

    const p1 = await (await get(u.token, '?limit=2')).json()
    expect(p1.orders.map((o: { id: string }) => o.id)).toEqual(newestFirst.slice(0, 2))
    expect(p1.nextCursor).toBe(newestFirst[1])

    const p2 = await (await get(u.token, `?limit=2&cursor=${p1.nextCursor}`)).json()
    expect(p2.orders.map((o: { id: string }) => o.id)).toEqual(newestFirst.slice(2, 4))

    const p3 = await (await get(u.token, `?limit=2&cursor=${p2.nextCursor}`)).json()
    expect(p3.orders.map((o: { id: string }) => o.id)).toEqual(newestFirst.slice(4))
    expect(p3.nextCursor).toBeNull()
  })

  it('caps the page size at 50', async () => {
    const u = await makeUser('orders-cap')
    const base = Date.now() - 60 * 60_000
    await db.domainOrder.createMany({
      data: Array.from({ length: 55 }, (_, i) => ({
        userId: u.id,
        domainName: `${uid('cap')}.com`,
        type: 'register',
        duration: 1,
        status: 'completed',
        unitPrice: 10,
        totalAmount: 10,
        createdAt: new Date(base + i * 1000),
      })),
    })
    const body = await (await get(u.token, '?limit=500')).json()
    expect(body.orders).toHaveLength(50)
    expect(body.nextCursor).toBeTruthy()
  })

  it('exposes only customer-safe fields', async () => {
    const u = await makeUser('orders-safe')
    const transfer = await makeOrder(u.id, {
      type: 'transfer',
      duration: 1,
      status: 'manual_review',
      providerOrderId: 'DYN-ORDER-424242',
      registrarCalledAt: new Date(),
      metadata: JSON.stringify({
        authCode: SECRET_EPP,
        authCodeEnc: encrypt(SECRET_EPP),
        registrant: { firstName: 'Private', lastName: 'Person', email: 'private@example.test' },
        manualReviewReason: REGISTRAR_ERROR,
        fulfilmentError: REGISTRAR_ERROR,
        wholesale: 9.99,
      }),
    })
    const failed = await makeOrder(u.id, {
      status: 'failed',
      metadata: JSON.stringify({ fulfilmentError: REGISTRAR_ERROR }),
    })

    const res = await get(u.token)
    expect(res.status).toBe(200)
    const raw = await res.text()
    for (const leak of [
      SECRET_EPP,
      'authCode',
      REGISTRAR_ERROR,
      'Dynadot',
      'DYN-ORDER-424242',
      'providerOrderId',
      'registrarCalledAt',
      'private@example.test',
      'registrant',
      'metadata',
      'wholesale',
      'unitPrice',
      'dynadot',
    ]) {
      expect(raw).not.toContain(leak)
    }

    const body = JSON.parse(raw)
    const byId = new Map(body.orders.map((o: { id: string }) => [o.id, o]))
    const t = byId.get(transfer.id) as Record<string, unknown>
    expect(Object.keys(t).sort()).toEqual(
      [
        'id', 'domainName', 'kind', 'years', 'status', 'amount', 'currency',
        'invoiceId', 'invoiceNumber', 'invoicePaid', 'domainId', 'domainActive',
        'payment', 'message', 'createdAt', 'updatedAt',
      ].sort()
    )
    expect(t.kind).toBe('transfer')
    expect(t.status).toBe('manual_review')
    expect(t.message).toMatch(/our team/i)

    const f = byId.get(failed.id) as Record<string, unknown>
    expect(f.message).toMatch(/could not be completed/i)
  })

  it('links the invoice and pay link for an order awaiting payment', async () => {
    const u = await makeUser('orders-pay')
    const order = await makeOrder(u.id, { totalAmount: 33, duration: 2 })
    const invoice = await makeInvoice(u.id, order.id, { total: 33, subtotal: 33 })
    const payment = await db.payment.create({
      data: {
        userId: u.id,
        amount: 33,
        currency: 'usd',
        status: 'pending',
        type: 'domain',
        method: 'stripe',
        metadata: JSON.stringify({ redirectUrl: 'https://checkout.stripe.com/c/pay/cs_test_123' }),
      },
    })
    await db.domainOrder.update({
      where: { id: order.id },
      data: { metadata: JSON.stringify({ paymentId: payment.id, invoiceId: invoice.id }) },
    })

    const body = await (await get(u.token)).json()
    const o = body.orders[0]
    expect(o.id).toBe(order.id)
    expect(o.years).toBe(2)
    expect(o.amount).toBe(33)
    expect(o.invoiceId).toBe(invoice.id)
    expect(o.invoiceNumber).toBe(invoice.number)
    expect(o.invoicePaid).toBe(false)
    expect(o.payment).toEqual({
      method: 'stripe',
      payUrl: 'https://checkout.stripe.com/c/pay/cs_test_123',
      reference: null,
      instructions: null,
    })
    expect(o.message).toContain(invoice.number)
  })

  it('withholds an unsafe or stale pay link and never another user’s payment', async () => {
    const u = await makeUser('orders-stale')
    const other = await makeUser('orders-stale-other')
    const foreign = await db.payment.create({
      data: {
        userId: other.id, amount: 1, currency: 'usd', status: 'pending', type: 'domain', method: 'stripe',
        metadata: JSON.stringify({ redirectUrl: 'https://checkout.stripe.com/c/pay/cs_foreign' }),
      },
    })
    const unsafe = await db.payment.create({
      data: {
        userId: u.id, amount: 1, currency: 'usd', status: 'pending', type: 'domain', method: 'stripe',
        metadata: JSON.stringify({ redirectUrl: 'javascript:alert(1)' }),
      },
    })
    const stale = await db.payment.create({
      data: {
        userId: u.id, amount: 1, currency: 'usd', status: 'pending', type: 'domain', method: 'stripe',
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        metadata: JSON.stringify({ redirectUrl: 'https://checkout.stripe.com/c/pay/cs_old' }),
      },
    })
    for (const p of [foreign, unsafe, stale]) {
      await makeOrder(u.id, { metadata: JSON.stringify({ paymentId: p.id }) })
    }
    const raw = await (await get(u.token)).text()
    expect(raw).not.toContain('cs_foreign')
    expect(raw).not.toContain('javascript:')
    expect(raw).not.toContain('cs_old')
    const body = JSON.parse(raw)
    for (const o of body.orders) expect(o.payment.payUrl).toBeNull()
  })

  it('reports a paid invoice and the live domain for a completed order', async () => {
    const u = await makeUser('orders-done')
    const domain = await db.domain.create({
      data: { name: `${uid('live')}.com`, userId: u.id, status: 'active', registrar: 'dynadot', provider: 'dynadot' },
    })
    const order = await makeOrder(u.id, {
      status: 'completed',
      domainName: domain.name,
      domainId: domain.id,
      registrarConfirmedAt: new Date(),
    })
    await makeInvoice(u.id, order.id, { status: 'paid', amountPaid: 16.5, paidAt: new Date() })

    const o = (await (await get(u.token)).json()).orders[0]
    expect(o.status).toBe('completed')
    expect(o.invoicePaid).toBe(true)
    expect(o.domainId).toBe(domain.id)
    expect(o.domainActive).toBe(true)
    expect(o.payment).toBeNull()
  })
})
