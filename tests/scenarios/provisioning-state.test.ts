/**
 * Paid-order provisioning: the Payment.provisionStatus state machine, the
 * reconcile sweep, the admin retry route, the legacy checkout domain path,
 * orchestration hosting idempotency, and mail activation without Mailcow.
 *
 * Nothing here reaches Docker, Dynadot or Mailcow:
 *   - deployProject, createDomainOrder and fulfilDomainOrder are wrapped so a
 *     test can substitute them; unset, the wrappers delegate to the real code,
 *     so other scenario files in the same process are unaffected;
 *   - registerDomain is wrapped only to COUNT calls (it must stay at zero);
 *   - Mailcow is unconfigured (env cleared below).
 */
import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test'
import * as realVpsNs from '@/lib/vps'
import * as realDynadotNs from '@/lib/dynadot'
import * as realDomainCheckoutNs from '@/lib/domain-checkout'

// Copied BEFORE mocking so the wrappers hold the original functions.
const realVps = { ...realVpsNs }
const realDynadot = { ...realDynadotNs }
const realDomainCheckout = { ...realDomainCheckoutNs }

type AnyFn = (...a: any[]) => any // eslint-disable-line @typescript-eslint/no-explicit-any
const hooks: { deploy?: AnyFn; createOrder?: AnyFn; fulfil?: AnyFn } = {}
let registerDomainCalls = 0

mock.module('@/lib/vps', () => ({
  ...realVps,
  deployProject: (req: Parameters<typeof realVps.deployProject>[0]) =>
    hooks.deploy ? hooks.deploy(req) : realVps.deployProject(req),
}))
mock.module('@/lib/dynadot', () => ({
  ...realDynadot,
  registerDomain: (...a: Parameters<typeof realDynadot.registerDomain>) => {
    registerDomainCalls++
    return realDynadot.registerDomain(...a)
  },
}))
mock.module('@/lib/domain-checkout', () => ({
  ...realDomainCheckout,
  createDomainOrder: (input: Parameters<typeof realDomainCheckout.createDomainOrder>[0]) =>
    hooks.createOrder ? hooks.createOrder(input) : realDomainCheckout.createDomainOrder(input),
  fulfilDomainOrder: (...a: Parameters<typeof realDomainCheckout.fulfilDomainOrder>) =>
    hooks.fulfil ? hooks.fulfil(...a) : realDomainCheckout.fulfilDomainOrder(...a),
}))

// Mailcow must be unconfigured whatever a local .env holds.
delete process.env.MAILCOW_API_URL
delete process.env.MAILCOW_API_KEY

const { db } = await import('@/lib/db')
const { provisionForPayment, claimProvisioning, PROVISION_LEASE_MS } = await import(
  '@/lib/provision-on-payment'
)
const { sweepProvisioning } = await import('@/lib/reconcile')
const { activatePayment } = await import('@/lib/payment-activation')
const { provisionEmailService } = await import('@/lib/email-hosting')
const { runProvisioningPipeline } = await import('@/lib/orchestration')
const { ensurePaymentMethodsSeeded } = await import('@/lib/payment-methods')
const { POST: checkoutPOST } = await import('@/app/api/billing/checkout/route')
const adminList = await import('@/app/api/admin/provisioning/route')
const adminRetry = await import('@/app/api/admin/provisioning/[paymentId]/retry/route')
const { makeUser, makePlan, makeProject, authed, params, uid } = await import('./helpers')

const MIN = 60 * 1000
type U = Awaited<ReturnType<typeof makeUser>>
let user: U, other: U, admin: U

async function makePaid(
  userId: string,
  meta: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) {
  return db.payment.create({
    data: {
      userId,
      amount: 10,
      currency: 'usd',
      status: 'completed',
      type: String(meta.purchaseType || 'hosting'),
      method: 'manual',
      transactionId: uid('MAN'),
      metadata: JSON.stringify(meta),
      ...extra,
    },
  })
}
const reload = (id: string) => db.payment.findUniqueOrThrow({ where: { id } })

beforeAll(async () => {
  user = await makeUser('prov-user')
  other = await makeUser('prov-other')
  admin = await makeUser('prov-admin', 'admin')
})

afterAll(() => {
  hooks.deploy = hooks.createOrder = hooks.fulfil = undefined
})

// ── State machine (no hosting server exists yet in this file) ───────────────

describe('provisioning claim and outcomes', () => {
  it('provisions once and records provisioned; a second call is not claimed', async () => {
    const p = await makePaid(user.id, { purchaseType: 'hosting', deployMode: 'manual', projectName: uid('p') })
    const first = await provisionForPayment(p.id)
    expect(first.provisioned).toBe(true)
    expect(first.status).toBe('provisioned')
    const row = await reload(p.id)
    expect(row.provisionStatus).toBe('provisioned')
    expect(row.provisionAttempts).toBe(1)
    expect(row.provisionLeaseUntil).toBeNull()
    expect(row.provisionClaimedAt).not.toBeNull()
    // The created project is recorded on the payment for reuse.
    expect(JSON.parse(row.metadata || '{}').projectId).toBe(first.projectId)

    const again = await provisionForPayment(p.id)
    expect(again.provisioned).toBe(false)
    expect(await db.project.count({ where: { id: first.projectId } })).toBe(1)
  })

  it('only one of two concurrent claims wins', async () => {
    const p = await makePaid(user.id, { purchaseType: 'hosting', deployMode: 'manual' })
    const claims = await Promise.all([claimProvisioning(p.id), claimProvisioning(p.id)])
    expect(claims.filter(Boolean).length).toBe(1)
  })

  it('a live lease blocks a re-claim; an expired lease is taken over', async () => {
    const p = await makePaid(user.id, { purchaseType: 'hosting', deployMode: 'manual' }, {
      provisionStatus: 'provisioning',
      provisionClaimedAt: new Date(),
      provisionAttempts: 1,
      provisionLeaseUntil: new Date(Date.now() + PROVISION_LEASE_MS),
    })
    expect(await claimProvisioning(p.id)).toBe(false)
    await db.payment.update({ where: { id: p.id }, data: { provisionLeaseUntil: new Date(Date.now() - MIN) } })
    expect(await claimProvisioning(p.id)).toBe(true)
    const row = await reload(p.id)
    expect(row.provisionAttempts).toBe(2)
    expect(row.provisionLeaseUntil!.getTime()).toBeGreaterThan(Date.now())
  })

  it('a legacy row claimed before provisionStatus existed is never re-run', async () => {
    const p = await makePaid(user.id, { purchaseType: 'hosting', deployMode: 'manual' }, {
      provisionClaimedAt: new Date(Date.now() - 60 * MIN),
    })
    expect(await claimProvisioning(p.id)).toBe(false)
  })

  it('no usable server: retry_pending with the reason, nothing created; failed after 3 attempts', async () => {
    const name = uid('noserver')
    const p = await makePaid(user.id, { purchaseType: 'hosting', projectName: name })
    for (const expected of ['retry_pending', 'retry_pending', 'failed'] as const) {
      const r = await provisionForPayment(p.id)
      expect(r.provisioned).toBe(false)
      expect(r.status).toBe(expected)
    }
    const row = await reload(p.id)
    expect(row.provisionAttempts).toBe(3)
    expect(row.provisionError).toContain('No hosting server')
    expect(await db.project.count({ where: { userId: user.id, name } })).toBe(0)
  })

  it('manual_review is never re-run, by a direct call or the sweep', async () => {
    const p = await makePaid(user.id, { purchaseType: 'hosting', deployMode: 'manual' }, {
      provisionStatus: 'manual_review',
      provisionClaimedAt: new Date(Date.now() - 60 * MIN),
      provisionError: 'needs a human',
    })
    expect((await provisionForPayment(p.id)).provisioned).toBe(false)
    const sweep = await sweepProvisioning()
    expect(sweep.outcomes.some((o) => o.paymentId === p.id)).toBe(false)
    expect((await reload(p.id)).provisionStatus).toBe('manual_review')
  })

  it("refuses a projectId that belongs to someone else than the payer", async () => {
    const victimProject = await makeProject(other.id)
    const p = await makePaid(user.id, { purchaseType: 'hosting', projectId: victimProject.id })
    const r = await provisionForPayment(p.id)
    expect(r.provisioned).toBe(false)
    expect(r.status).toBe('failed')
    expect(r.detail).toContain('does not belong to the payer')
    expect(await db.deployment.count({ where: { projectId: victimProject.id } })).toBe(0)
  })

  it('a domain order whose registrar call has no confirmed outcome goes to manual_review without calling fulfilment', async () => {
    let fulfilCalls = 0
    hooks.fulfil = async () => {
      fulfilCalls++
      return { success: true }
    }
    try {
      const order = await db.domainOrder.create({
        data: {
          userId: user.id, domainName: `${uid('reg')}.com`, type: 'register', status: 'failed',
          unitPrice: 10, totalAmount: 10, registrarCalledAt: new Date(Date.now() - 30 * MIN),
        },
      })
      const p = await makePaid(user.id, { purchaseType: 'domain', domainOrderId: order.id })
      const r = await provisionForPayment(p.id)
      expect(r.status).toBe('manual_review')
      expect(fulfilCalls).toBe(0)

      // Admin retry is refused without an explicit reconciliation…
      const refused = await adminRetry.POST(
        authed(admin.token, `/api/admin/provisioning/${p.id}/retry`, { method: 'POST', body: '{}' }),
        params({ paymentId: p.id })
      )
      expect(refused.status).toBe(409)
      expect((await refused.json()).code).toBe('REGISTRAR_RECONCILIATION_REQUIRED')
      expect(fulfilCalls).toBe(0)

      // …and goes through once the admin confirms it.
      const ok = await adminRetry.POST(
        authed(admin.token, `/api/admin/provisioning/${p.id}/retry`, {
          method: 'POST',
          body: JSON.stringify({ confirmRegistrarReconciled: true }),
        }),
        params({ paymentId: p.id })
      )
      expect(ok.status).toBe(200)
      expect((await ok.json()).status).toBe('provisioned')
      expect(fulfilCalls).toBe(1)
    } finally {
      hooks.fulfil = undefined
    }
  })

  it('a fulfilment failure after the registrar was reached is manual_review; before it, retry_pending', async () => {
    const mk = (calledAt: Date | null) =>
      db.domainOrder.create({
        data: {
          userId: user.id, domainName: `${uid('ful')}.com`, type: 'register', status: 'pending_payment',
          unitPrice: 10, totalAmount: 10, registrarCalledAt: calledAt,
        },
      })
    const reached = await mk(null)
    const notReached = await mk(null)
    hooks.fulfil = async (orderId: string) => {
      if (orderId === reached.id) {
        await db.domainOrder.update({ where: { id: orderId }, data: { registrarCalledAt: new Date(), status: 'failed' } })
      } else {
        await db.domainOrder.update({ where: { id: orderId }, data: { status: 'failed' } })
      }
      return { success: false, error: 'boom' }
    }
    try {
      const a = await makePaid(user.id, { purchaseType: 'domain', domainOrderId: reached.id })
      const b = await makePaid(user.id, { purchaseType: 'domain', domainOrderId: notReached.id })
      expect((await provisionForPayment(a.id)).status).toBe('manual_review')
      expect((await provisionForPayment(b.id)).status).toBe('retry_pending')
    } finally {
      hooks.fulfil = undefined
    }
  })

  it('a legacy domain payment without a DomainOrder is manual_review and never registers', async () => {
    const before = registerDomainCalls
    const p = await makePaid(user.id, { purchaseType: 'both', domainName: `${uid('legacy')}.com` })
    const r = await provisionForPayment(p.id)
    expect(r.status).toBe('manual_review')
    expect(registerDomainCalls).toBe(before)
  })
})

describe('reconcile sweep', () => {
  it('re-drives a completed, never-started payment older than 5 minutes; leaves a renewal alone', async () => {
    const stale = await makePaid(
      user.id,
      { purchaseType: 'hosting', deployMode: 'manual', provisionRequired: true },
      { createdAt: new Date(Date.now() - 10 * MIN) }
    )
    // A Stripe renewal: completed, but never meant to be provisioned.
    const renewal = await makePaid(
      user.id,
      { recurring: true, invoiceId: 'in_x' },
      { createdAt: new Date(Date.now() - 10 * MIN) }
    )
    // Too recent: activation itself still gets the first go.
    const fresh = await makePaid(user.id, { purchaseType: 'hosting', deployMode: 'manual', provisionRequired: true })

    const sweep = await sweepProvisioning()
    const mine = sweep.outcomes.find((o) => o.paymentId === stale.id)
    expect(mine?.status).toBe('provisioned')
    expect((await reload(stale.id)).provisionStatus).toBe('provisioned')
    expect((await reload(renewal.id)).provisionStatus).toBe('none')
    expect((await reload(fresh.id)).provisionStatus).toBe('none')
  })

  it('retries retry_pending only once its backoff has elapsed', async () => {
    const due = await makePaid(user.id, { purchaseType: 'hosting', deployMode: 'manual' }, {
      provisionStatus: 'retry_pending', provisionAttempts: 1, provisionClaimedAt: new Date(Date.now() - 10 * MIN),
    })
    const notDue = await makePaid(user.id, { purchaseType: 'hosting', deployMode: 'manual' }, {
      provisionStatus: 'retry_pending', provisionAttempts: 2, provisionClaimedAt: new Date(Date.now() - 10 * MIN),
    })
    const sweep = await sweepProvisioning()
    expect(sweep.outcomes.find((o) => o.paymentId === due.id)?.status).toBe('provisioned')
    expect(sweep.outcomes.some((o) => o.paymentId === notDue.id)).toBe(false)
    expect((await reload(notDue.id)).provisionStatus).toBe('retry_pending')
  })

  it('activation marks the payment as needing provisioning in the same write', async () => {
    const plan = await makePlan()
    const p = await db.payment.create({
      data: {
        userId: user.id, amount: 10, currency: 'usd', status: 'pending', type: 'hosting', method: 'manual',
        transactionId: uid('MAN'),
        metadata: JSON.stringify({ planId: plan.id, purchaseType: 'hosting', deployMode: 'manual' }),
      },
    })
    expect((await activatePayment({ paymentId: p.id })).success).toBe(true)
    const row = await reload(p.id)
    expect(JSON.parse(row.metadata || '{}').provisionRequired).toBe(true)
    expect(row.provisionStatus).toBe('provisioned')
  })
})

describe('domain order reconciliation', () => {
  const order = (extra: Record<string, unknown>) =>
    db.domainOrder.create({
      data: { userId: user.id, domainName: `${uid('dr')}.com`, type: 'register', unitPrice: 10, totalAmount: 10, ...extra },
    })

  it('requeues failed orders only when the registrar was never called; never touches manual_review', async () => {
    const { requeueFailedDomainOrders } = await import('@/lib/reconcile')
    const safe = await order({ status: 'failed' })
    const called = await order({ status: 'failed', registrarCalledAt: new Date() })
    const review = await order({ status: 'manual_review' })
    await requeueFailedDomainOrders()
    const get = async (id: string) => (await db.domainOrder.findUniqueOrThrow({ where: { id } })).status
    expect(await get(safe.id)).toBe('retry_pending')
    expect(await get(called.id)).toBe('failed')
    expect(await get(review.id)).toBe('manual_review')
  })

  it('a fulfilment held for manual review puts the payment in manual_review', async () => {
    const o = await order({ status: 'pending_payment' })
    hooks.fulfil = async () => ({ success: false, error: 'Order is held for manual review' })
    try {
      const p = await makePaid(user.id, { purchaseType: 'domain', domainOrderId: o.id })
      expect((await provisionForPayment(p.id)).status).toBe('manual_review')
    } finally {
      hooks.fulfil = undefined
    }
  })

  it('completes a finished transfer with the registrar expiry, read-only', async () => {
    const { pollTransfers } = await import('@/lib/reconcile')
    const done = `${uid('xfer')}.com`
    const waiting = `${uid('xwait')}.com`
    for (const name of [done, waiting]) {
      const d = await db.domain.create({
        data: { userId: user.id, name, status: 'transferring', transferStatus: 'pending', registrar: 'dynadot', provider: 'dynadot' },
      })
      await order({ domainName: name, type: 'transfer', status: 'transfer_pending', domainId: d.id })
    }
    const expiry = '2030-05-01T00:00:00.000Z'
    const getInfo = async (name: string) => {
      if (name === done) return { status: 'active', expiry }
      throw new Error('not in account')
    }
    const s = await pollTransfers({ getInfo, force: true })
    expect(s.completed.some((c) => c.domain === done)).toBe(true)
    const d = await db.domain.findUniqueOrThrow({ where: { name: done } })
    expect(d.status).toBe('active')
    expect(d.transferStatus).toBe('completed')
    expect(d.expiresAt?.toISOString()).toBe(expiry)
    expect((await db.domainOrder.findFirstOrThrow({ where: { domainName: done } })).status).toBe('completed')
    expect((await db.domain.findUniqueOrThrow({ where: { name: waiting } })).transferStatus).toBe('pending')
  })

  it('fills a missing expiry from the registrar and clears the order flag', async () => {
    const { reconcileDomainExpiry } = await import('@/lib/reconcile')
    const name = `${uid('exp')}.com`
    await db.domain.create({ data: { userId: user.id, name, status: 'active', registrar: 'dynadot', provider: 'dynadot' } })
    const o = await order({ domainName: name, status: 'completed', metadata: JSON.stringify({ needsReconciliation: 'expiry' }) })
    const expiry = '2031-01-02T00:00:00.000Z'
    const s = await reconcileDomainExpiry({ getInfo: async () => ({ status: 'active', expiry }), force: true })
    expect(s.filled.some((f) => f.domain === name)).toBe(true)
    expect((await db.domain.findUniqueOrThrow({ where: { name } })).expiresAt?.toISOString()).toBe(expiry)
    const meta = JSON.parse((await db.domainOrder.findUniqueOrThrow({ where: { id: o.id } })).metadata || '{}')
    expect(meta.needsReconciliation).toBeUndefined()
  })

  it('skips registrar polling entirely when no registrar key is configured', async () => {
    const { pollTransfers, reconcileDomainExpiry } = await import('@/lib/reconcile')
    let calls = 0
    const getInfo = async () => {
      calls++
      return { status: 'active' }
    }
    // Something earlier in the process may have applied a saved key.
    const prevKey = process.env.DYNADOT_API_KEY
    delete process.env.DYNADOT_API_KEY
    try {
      expect((await pollTransfers({ getInfo })).skipped).toBeTruthy()
      expect((await reconcileDomainExpiry({ getInfo })).skipped).toBeTruthy()
    } finally {
      if (prevKey !== undefined) process.env.DYNADOT_API_KEY = prevKey
    }
    expect(calls).toBe(0)
  })
})

describe('admin provisioning route', () => {
  it('requires a token (401) and an admin (403)', async () => {
    expect((await adminList.GET(authed(null, '/api/admin/provisioning'))).status).toBe(401)
    expect((await adminList.GET(authed(user.token, '/api/admin/provisioning'))).status).toBe(403)
    const r = await adminRetry.POST(
      authed(user.token, '/api/admin/provisioning/x/retry', { method: 'POST', body: '{}' }),
      params({ paymentId: 'x' })
    )
    expect(r.status).toBe(403)
  })

  it('lists payments needing attention', async () => {
    const p = await makePaid(user.id, { purchaseType: 'hosting' }, {
      provisionStatus: 'failed', provisionError: 'listed', provisionClaimedAt: new Date(),
    })
    const res = await adminList.GET(authed(admin.token, '/api/admin/provisioning'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.payments.some((x: { id: string }) => x.id === p.id)).toBe(true)
  })

  it('refuses to retry a provisioned payment', async () => {
    const p = await makePaid(user.id, { purchaseType: 'hosting' }, {
      provisionStatus: 'provisioned', provisionClaimedAt: new Date(),
    })
    const r = await adminRetry.POST(
      authed(admin.token, `/api/admin/provisioning/${p.id}/retry`, { method: 'POST', body: '{}' }),
      params({ paymentId: p.id })
    )
    expect(r.status).toBe(409)
  })
})

describe('legacy checkout domain purchases', () => {
  let plan: Awaited<ReturnType<typeof makePlan>>
  beforeAll(async () => {
    await ensurePaymentMethodsSeeded()
    await db.paymentMethodSetting.update({ where: { method: 'manual' }, data: { active: true } })
    await db.user.update({ where: { id: user.id }, data: { emailVerified: true } })
    plan = await makePlan()
  })
  const post = (body: Record<string, unknown>) =>
    checkoutPOST(authed(user.token, '/api/billing/checkout', { method: 'POST', body: JSON.stringify(body) }))

  it("refuses 'both' (hosting + domain in one payment)", async () => {
    const before = await db.payment.count({ where: { userId: user.id } })
    const res = await post({ planId: plan.id, type: 'both', method: 'manual', domainName: `${uid('b')}.com` })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('DOMAIN_CHECKOUT_REQUIRED')
    expect(await db.payment.count({ where: { userId: user.id } })).toBe(before)
  })

  it("refuses 'domain' without registrant contacts", async () => {
    const res = await post({ planId: plan.id, type: 'domain', method: 'manual', domainName: `${uid('d')}.com` })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('REGISTRANT_REQUIRED')
  })

  it("routes 'domain' through createDomainOrder and never calls registerDomain", async () => {
    const calls: Array<Record<string, unknown>> = []
    hooks.createOrder = async (input: Record<string, unknown>) => {
      calls.push(input)
      return { success: true, orderId: 'ord_1', paymentId: 'pay_1', status: 'pending', amount: 12, currency: 'USD' }
    }
    const before = registerDomainCalls
    try {
      const registrant = {
        firstName: 'A', lastName: 'B', email: 'a@example.test', phone: '+1.5555555555',
        address1: '1 St', city: 'X', postalCode: '1', country: 'US',
      }
      const name = `${uid('dom')}.com`
      const res = await post({ planId: plan.id, type: 'domain', method: 'manual', domainName: name, years: 2, registrant })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.orderId).toBe('ord_1')
      expect(calls.length).toBe(1)
      expect(calls[0].kind).toBe('register')
      expect(calls[0].domain).toBe(name)
      expect(calls[0].years).toBe(2)
      expect(calls[0].registrant).toEqual(registrant)
      expect(registerDomainCalls).toBe(before)
    } finally {
      hooks.createOrder = undefined
    }
  })
})

describe('email activation needs a real mail server', () => {
  it('in production without Mailcow: an error, and the service is not active', async () => {
    const plan = await makePlan({ planType: 'email', emailMailboxes: 2 })
    const domain = `${uid('mail')}.example`.toLowerCase().replace(/[^a-z0-9.-]/g, '')
    const prevEnv = process.env.NODE_ENV
    ;(process.env as Record<string, string>).NODE_ENV = 'production'
    let res: Awaited<ReturnType<typeof provisionEmailService>>
    try {
      res = await provisionEmailService({ userId: user.id, planId: plan.id, domain: `${domain}.com` })
    } finally {
      ;(process.env as Record<string, string | undefined>).NODE_ENV = prevEnv
    }
    expect(res.success).toBe(false)
    expect(res.error).toContain('Mail server not configured')
    const svc = await db.emailService.findUnique({ where: { domain: `${domain}.com` } })
    // Kept (not deleted) so it can be reconciled, and never marked active.
    expect(svc).not.toBeNull()
    expect(svc!.status).not.toBe('active')
    expect(svc!.lastError).toContain('Mail server not configured')
  })
})

// ── Orchestration hosting (a Docker-ready server exists from here on) ───────

describe('orchestration hosting step', () => {
  let serverId: string
  beforeAll(async () => {
    const s = await db.server.create({
      data: {
        name: uid('srv'), ip: '192.0.2.44', cpuCores: 2, ramGB: 8, storageGB: 80, bandwidthGB: 1000,
        status: 'active', dockerInstalled: true, healthStatus: 'healthy',
      },
    })
    serverId = s.id
  })
  afterAll(async () => {
    // Out of the selection for any later file.
    await db.server.update({ where: { id: serverId }, data: { status: 'offline' } })
    hooks.deploy = undefined
  })

  async function jobFor(domainName: string) {
    const domain = await db.domain.create({
      data: { userId: user.id, name: domainName, status: 'active', registrar: 'dynadot', provider: 'dynadot' },
    })
    const input = JSON.stringify({ domainName, stack: 'nodejs', includeHosting: true, includeEmail: false })
    return db.provisioningJob.create({
      data: {
        userId: user.id, domainName, stack: 'nodejs', includeHosting: true, includeEmail: false, status: 'pending',
        steps: {
          create: [
            { stepName: 'domain_register', stepOrder: 1, status: 'success', input, output: JSON.stringify({ domainId: domain.id, provider: 'dynadot' }) },
            { stepName: 'dns_configure', stepOrder: 2, status: 'success', input, output: JSON.stringify({ records: [] }) },
            { stepName: 'hosting_provision', stepOrder: 3, status: 'pending', input, maxAttempts: 3 },
            { stepName: 'email_provision', stepOrder: 4, status: 'skipped', input },
            { stepName: 'verify', stepOrder: 5, status: 'skipped', input },
          ],
        },
      },
    })
  }

  it('retrying a failed deploy reuses one project instead of creating one per attempt', async () => {
    let deploys = 0
    hooks.deploy = async (req: { deploymentId: string }) => {
      deploys++
      await db.deployment.update({ where: { id: req.deploymentId }, data: { status: 'failed' } })
      return { ok: false, error: 'mock deploy failure' }
    }
    const domainName = `${uid('retry')}.com`
    const job = await jobFor(domainName)
    await runProvisioningPipeline(job.id)
    expect(deploys).toBe(3)
    const projects = await db.project.findMany({ where: { userId: user.id, customDomain: domainName } })
    expect(projects.length).toBe(1)
    expect(await db.deployment.count({ where: { projectId: projects[0].id } })).toBe(3)
    expect(projects[0].serverId).toBe(serverId)
  }, 20000)

  it('example.com and example.net get different subdomains', async () => {
    hooks.deploy = async () => ({ ok: true, containerId: 'c1' })
    const base = uid('twin').toLowerCase()
    await runProvisioningPipeline((await jobFor(`${base}.com`)).id)
    await runProvisioningPipeline((await jobFor(`${base}.net`)).id)
    const a = await db.project.findFirstOrThrow({ where: { customDomain: `${base}.com` } })
    const b = await db.project.findFirstOrThrow({ where: { customDomain: `${base}.net` } })
    expect(a.subdomain).not.toBe(b.subdomain)
  })

  it('the pipeline refuses to register a domain the user does not hold, without calling the registrar', async () => {
    const before = registerDomainCalls
    const domainName = `${uid('unowned')}.com`
    const input = JSON.stringify({ domainName, stack: 'nodejs', includeHosting: false, includeEmail: false })
    const job = await db.provisioningJob.create({
      data: {
        userId: user.id, domainName, stack: 'nodejs', includeHosting: false, includeEmail: false, status: 'pending',
        steps: {
          create: [
            { stepName: 'domain_register', stepOrder: 1, status: 'pending', input, maxAttempts: 1 },
            { stepName: 'dns_configure', stepOrder: 2, status: 'pending', input },
            { stepName: 'hosting_provision', stepOrder: 3, status: 'skipped', input },
            { stepName: 'email_provision', stepOrder: 4, status: 'skipped', input },
            { stepName: 'verify', stepOrder: 5, status: 'skipped', input },
          ],
        },
      },
    })
    await runProvisioningPipeline(job.id).catch(() => undefined)
    const step = await db.provisioningStep.findFirstOrThrow({ where: { jobId: job.id, stepName: 'domain_register' } })
    expect(step.status).not.toBe('success')
    expect(registerDomainCalls).toBe(before)
    expect(await db.domain.count({ where: { name: domainName } })).toBe(0)
  })

  it('hosting provisioning reuses the project recorded on the payment after a crash', async () => {
    let deploys = 0
    hooks.deploy = async () => {
      deploys++
      return { ok: true }
    }
    const project = await makeProject(user.id, { status: 'creating', serverId })
    // A run that created the project and then died: lease expired.
    const p = await makePaid(user.id, { purchaseType: 'hosting', projectId: project.id }, {
      provisionStatus: 'provisioning', provisionAttempts: 1,
      provisionClaimedAt: new Date(Date.now() - 40 * MIN), provisionLeaseUntil: new Date(Date.now() - 10 * MIN),
    })
    const r = await provisionForPayment(p.id)
    expect(r.status).toBe('provisioned')
    expect(r.projectId).toBe(project.id)
    // Re-run after another crash: the payment's deployment exists, no second build.
    await db.payment.update({
      where: { id: p.id },
      data: { provisionStatus: 'provisioning', provisionLeaseUntil: new Date(Date.now() - MIN) },
    })
    expect((await provisionForPayment(p.id)).status).toBe('provisioned')
    expect(await db.deployment.count({ where: { projectId: project.id } })).toBe(1)
    expect(await db.project.count({ where: { userId: user.id, name: project.name } })).toBe(1)
    await new Promise((r) => setTimeout(r, 10))
    expect(deploys).toBe(1)
  })
})
