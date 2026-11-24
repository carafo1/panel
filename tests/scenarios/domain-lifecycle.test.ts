/**
 * Domain lifecycle safety, through the real checkout/fulfilment/pipeline code
 * against the scenario SQLite database. The registrar is stubbed on the
 * dynadotService singleton: nothing here reaches Dynadot or any network.
 *
 *   - pricing: no price row / inactive TLD → not sellable; premium refused
 *   - a deleted Domain row re-bought by someone else lands in THEIR account
 *   - registrarCalledAt without confirmation → manual_review, no second call
 *   - unknown registrar outcome → manual_review; definite refusal → failed
 *   - 'failed' is not re-claimed; 'retry_pending' is
 *   - transfer EPP code encrypted at rest, cleared once accepted;
 *     transfer order stays transfer_pending (not completed)
 *   - legacy simulated automation actions fail permanently
 */
import { describe, it, expect, beforeAll, afterEach, spyOn } from 'bun:test'
import { db } from '@/lib/db'
import { dynadotService } from '@/lib/dynadot-service'
import { RegistrarUnknownOutcomeError } from '@/lib/dynadot'
import { getPriceForDomain, getPriceForTld } from '@/lib/pricing'
import {
  quoteDomainOrder,
  createDomainOrder,
  fulfilDomainOrder,
  readOrderAuthCode,
} from '@/lib/domain-checkout'
import { runRegistrationPipeline } from '@/lib/domain-automation'
import { createJob, processJob, RETIRED_ACTIONS } from '@/lib/automation'
import { getPaymentMethod } from '@/lib/payment-methods'
import { makeUser, makeProject, uid } from './helpers'

const ON = '.hzon'
const OFF = '.hzoff'
const NONE = '.hznone'
const EXPIRY = '2027-05-05T00:00:00.000Z'

const REGISTRANT = {
  firstName: 'Test', lastName: 'Buyer', email: 'buyer@example.test', phone: '+252612345678',
  address1: '1 Main St', city: 'Mogadishu', postalCode: '00000', country: 'SO',
}

// ─── registrar stubs ─────────────────────────────────────────────────────────

const spies: Array<{ mockRestore(): void }> = []
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stub(name: keyof typeof dynadotService, impl: (...args: any[]) => unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = spyOn(dynadotService as any, name as string).mockImplementation(impl as any)
  spies.push(s)
  return s
}

/** A registrar that answers "available" and accepts everything. */
function happyRegistrar() {
  return {
    search: stub('search', async (d: string) => ({ domain: d, available: true, premium: false, status: 'available' })),
    register: stub('register', async (d: string) => ({ success: true, orderId: 'DYN-REG-1', domain: d })),
    renew: stub('renew', async () => ({ success: true, orderId: 'DYN-REN-1' })),
    transfer: stub('transfer', async () => ({ success: true, orderId: 'DYN-TR-1', message: 'Transfer initiated' })),
    setNameservers: stub('setNameservers', async () => ({ success: true })),
    setDnsRecords: stub('setDnsRecords', async () => ({ success: true, written: 0 })),
    getDomainInfo: stub('getDomainInfo', async (d: string) => ({
      domain: d, status: 'active', expiry: EXPIRY, nameservers: [], locked: true,
      whoisPrivacy: true, autoRenew: true, premium: false,
    })),
  }
}

async function makeOrder(userId: string, domainName: string, extra: Record<string, unknown> = {}) {
  return db.domainOrder.create({
    data: {
      userId, domainName, type: 'register', duration: 1, status: 'pending_payment',
      unitPrice: 16.5, totalAmount: 16.5, provider: 'dynadot',
      metadata: JSON.stringify({ registrant: REGISTRANT }),
      ...extra,
    },
  })
}

beforeAll(async () => {
  await db.domainPrice.deleteMany({ where: { tld: { in: [ON, OFF, NONE] } } })
  const row = (tld: string, active: boolean) => ({
    tld, wholesale: 10, markup: 6.5, registration: 16.5, renewal: 16.5, transfer: 16.5, currency: 'USD', active,
  })
  await db.domainPrice.create({ data: row(ON, true) })
  await db.domainPrice.create({ data: row(OFF, false) })
  // Manual (bank transfer) payment: creates a pending Payment row, no gateway.
  await getPaymentMethod('manual')
  await db.paymentMethodSetting.updateMany({ where: { method: 'manual' }, data: { active: true } })
})

// ─── F5: pricing ─────────────────────────────────────────────────────────────

describe('pricing: only active, priced TLDs are sellable', () => {
  it('no price row → null (no invented catalogue price)', async () => {
    expect(await getPriceForDomain(`x${NONE}`)).toBeNull()
    expect(await getPriceForTld(NONE)).toBeNull()
    expect(await quoteDomainOrder(`x${NONE}`, 'register', 1)).toBeNull()
  })

  it('inactive TLD → not sellable (admins can still read the row)', async () => {
    expect(await getPriceForDomain(`x${OFF}`)).toBeNull()
    expect(await quoteDomainOrder(`x${OFF}`, 'register', 1)).toBeNull()
    expect((await getPriceForTld(OFF))?.active).toBe(false)
  })

  it('active TLD → selling price', async () => {
    const p = await getPriceForDomain(`x${ON}`)
    expect(p?.registration).toBeGreaterThan(0)
    expect((await quoteDomainOrder(`x${ON}`, 'register', 2))?.years).toBe(2)
  })

  it('checkout refuses a premium domain and creates no order', async () => {
    const u = await makeUser('prem')
    stub('search', async (d: string) => ({ domain: d, available: true, premium: true, status: 'premium' }))
    const name = `${uid('gold')}${ON}`
    const r = await createDomainOrder({
      userId: u.id, email: u.email, domain: name, years: 1, kind: 'register', method: 'manual', registrant: REGISTRANT,
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/premium/i)
    expect(await db.domainOrder.count({ where: { domainName: name } })).toBe(0)
  })

  it('checkout refuses when availability is unknown', async () => {
    const u = await makeUser('unk')
    stub('search', async (d: string) => ({ domain: d, available: false, premium: false, status: 'unknown' }))
    const r = await createDomainOrder({
      userId: u.id, email: u.email, domain: `${uid('q')}${ON}`, years: 1, kind: 'register', method: 'manual', registrant: REGISTRANT,
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/confirm availability/i)
  })

  it('checkout refuses an inactive TLD', async () => {
    const u = await makeUser('off')
    stub('search', async (d: string) => ({ domain: d, available: true, premium: false, status: 'available' }))
    const r = await createDomainOrder({
      userId: u.id, email: u.email, domain: `${uid('q')}${OFF}`, years: 1, kind: 'register', method: 'manual', registrant: REGISTRANT,
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/do not currently sell/i)
  })
})

// ─── F6: deleted row re-bought ───────────────────────────────────────────────

describe('re-buying a deleted domain row', () => {
  it('moves the domain to the new buyer, with none of the old owner’s data', async () => {
    const oldOwner = await makeUser('old-owner')
    const buyer = await makeUser('new-buyer')
    const project = await makeProject(oldOwner.id)
    const name = `${uid('reb')}${ON}`
    await db.project.update({ where: { id: project.id }, data: { customDomain: name } })
    const row = await db.domain.create({
      data: {
        userId: oldOwner.id, projectId: project.id, name, status: 'deleted',
        registrar: 'dynadot', provider: 'dynadot', emailHosted: true, mailcowDomainId: 'mc-old',
      },
    })
    await db.dnsRecord.create({ data: { domainId: row.id, type: 'A', name: '@', value: '203.0.113.99', ttl: 3600 } })

    happyRegistrar()
    const r = await runRegistrationPipeline({ userId: buyer.id, domain: name, duration: 1 })
    expect(r.success).toBe(true)

    const d = await db.domain.findUniqueOrThrow({ where: { name } })
    expect(d.id).toBe(row.id)
    expect(d.userId).toBe(buyer.id)
    expect(d.projectId).toBeNull()
    expect(d.emailHosted).toBe(false)
    expect(d.mailcowDomainId).toBeNull()
    expect(d.status).toBe('active')
    expect(d.expiresAt?.toISOString()).toBe(EXPIRY) // read back from the registrar
    expect(await db.dnsRecord.count({ where: { domainId: row.id, value: '203.0.113.99' } })).toBe(0)
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).customDomain).toBeNull()
  })

  it('refuses (before calling the registrar) a domain held by another live account', async () => {
    const owner = await makeUser('holder')
    const other = await makeUser('grabber')
    const name = `${uid('held')}${ON}`
    await db.domain.create({ data: { userId: owner.id, name, status: 'active', registrar: 'dynadot', provider: 'dynadot' } })
    const reg = happyRegistrar()
    const r = await runRegistrationPipeline({ userId: other.id, domain: name, duration: 1 })
    expect(r.success).toBe(false)
    expect(reg.register).not.toHaveBeenCalled()
    expect((await db.domain.findUniqueOrThrow({ where: { name } })).userId).toBe(owner.id)
  })

  it('stores null (not an invented date) when the registrar expiry cannot be read', async () => {
    const buyer = await makeUser('noexp')
    const name = `${uid('noexp')}${ON}`
    happyRegistrar()
    stub('getDomainInfo', async () => { throw new Error('registrar down') })
    const r = await runRegistrationPipeline({ userId: buyer.id, domain: name, duration: 3 })
    expect(r.success).toBe(true)
    expect(r.expiryUnknown).toBe(true)
    expect((await db.domain.findUniqueOrThrow({ where: { name } })).expiresAt).toBeNull()
  })
})

// ─── F10: exactly-once registrar calls ───────────────────────────────────────

describe('fulfilment never calls the registrar twice', () => {
  it('registrarCalledAt without confirmation → manual_review and no registrar call', async () => {
    const u = await makeUser('called')
    const order = await makeOrder(u.id, `${uid('called')}${ON}`, { registrarCalledAt: new Date() })
    const reg = happyRegistrar()
    const r = await fulfilDomainOrder(order.id)
    expect(r.success).toBe(false)
    expect(reg.register).not.toHaveBeenCalled()
    expect(reg.search).not.toHaveBeenCalled()
    expect((await db.domainOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('manual_review')
  })

  it('unknown registrar outcome → manual_review, and a replay does not call again', async () => {
    const u = await makeUser('unknown')
    const order = await makeOrder(u.id, `${uid('unk')}${ON}`)
    const reg = happyRegistrar()
    reg.register.mockImplementation((async () => {
      throw new RegistrarUnknownOutcomeError('register', 'network/timeout: socket hang up')
    }) as never)

    const r1 = await fulfilDomainOrder(order.id)
    expect(r1.success).toBe(false)
    let o = await db.domainOrder.findUniqueOrThrow({ where: { id: order.id } })
    expect(o.status).toBe('manual_review')
    expect(o.registrarCalledAt).not.toBeNull()
    expect(o.registrarConfirmedAt).toBeNull()

    // Even if something moved it back to a claimable state, it is not re-sent.
    await db.domainOrder.update({ where: { id: order.id }, data: { status: 'retry_pending' } })
    await fulfilDomainOrder(order.id)
    o = await db.domainOrder.findUniqueOrThrow({ where: { id: order.id } })
    expect(o.status).toBe('manual_review')
    expect(reg.register).toHaveBeenCalledTimes(1)
  })

  it('a definite refusal → failed, registrarCalledAt released; failed is not re-claimed', async () => {
    const u = await makeUser('refused')
    const order = await makeOrder(u.id, `${uid('ref')}${ON}`)
    const reg = happyRegistrar()
    reg.register.mockImplementation((async () => ({ success: false, error: 'not available' })) as never)

    await fulfilDomainOrder(order.id)
    const o = await db.domainOrder.findUniqueOrThrow({ where: { id: order.id } })
    expect(o.status).toBe('failed')
    expect(o.registrarCalledAt).toBeNull()

    const again = await fulfilDomainOrder(order.id)
    expect(again.success).toBe(false)
    expect(reg.register).toHaveBeenCalledTimes(1)
  })

  it('retry_pending is claimed and completes, recording the confirmation', async () => {
    const u = await makeUser('retry')
    const order = await makeOrder(u.id, `${uid('retry')}${ON}`, { status: 'retry_pending' })
    const reg = happyRegistrar()
    const r = await fulfilDomainOrder(order.id)
    expect(r.success).toBe(true)
    const o = await db.domainOrder.findUniqueOrThrow({ where: { id: order.id } })
    expect(o.status).toBe('completed')
    expect(o.registrarCalledAt).not.toBeNull()
    expect(o.registrarConfirmedAt).not.toBeNull()
    expect(o.providerOrderId).toBe('DYN-REG-1')
    expect(reg.register).toHaveBeenCalledTimes(1)
    // Replay of the payment confirmation: idempotent, no second purchase.
    expect((await fulfilDomainOrder(order.id)).alreadyFulfilled).toBe(true)
    expect(reg.register).toHaveBeenCalledTimes(1)
  })
})

// ─── F11: transfers ──────────────────────────────────────────────────────────

describe('transfer orders', () => {
  it('EPP code is encrypted at rest, cleared once accepted; order stays transfer_pending', async () => {
    const u = await makeUser('xfer')
    const name = `${uid('xfer')}${ON}`
    const EPP = 'EPP-Secret-Code-12345'
    const created = await createDomainOrder({
      userId: u.id, email: u.email, domain: name, years: 1, kind: 'transfer', method: 'manual',
      registrant: REGISTRANT, authCode: EPP,
    })
    expect(created.success).toBe(true)

    const stored = await db.domainOrder.findUniqueOrThrow({ where: { id: created.orderId! } })
    expect(stored.metadata || '').not.toContain(EPP)
    expect(readOrderAuthCode(JSON.parse(stored.metadata || '{}'))).toBe(EPP)

    const reg = happyRegistrar()
    const r = await fulfilDomainOrder(created.orderId!)
    expect(r.success).toBe(true)
    expect(reg.transfer).toHaveBeenCalledWith(name, EPP)

    const after = await db.domainOrder.findUniqueOrThrow({ where: { id: created.orderId! } })
    expect(after.status).toBe('transfer_pending')
    expect(after.registrarConfirmedAt).not.toBeNull()
    const meta = JSON.parse(after.metadata || '{}')
    expect(meta.authCodeEnc).toBeUndefined()
    expect(meta.authCode).toBeUndefined()

    const d = await db.domain.findUniqueOrThrow({ where: { name } })
    expect(d.userId).toBe(u.id)
    expect(d.status).toBe('transferring')
    expect(d.expiresAt).toBeNull() // not invented

    // Replay: no second transfer request.
    expect((await fulfilDomainOrder(created.orderId!)).alreadyFulfilled).toBe(true)
    expect(reg.transfer).toHaveBeenCalledTimes(1)
  })

  it('refuses to start a transfer for a domain in another account', async () => {
    const owner = await makeUser('xowner')
    const other = await makeUser('xother')
    const name = `${uid('xheld')}${ON}`
    await db.domain.create({ data: { userId: owner.id, name, status: 'active', registrar: 'dynadot', provider: 'dynadot' } })
    const r = await createDomainOrder({
      userId: other.id, email: other.email, domain: name, years: 1, kind: 'transfer', method: 'manual',
      registrant: REGISTRANT, authCode: 'EPP',
    })
    expect(r.success).toBe(false)
  })
})

// ─── ITEM5: legacy simulated automation ──────────────────────────────────────

describe('retired simulated automation actions', () => {
  it('every retired action fails permanently and fabricates nothing', async () => {
    const u = await makeUser('legacy')
    const project = await makeProject(u.id, { status: 'stopped', sslEnabled: false })
    const domain = await db.domain.create({
      data: { userId: u.id, name: `${uid('leg')}${ON}`, status: 'pending', registrar: 'dynadot', provider: 'dynadot' },
    })
    const before = await db.notification.count({ where: { userId: u.id } })

    for (const type of RETIRED_ACTIONS) {
      const job = await createJob(type, { userId: u.id, projectId: project.id, domainId: domain.id, provider: 'dynadot' })
      await processJob(job.id)
      const row = await db.jobQueue.findUniqueOrThrow({ where: { id: job.id } })
      expect(row.status).toBe('failed')
      expect(row.attempts).toBe(1) // no retry
      expect(row.result).toBeNull()
    }

    expect(await db.notification.count({ where: { userId: u.id } })).toBe(before)
    const p = await db.project.findUniqueOrThrow({ where: { id: project.id } })
    expect(p.status).toBe('stopped')
    expect(p.sslEnabled).toBe(false)
    const d = await db.domain.findUniqueOrThrow({ where: { id: domain.id } })
    expect(d.status).toBe('pending')
    expect(d.expiresAt).toBeNull()
    expect(await db.dnsRecord.count({ where: { domainId: domain.id } })).toBe(0)
  })
})
