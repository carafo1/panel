/**
 * Billing integrity: one payment pays for exactly one order, exactly once.
 *
 * Regression guards for the audit findings:
 *   - Stripe success/webhook lost the Payment after overwriting its lookup key
 *     and then created a new completed Payment (+ another container) or
 *     completed the user's newest unrelated pending payment;
 *   - confirmed card / Waafi payments never settled their invoice, so the
 *     sweep later suspended paying customers;
 *   - activation guessed the subscription / invoice ("latest pending",
 *     "newest unpaid") and marked invoices fully paid for any amount;
 *   - Waafi callbacks overwrote the expected amount with whatever was reported;
 *   - check-then-act races in activation, provisioning, credit, refunds,
 *     renewals and the billing sweep.
 *
 * Nothing here talks to Stripe or Waafi: Stripe sessions are plain objects
 * handed to the shared confirmation function, and Waafi runs in demo mode.
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '@/lib/db'
import {
  activatePayment,
  confirmStripeCheckoutSession,
} from '@/lib/payment-activation'
import {
  createSubscriptionInvoice,
  markInvoicePaid,
  findInvoiceForPayment,
} from '@/lib/invoices'
import { adjustCredit } from '@/lib/credit'
import { refundInvoice, recordStripeChargeRefund } from '@/lib/refunds'
import { renewSubscription, acquireCronLease, releaseCronLease } from '@/lib/renewals'
import { provisionForPayment } from '@/lib/provision-on-payment'
import { ensurePaymentMethodsSeeded } from '@/lib/payment-methods'
import { POST as waafiCallback } from '@/app/api/billing/waafi/callback/route'
import { POST as checkoutPOST } from '@/app/api/billing/checkout/route'
import { POST as sweepPOST } from '@/app/api/billing/sweep/route'
import { makeUser, makePlan, authed, DAY, uid } from './helpers'

// Waafi must stay in demo mode (no live calls) whatever a local .env holds.
for (const k of ['WAAFI_API_URL', 'WAAFI_MERCHANT_ID', 'WAAFI_API_KEY', 'WAAFI_API_USER_ID']) {
  delete process.env[k]
}

type Order = {
  subId: string
  invoiceId: string
  paymentId: string
  sessionId: string
}

/** What checkout + processPayment leave behind for one order. */
async function makeOrder(
  userId: string,
  planId: string,
  opts: { amount?: number; method?: 'stripe' | 'waafi' | 'manual'; linkSubscription?: boolean } = {}
): Promise<Order> {
  const amount = opts.amount ?? 10
  const method = opts.method ?? 'stripe'
  const start = new Date()
  const sub = await db.subscription.create({
    data: {
      userId, planId, status: 'pending',
      currentPeriodStart: start, currentPeriodEnd: new Date(start.getTime() + 30 * DAY),
      stripeSubId: `sub_sim_${uid('s')}`,
    },
  })
  const inv = await createSubscriptionInvoice({
    userId, subscriptionId: sub.id, planId, amount, currency: 'USD',
    periodStart: start, periodEnd: sub.currentPeriodEnd, skipTax: true, notify: false,
  })
  const tx = method === 'stripe' ? `cs_test_${uid('cs')}` : method === 'waafi' ? `waafi_demo_${uid('w')}` : uid('MAN')
  const linkSub = opts.linkSubscription !== false
  const payment = await db.payment.create({
    data: {
      userId,
      subscriptionId: linkSub ? sub.id : null,
      amount, currency: 'usd', status: 'pending', type: 'hosting', method,
      transactionId: tx,
      stripePaymentId: method === 'stripe' ? tx : null,
      metadata: JSON.stringify({
        planId, purchaseType: 'hosting', subscriptionId: linkSub ? sub.id : null,
        invoiceId: linkSub ? inv.id : null,
        // Provision a project only — never start a real deploy from a test.
        deployMode: 'manual', projectName: uid('proj'),
      }),
    },
  })
  return { subId: sub.id, invoiceId: inv.id, paymentId: payment.id, sessionId: tx }
}

const paidSession = (sessionId: string, userId: string, amountCents = 1000) => ({
  id: sessionId,
  payment_status: 'paid',
  payment_intent: `pi_${sessionId}`,
  amount_total: amountCents,
  currency: 'usd',
  metadata: { userId, planId: 'x' },
})

describe('Stripe confirmation (success page + webhook)', () => {
  let userId: string
  let order: Order
  let other: Order

  beforeAll(async () => {
    const user = await makeUser('stripe-buyer')
    userId = user.id
    const planA = await makePlan()
    const planB = await makePlan()
    order = await makeOrder(userId, planA.id)
    // An unrelated order the customer has NOT paid for.
    other = await makeOrder(userId, planB.id)
  })

  it('activates once however many times the session is confirmed', async () => {
    const paymentsBefore = await db.payment.count({ where: { userId } })
    const session = paidSession(order.sessionId, userId)

    // Webhook and browser return racing, then the success URL revisited.
    const [a, b] = await Promise.all([
      confirmStripeCheckoutSession(session),
      confirmStripeCheckoutSession(session),
    ])
    const c = await confirmStripeCheckoutSession(session)

    const outcomes = [a.outcome, b.outcome, c.outcome]
    expect(outcomes.filter((o) => o === 'activated').length).toBe(1)
    expect(outcomes.filter((o) => o === 'already_completed').length).toBe(2)
    expect(new Set([a.paymentId, b.paymentId, c.paymentId])).toEqual(new Set([order.paymentId]))

    // No Payment was created from the session, and exactly one project exists.
    expect(await db.payment.count({ where: { userId } })).toBe(paymentsBefore)
    expect(await db.project.count({ where: { userId } })).toBe(1)

    const p = await db.payment.findUniqueOrThrow({ where: { id: order.paymentId } })
    expect(p.status).toBe('completed')
    expect(p.transactionId).toBe(order.sessionId) // the lookup key never changes
    expect(p.stripePaymentId).toBe(`pi_${order.sessionId}`)
    expect(p.provisionClaimedAt).not.toBeNull()
    expect(p.invoiceId).toBe(order.invoiceId)
  })

  it('settles the checkout invoice and activates only its own subscription', async () => {
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: order.invoiceId } })
    expect(inv.status).toBe('paid')
    expect(inv.amountPaid).toBe(10)
    expect((await db.subscription.findUniqueOrThrow({ where: { id: order.subId } })).status).toBe('active')

    // The unrelated order is untouched.
    expect((await db.payment.findUniqueOrThrow({ where: { id: other.paymentId } })).status).toBe('pending')
    expect((await db.subscription.findUniqueOrThrow({ where: { id: other.subId } })).status).toBe('pending')
    expect((await db.invoice.findUniqueOrThrow({ where: { id: other.invoiceId } })).status).toBe('unpaid')
  })

  it('does nothing for an unknown session, an unpaid session or a short payment', async () => {
    const before = await db.payment.count({ where: { userId } })
    expect((await confirmStripeCheckoutSession(paidSession('cs_unknown_' + uid('x'), userId))).outcome).toBe('no_payment')
    expect(
      (await confirmStripeCheckoutSession({ ...paidSession(other.sessionId, userId), payment_status: 'unpaid' })).outcome
    ).toBe('not_paid')
    expect((await confirmStripeCheckoutSession(paidSession(other.sessionId, userId, 1))).outcome).toBe('mismatch')
    expect(
      (await confirmStripeCheckoutSession({ ...paidSession(other.sessionId, userId), metadata: { userId: 'someone-else' } })).outcome
    ).toBe('mismatch')

    expect(await db.payment.count({ where: { userId } })).toBe(before)
    expect((await db.payment.findUniqueOrThrow({ where: { id: other.paymentId } })).status).toBe('pending')
  })

  it('books a Stripe dashboard refund against the payment and its invoice', async () => {
    const first = await recordStripeChargeRefund({
      id: 'ch_' + uid('c'), payment_intent: `pi_${order.sessionId}`, amount_refunded: 1000, refunded: true,
    })
    expect(first).toContain('marked refunded')
    // Redelivered event books nothing more.
    await recordStripeChargeRefund({
      id: 'ch_' + uid('c'), payment_intent: `pi_${order.sessionId}`, amount_refunded: 1000, refunded: true,
    })
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: order.invoiceId } })
    expect(inv.amountRefunded).toBe(10)
    expect(inv.status).toBe('refunded')
    expect(await db.refund.count({ where: { invoiceId: order.invoiceId } })).toBe(1)
    expect((await db.payment.findUniqueOrThrow({ where: { id: order.paymentId } })).status).toBe('refunded')
  })
})

describe('activatePayment and provisioning guards', () => {
  it('never completes a failed payment', async () => {
    const user = await makeUser('failed-pay')
    const plan = await makePlan()
    const o = await makeOrder(user.id, plan.id, { method: 'manual' })
    await db.payment.update({ where: { id: o.paymentId }, data: { status: 'failed' } })

    const r = await activatePayment({ paymentId: o.paymentId })
    expect(r.success).toBe(false)
    expect((await db.payment.findUniqueOrThrow({ where: { id: o.paymentId } })).status).toBe('failed')
    expect((await db.subscription.findUniqueOrThrow({ where: { id: o.subId } })).status).toBe('pending')
  })

  it('does not activate "the newest pending subscription" for an unlinked payment', async () => {
    const user = await makeUser('unlinked-pay')
    const plan = await makePlan()
    const o = await makeOrder(user.id, plan.id, { method: 'manual', linkSubscription: false })

    const r = await activatePayment({ paymentId: o.paymentId })
    expect(r.success).toBe(true)
    expect(r.subscriptionId).toBeNull()
    expect((await db.subscription.findUniqueOrThrow({ where: { id: o.subId } })).status).toBe('pending')
    expect((await db.invoice.findUniqueOrThrow({ where: { id: o.invoiceId } })).status).toBe('unpaid')
  })

  it('claims activation atomically under concurrency', async () => {
    const user = await makeUser('double-confirm')
    const plan = await makePlan()
    const o = await makeOrder(user.id, plan.id, { method: 'manual' })

    const results = await Promise.all([
      activatePayment({ paymentId: o.paymentId }),
      activatePayment({ paymentId: o.paymentId }),
      activatePayment({ paymentId: o.paymentId }),
    ])
    expect(results.every((r) => r.success)).toBe(true)
    expect(results.filter((r) => !r.alreadyCompleted).length).toBe(1)
    expect(await db.project.count({ where: { userId: user.id } })).toBe(1)
    expect(await db.transaction.count({ where: { invoiceId: o.invoiceId } })).toBe(1)
  })

  it('provisions a completed payment at most once, and never a pending one', async () => {
    const user = await makeUser('provision-once')
    const plan = await makePlan()
    const o = await makeOrder(user.id, plan.id, { method: 'manual' })

    expect((await provisionForPayment(o.paymentId)).provisioned).toBe(false) // still pending
    await db.payment.update({ where: { id: o.paymentId }, data: { status: 'completed' } })
    const runs = await Promise.all([provisionForPayment(o.paymentId), provisionForPayment(o.paymentId)])
    expect(runs.filter((r) => r.provisioned).length).toBe(1)
    expect(await db.project.count({ where: { userId: user.id } })).toBe(1)
  })
})

describe('invoice settlement', () => {
  it('records a smaller payment as partial, not as paid in full', async () => {
    const user = await makeUser('partial')
    const inv = await createSubscriptionInvoice({ userId: user.id, amount: 30, skipTax: true, notify: false })

    await markInvoicePaid(inv.id, { gateway: 'manual', amount: 10 })
    let now = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } })
    expect(now.status).toBe('partially_paid')
    expect(now.amountPaid).toBe(10)

    await markInvoicePaid(inv.id, { gateway: 'manual', amount: 20 })
    now = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } })
    expect(now.status).toBe('paid')
    expect(now.amountPaid).toBe(30)
  })

  it('never falls back to the newest unpaid invoice of the user', async () => {
    const user = await makeUser('no-fallback')
    const plan = await makePlan()
    await makeOrder(user.id, plan.id, { method: 'manual' }) // has an unpaid invoice
    expect(await findInvoiceForPayment({ userId: user.id, subscriptionId: null })).toBeNull()
  })

  it('ignores an explicitly linked invoice that belongs to someone else', async () => {
    const a = await makeUser('inv-owner')
    const b = await makeUser('inv-other')
    const inv = await createSubscriptionInvoice({ userId: a.id, amount: 5, skipTax: true, notify: false })
    expect(await findInvoiceForPayment({ userId: b.id, invoiceId: inv.id })).toBeNull()
  })
})

describe('Waafi callback', () => {
  it('keeps the expected amount, settles the invoice and is idempotent', async () => {
    const user = await makeUser('waafi-buyer')
    const plan = await makePlan()
    const o = await makeOrder(user.id, plan.id, { method: 'waafi', amount: 25 })
    const call = (body: Record<string, unknown>) =>
      waafiCallback(new Request('http://localhost/api/billing/waafi/callback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }))

    // A forged body claiming 0.01 must not rewrite the price.
    const res = await call({ transactionId: o.sessionId, status: 'success', amount: 0.01, currency: 'USD' })
    expect(res.status).toBe(200)
    const p = await db.payment.findUniqueOrThrow({ where: { id: o.paymentId } })
    expect(p.status).toBe('completed')
    expect(p.amount).toBe(25)
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: o.invoiceId } })
    expect(inv.status).toBe('paid')
    expect(inv.amountPaid).toBe(25)

    const again = await (await call({ transactionId: o.sessionId, status: 'success' })).json()
    expect(again.message).toBe('Payment already processed')
    expect(await db.project.count({ where: { userId: user.id } })).toBe(1)
  })

  it('does not resurrect a failed payment or activate an unrelated pending subscription', async () => {
    const user = await makeUser('waafi-failed')
    const plan = await makePlan()
    const unrelated = await makeOrder(user.id, plan.id, { method: 'manual' })
    const o = await makeOrder(user.id, plan.id, { method: 'waafi', linkSubscription: false })
    await db.payment.update({ where: { id: o.paymentId }, data: { status: 'failed' } })

    const res = await waafiCallback(new Request('http://localhost/api/billing/waafi/callback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId: o.sessionId, status: 'success' }),
    }))
    expect(res.status).toBe(200)
    expect((await db.payment.findUniqueOrThrow({ where: { id: o.paymentId } })).status).toBe('failed')
    expect((await db.subscription.findUniqueOrThrow({ where: { id: unrelated.subId } })).status).toBe('pending')
  })
})

describe('wallet credit and refunds', () => {
  it('does not lose concurrent top-ups', async () => {
    const user = await makeUser('wallet-topups')
    await Promise.all(
      Array.from({ length: 5 }, () =>
        adjustCredit({ userId: user.id, amount: 1, type: 'topup', notify: false })
      )
    )
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).creditBalance).toBe(5)
    expect(await db.creditTransaction.count({ where: { userId: user.id } })).toBe(5)
  })

  it('never overdraws when two spends race', async () => {
    const user = await makeUser('wallet-spend')
    await adjustCredit({ userId: user.id, amount: 5, type: 'topup', notify: false })
    const r = await Promise.all([
      adjustCredit({ userId: user.id, amount: -4, type: 'adjustment', notify: false }),
      adjustCredit({ userId: user.id, amount: -4, type: 'adjustment', notify: false }),
    ])
    expect(r.filter((x) => x.success).length).toBe(1)
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).creditBalance).toBe(1)
  })

  it('refunds once when two full refunds race, and marks the payment refunded', async () => {
    const user = await makeUser('refund-race')
    const plan = await makePlan()
    const o = await makeOrder(user.id, plan.id, { method: 'manual', amount: 20 })
    await activatePayment({ paymentId: o.paymentId })
    expect((await db.invoice.findUniqueOrThrow({ where: { id: o.invoiceId } })).status).toBe('paid')

    const r = await Promise.all([
      refundInvoice({ invoiceId: o.invoiceId }),
      refundInvoice({ invoiceId: o.invoiceId }),
    ])
    expect(r.filter((x) => x.success).length).toBe(1)
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).creditBalance).toBe(20)
    expect(await db.refund.count({ where: { invoiceId: o.invoiceId } })).toBe(1)
    expect((await db.payment.findUniqueOrThrow({ where: { id: o.paymentId } })).status).toBe('refunded')
  })
})

describe('renewals and the sweep lease', () => {
  it('raises one renewal invoice when two renewals race', async () => {
    const user = await makeUser('renew-race')
    const plan = await makePlan()
    const now = Date.now()
    const sub = await db.subscription.create({
      data: {
        userId: user.id, planId: plan.id, status: 'active', autoRenew: true,
        currentPeriodStart: new Date(now - 31 * DAY), currentPeriodEnd: new Date(now - DAY),
      },
    })
    const r = await Promise.all([
      renewSubscription({ subscriptionId: sub.id }),
      renewSubscription({ subscriptionId: sub.id }),
    ])
    expect(r.filter((x) => x.success).length).toBe(1)
    expect(await db.invoice.count({ where: { subscriptionId: sub.id } })).toBe(1)
  })

  it('grants a lease to one holder at a time and lets an expired one be taken over', async () => {
    const name = uid('lease')
    const first = await acquireCronLease(name, 60_000)
    expect(first).not.toBeNull()
    expect(await acquireCronLease(name, 60_000)).toBeNull()

    await releaseCronLease(name, first!)
    const second = await acquireCronLease(name, 60_000)
    expect(second).not.toBeNull()

    await db.cronLock.update({ where: { name }, data: { lockedUntil: new Date(Date.now() - 1000) } })
    expect(await acquireCronLease(name, 60_000)).not.toBeNull()
  })

  it('skips a billing sweep while another one holds the lease', async () => {
    const held = await acquireCronLease('billing-sweep', 60_000)
    expect(held).not.toBeNull()
    try {
      const res = await sweepPOST(new Request('http://localhost/api/billing/sweep', {
        method: 'POST', headers: { 'x-cron-key': process.env.CRON_API_KEY! },
      }))
      const body = await res.json()
      expect(res.status).toBe(200)
      expect(body.skipped).toBeTruthy()
      expect(body.renewed).toBeUndefined()
    } finally {
      await releaseCronLease('billing-sweep', held!)
    }
  })
})

describe('checkout', () => {
  it('refuses inactive, archived and hidden plans', async () => {
    const user = await makeUser('checkout-plans')
    for (const extra of [{ active: false }, { archived: true }, { hidden: true }]) {
      const plan = await makePlan(extra)
      const res = await checkoutPOST(authed(user.token, '/api/billing/checkout', {
        method: 'POST', body: JSON.stringify({ planId: plan.id, type: 'hosting', method: 'manual' }),
      }))
      expect(res.status).toBe(400)
    }
  })

  it('links a new plan purchase to its own subscription and invoice, in the plan currency', async () => {
    await ensurePaymentMethodsSeeded()
    await db.paymentMethodSetting.update({ where: { method: 'manual' }, data: { active: true } })

    const user = await makeUser('checkout-link')
    await db.user.update({ where: { id: user.id }, data: { emailVerified: true } })
    const planA = await makePlan()
    const planB = await makePlan({ currency: 'EUR', price: 15 })
    const now = Date.now()
    const subA = await db.subscription.create({
      data: {
        userId: user.id, planId: planA.id, status: 'active',
        currentPeriodStart: new Date(now - DAY), currentPeriodEnd: new Date(now + 29 * DAY),
      },
    })
    const invA = await createSubscriptionInvoice({
      userId: user.id, subscriptionId: subA.id, planId: planA.id, amount: 10, skipTax: true, notify: false,
      periodStart: new Date(now + 29 * DAY),
    })

    const res = await checkoutPOST(authed(user.token, '/api/billing/checkout', {
      method: 'POST', body: JSON.stringify({ planId: planB.id, type: 'hosting', method: 'manual' }),
    }))
    expect(res.status).toBe(201)
    const body = await res.json()
    const payment = await db.payment.findUniqueOrThrow({ where: { id: body.paymentId } })
    expect(payment.subscriptionId).not.toBe(subA.id)
    expect(payment.currency).toBe('eur')
    const subB = await db.subscription.findUniqueOrThrow({ where: { id: payment.subscriptionId! } })
    expect(subB.planId).toBe(planB.id)
    const meta = JSON.parse(payment.metadata || '{}')
    const invB = await db.invoice.findUniqueOrThrow({ where: { id: meta.invoiceId } })
    expect(invB.subscriptionId).toBe(subB.id)

    // Confirm it (no real deploy from a test) and check what got settled.
    await db.payment.update({
      where: { id: payment.id },
      data: { metadata: JSON.stringify({ ...meta, deployMode: 'manual' }) },
    })
    expect((await activatePayment({ paymentId: payment.id })).success).toBe(true)
    expect((await db.invoice.findUniqueOrThrow({ where: { id: invB.id } })).status).toBe('paid')
    expect((await db.subscription.findUniqueOrThrow({ where: { id: subB.id } })).status).toBe('active')
    expect((await db.invoice.findUniqueOrThrow({ where: { id: invA.id } })).status).toBe('unpaid')
  })
})
