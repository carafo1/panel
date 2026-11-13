/**
 * Background automation: the job queue, outbound webhook retries, and uptime
 * alerts. Runs offline: a local HTTP server stands in for customer sites and
 * webhook receivers, and the SSRF guard (which rightly refuses localhost in
 * production) is replaced for this file only.
 */
import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test'
import * as realSsrf from '@/lib/ssrf'

mock.module('@/lib/ssrf', () => ({ ...realSsrf, assertPublicUrl: async () => {} }))

const { db } = await import('@/lib/db')
const { processPendingJobs } = await import('@/lib/worker')
const { emitWebhookEvent } = await import('@/lib/webhook-delivery')
const { runUptimeChecks } = await import('@/lib/monitor')
const { makeUser, makeProject } = await import('./helpers')

// A switchable local "site" and "webhook receiver".
let siteUp = true
let receiverUp = false
const received: unknown[] = []
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/site') return new Response('ok', { status: siteUp ? 200 : 503 })
    if (path === '/hook') {
      if (!receiverUp) return new Response('down', { status: 503 })
      received.push(await req.json())
      return new Response('ok')
    }
    return new Response('nope', { status: 404 })
  },
})
const base = `http://127.0.0.1:${server.port}`
afterAll(() => server.stop(true))

type U = Awaited<ReturnType<typeof makeUser>>
let user: U
let projectId: string
let hookId: string

beforeAll(async () => {
  // Jobs already queued by other test files must not run here.
  await db.jobQueue.updateMany({ where: { status: 'queued' }, data: { runAt: new Date(Date.now() + 365 * 86400000) } })
  user = await makeUser('automation')
  projectId = (await makeProject(user.id)).id
  hookId = (
    await db.webhook.create({
      data: {
        userId: user.id, name: 'receiver', url: `${base}/hook`, secret: 's', active: true,
        events: JSON.stringify(['deployment.failed', 'monitor.down', 'monitor.up']),
      },
    })
  ).id
})

const jobsFor = (hook: string) =>
  db.jobQueue.findMany({ where: { type: 'deliver_webhook', payload: { contains: hook } }, orderBy: { createdAt: 'asc' } })
const makeDue = (id: string) => db.jobQueue.update({ where: { id }, data: { runAt: new Date(Date.now() - 1000) } })

describe('outbound webhooks', () => {
  it('a failed delivery is queued for retry ~30s later', async () => {
    await emitWebhookEvent(user.id, 'deployment.failed', { project: { id: projectId } }, { projectId })
    const jobs = await jobsFor(hookId)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].runAt.getTime() - Date.now()).toBeGreaterThan(20_000)
  })

  it('an event the webhook is not subscribed to is not sent', async () => {
    const other = await db.webhook.create({
      data: { userId: user.id, name: 'payments only', url: `${base}/hook`, secret: 's', active: true, events: JSON.stringify(['payment.success']) },
    })
    await emitWebhookEvent(user.id, 'deployment.failed', {}, { projectId })
    expect(await jobsFor(other.id)).toHaveLength(0)
  })
})

describe('job queue', () => {
  it('overlapping ticks run a job once, then back off', async () => {
    const [job] = await jobsFor(hookId)
    await makeDue(job.id)
    await Promise.all([processPendingJobs(5), processPendingJobs(5)])
    const row = await db.jobQueue.findUniqueOrThrow({ where: { id: job.id } })
    expect(row.attempts).toBe(1)
    expect(row.status).toBe('queued')
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now() + 20_000)
  })

  it('a retry succeeds once the receiver is back', async () => {
    const [job] = await jobsFor(hookId)
    receiverUp = true
    await makeDue(job.id)
    await processPendingJobs(5)
    expect((await db.jobQueue.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('completed')
    expect(received.length).toBeGreaterThan(0)
    receiverUp = false
  })

  it('gives up after maxAttempts and marks the job failed', async () => {
    await emitWebhookEvent(user.id, 'deployment.failed', { n: 2 }, { projectId })
    const jobs = await jobsFor(hookId)
    const job = jobs[jobs.length - 1]
    for (let i = 0; i < job.maxAttempts + 1; i++) {
      await makeDue(job.id)
      await processPendingJobs(5)
    }
    const row = await db.jobQueue.findUniqueOrThrow({ where: { id: job.id } })
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(row.maxAttempts)
  })

  it('recovers a job stranded in processing by a restart', async () => {
    const stuck = await db.jobQueue.create({
      data: {
        type: 'deliver_webhook', payload: JSON.stringify({ webhookId: 'gone', event: 'x', body: {} }),
        status: 'processing', startedAt: new Date(Date.now() - 20 * 60_000), runAt: new Date(Date.now() - 20 * 60_000),
      },
    })
    await processPendingJobs(5)
    expect((await db.jobQueue.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe('completed')
  })
})

describe('uptime monitors', () => {
  let monitorId: string
  const stale = () => new Date(Date.now() - 120_000)

  beforeAll(async () => {
    monitorId = (
      await db.uptimeMonitor.create({
        data: { projectId, url: `${base}/site`, intervalSec: 60, lastStatus: 'up', lastCheckedAt: stale() },
      })
    ).id
  })
  const titles = async () => (await db.notification.findMany({ where: { userId: user.id }, select: { title: true } })).map((n) => n.title)

  it('skips a monitor whose interval has not elapsed', async () => {
    const fresh = await db.uptimeMonitor.create({
      data: { projectId, url: `${base}/site`, intervalSec: 300, lastStatus: 'up', lastCheckedAt: new Date() },
    })
    const before = fresh.lastCheckedAt!.getTime()
    await runUptimeChecks()
    expect((await db.uptimeMonitor.findUniqueOrThrow({ where: { id: fresh.id } })).lastCheckedAt!.getTime()).toBe(before)
  }, 30_000)

  it('detects an outage (after a confirming re-check) and alerts the owner once', async () => {
    siteUp = false
    await db.uptimeMonitor.update({ where: { id: monitorId }, data: { lastCheckedAt: stale() } })
    const r = await runUptimeChecks()
    expect(r.wentDown).toBeGreaterThanOrEqual(1)
    expect((await db.uptimeMonitor.findUniqueOrThrow({ where: { id: monitorId } })).lastStatus).toBe('down')
    expect((await titles()).filter((t) => t.endsWith('is down'))).toHaveLength(1)

    await db.uptimeMonitor.update({ where: { id: monitorId }, data: { lastCheckedAt: stale() } })
    await runUptimeChecks()
    expect((await titles()).filter((t) => t.endsWith('is down'))).toHaveLength(1)
  }, 30_000)

  it('detects recovery and tells the owner', async () => {
    siteUp = true
    await db.uptimeMonitor.update({ where: { id: monitorId }, data: { lastCheckedAt: stale() } })
    const r = await runUptimeChecks()
    expect(r.recovered).toBeGreaterThanOrEqual(1)
    expect((await titles()).some((t) => t.endsWith('is back up'))).toBe(true)
  }, 30_000)
})
