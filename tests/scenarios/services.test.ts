/**
 * The pipeline runner's command building, and the two background services
 * run as real processes against a stub panel:
 *   - worker: waits for the panel, never overlaps a task, retries failures soon
 *   - realtime: no login → refused; rooms only for users the panel allows
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { join } from 'node:path'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { io as ioClient } from 'socket.io-client'
import { resolveStage, buildStageCommand } from '@/lib/pipeline-runner'

const root = process.cwd()
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const children: Array<{ kill: () => void }> = []
afterAll(() => children.forEach((c) => c.kill()))

describe('pipeline runner', () => {
  it('reads both stored stage shapes', () => {
    expect(resolveStage({ name: 'b', type: 'build', order: 0, config: { command: 'npm run build' } }).command).toBe('npm run build')
    const s = resolveStage({ name: 't', type: 'test', order: 0, command: 'npm test', workingDir: '/', env: { NODE_ENV: 'test' }, timeout: 120, continueOnError: true })
    expect(s).toMatchObject({ command: 'npm test', workingDir: null, timeoutMs: 120_000, continueOnError: true, problem: null })
  })

  it('rejects path escapes and bad env names, clamps the timeout', () => {
    expect(resolveStage({ name: 'x', type: 'c', order: 0, command: 'ls', workingDir: '../etc' }).problem).toBeTruthy()
    expect(resolveStage({ name: 'x', type: 'c', order: 0, command: 'ls', env: { 'A;rm -rf /': '1' } }).problem).toBeTruthy()
    expect(resolveStage({ name: 'x', type: 'c', order: 0, command: 'ls', timeout: 999_999 }).timeoutMs).toBe(3_600_000)
  })

  const bash = Bun.which('bash')
  it.skipIf(!bash)('an env value cannot inject a shell command', () => {
    const evil = resolveStage({
      name: 'x', type: 'c', order: 0, command: 'echo "$GREETING"', workingDir: 'app',
      env: { GREETING: "hi'; touch PWNED; '" },
    })
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-'))
    const line = buildStageCommand(evil, { containerName: null, deployPath: dir.replace(/\\/g, '/') })
      .replace(/^cd [^&]+&&/, `mkdir -p app && cd app &&`)
    const out = Bun.spawnSync([bash!, '-c', line], { cwd: dir })
    expect(out.stdout.toString().trim()).toBe("hi'; touch PWNED; '")
    expect(existsSync(join(dir, 'PWNED')) || existsSync(join(dir, 'app', 'PWNED'))).toBe(false)
  })
})

describe('worker service', () => {
  it('waits for the panel, never overlaps a task, and retries failures soon', async () => {
    const hits: Record<string, number> = {}
    const inFlight: Record<string, number> = {}
    const maxInFlight: Record<string, number> = {}
    const panelPort = 39_000 + Math.floor(Math.random() * 500)
    const workerPort = panelPort + 600
    const worker = Bun.spawn(['bun', join(root, 'mini-services/worker-service/index.ts')], {
      env: { ...process.env, NEXT_API_BASE: `http://127.0.0.1:${panelPort}`, CRON_API_KEY: 'k', WORKER_PORT: String(workerPort) },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    children.push(worker)

    await wait(4000) // the panel is "starting": the worker must wait, not give up
    const panel = Bun.serve({
      port: panelPort,
      async fetch(req) {
        const p = new URL(req.url).pathname
        hits[p] = (hits[p] || 0) + 1
        inFlight[p] = (inFlight[p] || 0) + 1
        maxInFlight[p] = Math.max(maxInFlight[p] || 0, inFlight[p])
        try {
          if (p === '/api/admin/jobs/process') {
            await wait(14_000) // slower than its 10s interval
            return Response.json({ processed: 0 })
          }
          if (p === '/api/billing/sweep') return new Response('boom', { status: 500 })
          return Response.json({})
        } finally {
          inFlight[p]--
        }
      },
    })
    children.push({ kill: () => panel.stop(true) })

    // Billing starts ~12s after the panel answers; its first retry is 30s later.
    await wait(55_000)
    const health = await (await fetch(`http://127.0.0.1:${workerPort}/health`)).json()
    expect(maxInFlight['/api/admin/jobs/process']).toBe(1)
    expect(hits['/api/health/check']).toBeGreaterThanOrEqual(1)
    expect(hits['/api/cron/auto-deploy']).toBeGreaterThanOrEqual(1)
    expect(hits['/api/billing/sweep']).toBeGreaterThanOrEqual(2) // retried within seconds, not an hour
    expect(health.tasks.billing.consecutiveFailures).toBeGreaterThanOrEqual(2)
    worker.kill()
  }, 90_000)
})

describe('realtime service', () => {
  it('requires a login and only joins rooms the panel allows', async () => {
    const panelPort = 39_600 + Math.floor(Math.random() * 300)
    const panel = Bun.serve({
      port: panelPort,
      async fetch(req) {
        const token = (req.headers.get('authorization') || '').replace('Bearer ', '')
        const { room } = (await req.json()) as { room: string }
        if (token === 'expired') return Response.json({ ok: false }, { status: 401 })
        if (token === 'good' && room === 'deployment:A') return Response.json({ ok: true, userId: 'u1' })
        return Response.json({ ok: false }, { status: 403 })
      },
    })
    children.push({ kill: () => panel.stop(true) })
    const svc = Bun.spawn(['bun', join(root, 'mini-services/realtime-service/index.ts')], {
      env: { ...process.env, NEXT_API_BASE: `http://127.0.0.1:${panelPort}` },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    children.push(svc)
    await wait(2500)

    const connect = (token?: string) =>
      ioClient('http://127.0.0.1:3003', { transports: ['websocket'], reconnection: false, ...(token ? { auth: { token } } : {}) })
    const broadcast = (room: string) =>
      fetch('http://127.0.0.1:3004/api/broadcast', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room, event: 'deployment:log', data: { room } }) })

    const anon = connect()
    const anonResult = await new Promise<string>((r) => {
      anon.on('connect_error', (e) => r(e.message))
      anon.on('connect', () => r('connected'))
      setTimeout(() => r('timeout'), 4000)
    })
    anon.close()
    expect(anonResult).toBe('unauthorized')

    const good = connect('good')
    await new Promise((r) => good.on('connect', () => r(null)))
    const got: string[] = []
    const denied: string[] = []
    good.on('deployment:log', (d: { room: string }) => got.push(d.room))
    good.on('room-denied', (d: { room: string }) => denied.push(d.room))
    good.emit('join-room', 'deployment:A')
    good.emit('join-room', 'deployment:B')
    await wait(800)
    await broadcast('deployment:A')
    await broadcast('deployment:B')
    await wait(800)
    good.close()
    expect(got).toEqual(["deployment:A"])
    expect(denied).toEqual(['deployment:B'])

    const stale = connect('expired')
    await new Promise((r) => stale.on('connect', () => r(null)))
    const reason = new Promise<string>((r) => {
      stale.on('disconnect', (why) => r(why))
      setTimeout(() => r('still connected'), 4000)
    })
    stale.emit('join-room', 'deployment:A')
    expect(await reason).toBe('io server disconnect')
    svc.kill()
  }, 30_000)
})
