/**
 * Job queue failure handling: stuck-job recovery, attempt limits, permanent
 * failures, and recovery of provisioning pipelines interrupted by a restart.
 * Offline: a local HTTP server plays the webhook receiver, and the SSRF guard
 * (which rightly refuses localhost in production) is replaced for this file.
 */
import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test'
import * as realSsrf from '@/lib/ssrf'

mock.module('@/lib/ssrf', () => ({ ...realSsrf, assertPublicUrl: async () => {} }))

const { db } = await import('@/lib/db')
const { processPendingJobs, recoverStuckJobs } = await import('@/lib/worker')
const { createJob } = await import('@/lib/automation')
const { emitWebhookEvent } = await import('@/lib/webhook-delivery')
const { failStaleProvisioningJobs, runProvisioningPipeline } = await import('@/lib/orchestration')
const { makeUser, uid } = await import('./helpers')

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/gone') return new Response('gone', { status: 410 })
    if (path === '/busy') return new Response('slow down', { status: 429 })
    return new Response('nope', { status: 404 })
  },
})
const base = `http://127.0.0.1:${server.port}`
afterAll(() => server.stop(true))

const MIN = 60_000
const ago = (ms: number) => new Date(Date.now() - ms)
const row = (id: string) => db.jobQueue.findUniqueOrThrow({ where: { id } })

let userId: string

beforeAll(async () => {
  // Jobs already queued by other test files must not run here.
  await db.jobQueue.updateMany({
    where: { status: 'queued' },
    data: { runAt: new Date(Date.now() + 365 * 86400000) },
  })
  userId = (await makeUser('jobs')).id
})

describe('stuck-job recovery', () => {
  it('never resets a job that already completed', async () => {
    const done = await db.jobQueue.create({
      data: {
        type: 'deliver_webhook', payload: '{}', status: 'completed', attempts: 1,
        startedAt: ago(30 * MIN), completedAt: ago(29 * MIN), runAt: ago(30 * MIN),
      },
    })
    await recoverStuckJobs(10 * MIN)
    const r = await row(done.id)
    expect(r.status).toBe('completed')
    expect(r.startedAt).not.toBeNull()
  })

  it('a stuck job with attempts left is re-queued', async () => {
    const stuck = await db.jobQueue.create({
      data: {
        type: 'deliver_webhook', payload: '{}', status: 'processing', attempts: 1, maxAttempts: 3,
        startedAt: ago(30 * MIN), runAt: new Date(Date.now() + 365 * 86400000),
      },
    })
    await recoverStuckJobs(10 * MIN)
    const r = await row(stuck.id)
    expect(r.status).toBe('queued')
    expect(r.startedAt).toBeNull()
  })

  it('leaves a job that is still within the window alone', async () => {
    const running = await db.jobQueue.create({
      data: {
        type: 'deliver_webhook', payload: '{}', status: 'processing', attempts: 1,
        startedAt: ago(1 * MIN), runAt: ago(1 * MIN),
      },
    })
    await recoverStuckJobs(10 * MIN)
    expect((await row(running.id)).status).toBe('processing')
    await db.jobQueue.update({ where: { id: running.id }, data: { status: 'completed' } })
  })

  it('a stuck job at max attempts becomes failed instead of looping', async () => {
    const crashing = await db.jobQueue.create({
      data: {
        type: 'deliver_webhook', payload: '{}', status: 'processing', attempts: 3, maxAttempts: 3,
        startedAt: ago(30 * MIN), runAt: ago(30 * MIN),
      },
    })
    await recoverStuckJobs(10 * MIN)
    const r = await row(crashing.id)
    expect(r.status).toBe('failed')
    expect(r.attempts).toBe(3)
    expect(r.error).toContain('no attempts left')
  })

  it('the worker never claims a queued job whose attempts are used up', async () => {
    const exhausted = await db.jobQueue.create({
      data: {
        type: 'deliver_webhook', payload: '{}', status: 'queued', attempts: 3, maxAttempts: 3,
        runAt: ago(30 * MIN),
      },
    })
    await processPendingJobs(5)
    const r = await row(exhausted.id)
    expect(r.attempts).toBe(3) // not run again
    expect(r.status).toBe('failed')
  })
})

describe('permanent failures', () => {
  it('an unknown job type is failed, not completed, and not retried', async () => {
    const job = await createJob('no_such_job_type', { userId })
    await processPendingJobs(5)
    const r = await row(job.id)
    expect(r.status).toBe('failed')
    expect(r.attempts).toBe(1)
    expect(r.error).toContain('Unknown job type')
  })

  it('an unparsable payload is failed without retry', async () => {
    const job = await db.jobQueue.create({
      data: { type: 'deliver_webhook', payload: 'not json', status: 'queued', runAt: ago(1000) },
    })
    await processPendingJobs(5)
    const r = await row(job.id)
    expect(r.status).toBe('failed')
    expect(r.attempts).toBe(1)
  })

  it('deploy_template for a missing project is failed, not completed', async () => {
    const job = await createJob('deploy_template', { userId, projectId: 'does-not-exist' })
    await processPendingJobs(5)
    const r = await row(job.id)
    expect(r.status).toBe('failed')
    expect(r.attempts).toBe(1)
  })

  it('register_domain leaves a customer-owned (custom) domain pending', async () => {
    const domain = await db.domain.create({
      data: {
        userId, name: `${uid('own')}.example.test`, status: 'pending_verification',
        registrar: 'custom', provider: 'custom',
      },
    })
    const job = await createJob('register_domain', { userId, domainId: domain.id, provider: 'custom' })
    await processPendingJobs(5)
    expect((await row(job.id)).status).toBe('completed')
    const d = await db.domain.findUniqueOrThrow({ where: { id: domain.id } })
    expect(d.status).toBe('pending_verification')
    expect(d.expiresAt).toBeNull()
  })
})

describe('webhook delivery: permanent vs transient', () => {
  const hook = (path: string) =>
    db.webhook.create({
      data: {
        userId, name: path, url: `${base}${path}`, secret: 's', active: true,
        events: JSON.stringify(['deployment.failed']),
      },
    })
  const deliveryJob = (webhookId: string) =>
    db.jobQueue.create({
      data: {
        type: 'deliver_webhook', status: 'queued', maxAttempts: 5, runAt: ago(1000),
        payload: JSON.stringify({ webhookId, event: 'deployment.failed', body: { x: 1 }, userId }),
      },
    })

  it('a 4xx answer fails the job at once, without retry', async () => {
    const w = await hook('/gone')
    const job = await deliveryJob(w.id)
    await processPendingJobs(5)
    const r = await row(job.id)
    expect(r.status).toBe('failed')
    expect(r.attempts).toBe(1)
    expect(r.error).toContain('HTTP 410')
  })

  it('a 4xx on the first attempt is not queued for retry', async () => {
    const w = await hook('/gone')
    await emitWebhookEvent(userId, 'deployment.failed', { n: 1 })
    const queued = await db.jobQueue.findMany({
      where: { type: 'deliver_webhook', payload: { contains: w.id } },
    })
    expect(queued).toHaveLength(0)
  })

  it('429 is still retried with backoff', async () => {
    const w = await hook('/busy')
    const job = await deliveryJob(w.id)
    await processPendingJobs(5)
    const r = await row(job.id)
    expect(r.status).toBe('queued')
    expect(r.attempts).toBe(1)
    expect(r.runAt.getTime()).toBeGreaterThan(Date.now() + 20_000)
  })
})

describe('interrupted provisioning', () => {
  const makeJob = (status: string, at: Date) =>
    db.provisioningJob.create({
      data: {
        userId, domainName: `${uid('prov')}.example.test`, stack: 'nodejs', status,
        startedAt: status === 'running' ? at : null, createdAt: at, updatedAt: at,
        steps: {
          create: [
            { stepName: 'domain_register', stepOrder: 1, status: 'success', startedAt: at, lastAttemptAt: at },
            { stepName: 'dns_configure', stepOrder: 2, status: status === 'running' ? 'running' : 'pending', startedAt: status === 'running' ? at : null, lastAttemptAt: status === 'running' ? at : null },
          ],
        },
      },
    })

  it('a pipeline left running by a restart is marked failed by the worker tick', async () => {
    const stale = await makeJob('running', ago(3 * 60 * MIN))
    await processPendingJobs(5)
    const j = await db.provisioningJob.findUniqueOrThrow({ where: { id: stale.id }, include: { steps: true } })
    expect(j.status).toBe('failed')
    expect(j.errorCode).toBe('interrupted')
    expect(j.error).toContain('interrupted')
    const steps = Object.fromEntries(j.steps.map((s) => [s.stepName, s.status]))
    expect(steps.domain_register).toBe('success') // completed work is kept
    expect(steps.dns_configure).toBe('failed')
  })

  it('a running pipeline with recent activity is left alone and still refuses a second run', async () => {
    const fresh = await makeJob('running', ago(1 * MIN))
    expect(await failStaleProvisioningJobs()).toBeGreaterThanOrEqual(0)
    expect((await db.provisioningJob.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe('running')
    await expect(runProvisioningPipeline(fresh.id)).rejects.toThrow('already running')
  })

  it('a long step that keeps attempting is not mistaken for a dead run', async () => {
    const job = await makeJob('running', ago(3 * 60 * MIN))
    await db.provisioningStep.updateMany({
      where: { jobId: job.id, stepName: 'dns_configure' },
      data: { lastAttemptAt: ago(5 * MIN) },
    })
    await failStaleProvisioningJobs({ jobId: job.id })
    expect((await db.provisioningJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('running')
  })
})
