/**
 * Billing enforcement end to end: renewal, overdue, suspension, payment, and
 * the read-only preview that `apsamo update` relies on.
 *
 * Guards the bug where renewal set an unpaid subscription back to 'active'
 * every period, so a customer who never paid was never suspended.
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '@/lib/db'
import { runAutoRenewals } from '@/lib/renewals'
import { markInvoicePaid } from '@/lib/invoices'
import { previewEnforcement } from '@/lib/billing-enforcement'
import { POST as sweepPOST, GET as sweepGET } from '@/app/api/billing/sweep/route'
import { makeUser, makeProject, makePlan, DAY, uid } from './helpers'

const cron = () => ({ 'x-cron-key': process.env.CRON_API_KEY! })
const sweep = async () =>
  (await sweepPOST(new Request('http://localhost/api/billing/sweep', { method: 'POST', headers: cron() }))).json()
const subStatus = async (id: string) => (await db.subscription.findUniqueOrThrow({ where: { id } })).status

describe('unpaid renewal → past due → suspended → paid → restored', () => {
  let subId: string
  let projectId: string
  let invoiceId: string

  beforeAll(async () => {
    const plan = await makePlan()
    const owner = await makeUser('billing-owner')
    const now = Date.now()
    const sub = await db.subscription.create({
      data: {
        userId: owner.id, planId: plan.id, status: 'active', autoRenew: true,
        currentPeriodStart: new Date(now - 31 * DAY), currentPeriodEnd: new Date(now - DAY),
      },
    })
    subId = sub.id
    projectId = (await makeProject(owner.id, { deployPath: '/opt/x' })).id
  })

  it('raises a renewal invoice and keeps the service on during the payment window', async () => {
    await runAutoRenewals()
    const inv = await db.invoice.findFirst({ where: { subscriptionId: subId } })
    expect(inv?.status).toBe('unpaid')
    invoiceId = inv!.id
    expect(await subStatus(subId)).toBe('active')
  })

  it('does not renew again while that invoice is unpaid', async () => {
    await db.subscription.update({ where: { id: subId }, data: { currentPeriodEnd: new Date(Date.now() - DAY) } })
    await runAutoRenewals()
    expect(await db.invoice.count({ where: { subscriptionId: subId } })).toBe(1)
    await db.subscription.update({ where: { id: subId }, data: { currentPeriodEnd: new Date(Date.now() + 20 * DAY) } })
  })

  it('marks the subscription past due once the invoice is overdue, and tells the customer', async () => {
    await db.invoice.update({ where: { id: invoiceId }, data: { dueDate: new Date(Date.now() - DAY) } })
    await sweep()
    expect(await subStatus(subId)).toBe('past_due')
    const sub = await db.subscription.findUniqueOrThrow({ where: { id: subId } })
    expect(await db.notification.count({ where: { userId: sub.userId, title: 'Invoice Overdue' } })).toBe(1)
  })

  it('suspends after the grace period and takes the website offline', async () => {
    await db.invoice.update({ where: { id: invoiceId }, data: { dueDate: new Date(Date.now() - 8 * DAY) } })
    await sweep()
    expect(await subStatus(subId)).toBe('suspended')
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('suspended')
  })

  it('stays suspended on later sweeps', async () => {
    await runAutoRenewals()
    await sweep()
    expect(await subStatus(subId)).toBe('suspended')
  })

  it('reactivates on payment and queues the website rebuild', async () => {
    await markInvoicePaid(invoiceId, { gateway: 'manual', reference: 'test' })
    expect(await subStatus(subId)).toBe('active')
    const rebuild = await db.deployment.findFirst({ where: { projectId, commit: { startsWith: 'reinstate-' } } })
    expect(rebuild).not.toBeNull()
  })
})

describe('billing preview', () => {
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    const plan = await makePlan()
    const now = Date.now()
    const customer = async (
      tag: string,
      sub: Record<string, unknown>,
      invoiceDue?: Date
    ) => {
      const user = await makeUser(tag)
      const s = await db.subscription.create({ data: { userId: user.id, planId: plan.id, autoRenew: true, ...sub } as never })
      if (invoiceDue) {
        await db.invoice.create({
          data: {
            number: uid('PV'), userId: user.id, subscriptionId: s.id, items: '[]', subtotal: 12, total: 12,
            currency: 'USD', status: 'unpaid', periodStart: new Date(now - 5 * DAY), dueDate: invoiceDue,
          },
        })
      }
      await makeProject(user.id)
      ids[tag] = s.id
    }
    await customer('healthy', { status: 'active', currentPeriodStart: new Date(now - 10 * DAY), currentPeriodEnd: new Date(now + 20 * DAY) })
    await customer('renew', { status: 'active', currentPeriodStart: new Date(now - 31 * DAY), currentPeriodEnd: new Date(now - DAY) })
    await customer('overdue', { status: 'active', currentPeriodStart: new Date(now - 3 * DAY), currentPeriodEnd: new Date(now + 27 * DAY) }, new Date(now - 2 * DAY))
    await customer('longOverdue', { status: 'past_due', currentPeriodStart: new Date(now - 12 * DAY), currentPeriodEnd: new Date(now + 18 * DAY) }, new Date(now - 9 * DAY))
    await customer('cancelled', { status: 'active', cancelAtPeriodEnd: true, currentPeriodStart: new Date(now - 31 * DAY), currentPeriodEnd: new Date(now - DAY) })
    await customer('noRenew', { status: 'active', autoRenew: false, currentPeriodStart: new Date(now - 31 * DAY), currentPeriodEnd: new Date(now - DAY) })
  })

  const actionFor = (rows: Awaited<ReturnType<typeof previewEnforcement>>, tag: string) =>
    rows.find((r) => r.subscriptionId === ids[tag])?.action ?? 'none'

  it('changes nothing', async () => {
    const snapshot = async () =>
      JSON.stringify(await db.subscription.findMany({ where: { id: { in: Object.values(ids) } }, select: { id: true, status: true }, orderBy: { id: 'asc' } })) +
      (await db.invoice.count())
    const before = await snapshot()
    await previewEnforcement()
    await sweepGET(new Request('http://localhost/api/billing/sweep', { headers: cron() }))
    expect(await snapshot()).toBe(before)
  })

  it('predicts exactly what the sweep then does', async () => {
    const rows = await previewEnforcement()
    expect(actionFor(rows, 'healthy')).toBe('none')
    expect(actionFor(rows, 'renew')).toBe('renew')
    expect(actionFor(rows, 'overdue')).toBe('past_due')
    expect(actionFor(rows, 'longOverdue')).toBe('suspend')
    expect(actionFor(rows, 'cancelled')).toBe('end_cancelled')
    expect(actionFor(rows, 'noRenew')).toBe('past_due')
    expect(rows.find((r) => r.subscriptionId === ids.longOverdue)?.websitesAffected).toBe(1)

    await sweep()
    expect(await subStatus(ids.healthy)).toBe('active')
    expect(await subStatus(ids.renew)).toBe('active')
    expect(await db.invoice.count({ where: { subscriptionId: ids.renew } })).toBe(1)
    expect(await subStatus(ids.overdue)).toBe('past_due')
    expect(await subStatus(ids.longOverdue)).toBe('suspended')
    expect(await subStatus(ids.cancelled)).toBe('cancelled')
    expect(await subStatus(ids.noRenew)).toBe('past_due')
  })
})
