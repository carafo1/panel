/** Referral programme: sign-up attach, reward rules and abuse limits. */
import { describe, it, expect, beforeEach } from 'bun:test'
import { db } from '@/lib/db'
import { attachReferral, ensureReferralCode, qualifyReferral, saveReferralSettings } from '@/lib/referrals'
import { markInvoicePaid } from '@/lib/invoices'
import { applyCreditToInvoice } from '@/lib/credit'
import * as summary from '@/app/api/user/referrals/route'
import * as admin from '@/app/api/admin/referrals/route'
import { makeUser, authed, uid } from './helpers'

async function invoice(userId: string, total: number) {
  return db.invoice.create({ data: { userId, number: uid('INV'), total, subtotal: total, status: 'unpaid', items: '[]', dueDate: new Date() } as never })
}
const balance = async (id: string) => (await db.user.findUnique({ where: { id }, select: { creditBalance: true } }))!.creditBalance

describe('referrals', () => {
  beforeEach(async () => {
    const a = await makeUser('ref-settings-admin', 'admin')
    await saveReferralSettings({ enabled: true, referrerReward: 10, refereeReward: 5, minPayment: 5, monthlyCap: 2 }, a.id)
  })

  it('records a sign-up with a valid code and ignores bad or self codes', async () => {
    const referrer = await makeUser('ref-a')
    const code = await ensureReferralCode(referrer.id)
    expect(await ensureReferralCode(referrer.id)).toBe(code)
    const newbie = await makeUser('ref-b')
    expect(await attachReferral(newbie.id, code.toLowerCase())).toBe(true)
    expect(await attachReferral(newbie.id, code)).toBe(false) // only once
    expect(await attachReferral(referrer.id, code)).toBe(false) // not yourself
    const other = await makeUser('ref-c')
    expect(await attachReferral(other.id, 'NOPE!!')).toBe(false)
    expect(await attachReferral(other.id, 'ZZZZZZZZ')).toBe(false)
  })

  it('rewards both sides once, on the first real payment of a verified customer', async () => {
    const referrer = await makeUser('ref-pay-a')
    const newbie = await makeUser('ref-pay-b')
    await attachReferral(newbie.id, await ensureReferralCode(referrer.id))

    // Not verified yet: nothing happens.
    const inv1 = await invoice(newbie.id, 20)
    await markInvoicePaid(inv1.id, { gateway: 'stripe' })
    expect(await balance(referrer.id)).toBe(0)

    // Verifying later is enough (lib/email-verification re-checks), simulated here.
    await db.user.update({ where: { id: newbie.id }, data: { emailVerified: true } })
    await qualifyReferral(newbie.id, 20)
    expect(await balance(referrer.id)).toBe(10)
    expect(await balance(newbie.id)).toBe(5)

    // A second payment pays nothing more.
    const inv2 = await invoice(newbie.id, 50)
    await markInvoicePaid(inv2.id, { gateway: 'stripe' })
    expect(await balance(referrer.id)).toBe(10)
    const r = await db.referral.findUnique({ where: { referredUserId: newbie.id } })
    expect(r?.status).toBe('rewarded')
  })

  it('ignores payments below the minimum and invoices paid entirely with credit', async () => {
    const referrer = await makeUser('ref-min-a')
    const newbie = await makeUser('ref-min-b')
    await db.user.update({ where: { id: newbie.id }, data: { emailVerified: true, creditBalance: 100 } })
    await attachReferral(newbie.id, await ensureReferralCode(referrer.id))

    const small = await invoice(newbie.id, 2)
    await markInvoicePaid(small.id, { gateway: 'stripe' })
    expect(await balance(referrer.id)).toBe(0)

    const byCredit = await invoice(newbie.id, 30)
    await applyCreditToInvoice({ userId: newbie.id, invoiceId: byCredit.id } as never)
    expect(await balance(referrer.id)).toBe(0)
    expect((await db.referral.findUnique({ where: { referredUserId: newbie.id } }))?.status).toBe('signed_up')
  })

  it('stops rewarding a referrer after the monthly cap', async () => {
    const referrer = await makeUser('ref-cap-a')
    const code = await ensureReferralCode(referrer.id)
    for (let i = 0; i < 3; i++) {
      const n = await makeUser(`ref-cap-${i}`)
      await db.user.update({ where: { id: n.id }, data: { emailVerified: true } })
      await attachReferral(n.id, code)
      await markInvoicePaid((await invoice(n.id, 10)).id, { gateway: 'stripe' })
    }
    expect(await balance(referrer.id)).toBe(20)
    const capped = await db.referral.findFirst({ where: { referrerId: referrer.id, status: 'not_rewarded' } })
    expect(capped?.note).toMatch(/Monthly limit/)
  })

  it('shows customers masked emails only; settings are admin-only', async () => {
    const referrer = await makeUser('ref-view-a')
    const n = await makeUser('ref-view-b')
    await attachReferral(n.id, await ensureReferralCode(referrer.id))
    const s = await (await summary.GET(authed(referrer.token, '/api/user/referrals'))).json()
    expect(s.link).toContain(`?ref=${s.code}`)
    expect(s.referrals[0].who).not.toBe(n.email)
    expect(s.referrals[0].who).toContain('@example.test')
    expect((await admin.PUT(authed(referrer.token, '/api/admin/referrals', { method: 'PUT', body: '{}' }))).status).toBe(403)
    const a = await makeUser('ref-view-admin', 'admin')
    expect((await admin.PUT(authed(a.token, '/api/admin/referrals', { method: 'PUT', body: JSON.stringify({ referrerReward: -1 }) }))).status).toBe(400)
  })
})
