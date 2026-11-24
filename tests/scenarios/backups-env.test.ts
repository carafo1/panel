/**
 * Backups and environment variables:
 *   - backup downloads are streamed from disk (local mode) with the right
 *     headers, only for the project's own rows, and failed backups refused
 *   - default retention when the plan sets none, plan retention when it does,
 *     and the newest completed backup always survives
 *   - env var create/update/delete/import are audit-logged with key names
 *     only, never values
 *   - MAX_ENV_VARS is a per-project TOTAL, for single creates and imports
 *
 * No SSH, Docker or Drive is reached: the download project sits on a
 * localhost server with STORAGE_ROOT pointed at a temp dir, and the retention
 * projects have no server (deleteBackup only removes the row).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '@/lib/db'
import * as backupRoute from '@/app/api/hosting/[id]/backups/[backupId]/route'
import * as envRoute from '@/app/api/hosting/[id]/env/route'
import * as envVarRoute from '@/app/api/hosting/[id]/env/[varId]/route'
import { pruneBackups, DEFAULT_KEEP_MANUAL, DEFAULT_KEEP_PRE_DEPLOY } from '@/lib/vps/backups'
import { makeUser, makeProject, makePlan, authed, params, uid, DAY } from './helpers'

type U = Awaited<ReturnType<typeof makeUser>>
let owner: U
let other: U
let storage: string
const prevStorageRoot = process.env.STORAGE_ROOT

beforeAll(async () => {
  owner = await makeUser('be-owner')
  other = await makeUser('be-other')
  storage = mkdtempSync(join(tmpdir(), 'apsamo-backups-'))
  process.env.STORAGE_ROOT = storage
})

afterAll(() => {
  if (prevStorageRoot === undefined) delete process.env.STORAGE_ROOT
  else process.env.STORAGE_ROOT = prevStorageRoot
  try {
    rmSync(storage, { recursive: true, force: true })
  } catch {
    /* Windows may still hold a handle; the OS temp cleaner will get it */
  }
})

// ─── Streamed download ──────────────────────────────────────────────────

describe('backup download (local mode)', () => {
  let projectId: string
  let otherProjectId: string
  const payload = Buffer.alloc(256 * 1024 + 17)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff

  const get = (token: string | null, pid: string, backupId: string) =>
    backupRoute.GET(authed(token, `/api/hosting/${pid}/backups/${backupId}`), params({ id: pid, backupId }))

  async function makeBackupFile(pid: string, status = 'completed', filename = `${uid('2026-01-01T00-00-00-000Z')}.tar.gz`) {
    const dir = join(storage, 'backups', pid)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, filename), payload)
    return db.websiteBackup.create({ data: { projectId: pid, filename, sizeBytes: payload.length, status } })
  }

  beforeAll(async () => {
    const server = await db.server.create({
      data: { name: uid('be'), ip: '127.0.0.1', sshHost: 'localhost', cpuCores: 1, ramGB: 1, storageGB: 10, bandwidthGB: 100 },
    })
    projectId = (await makeProject(owner.id, { serverId: server.id })).id
    otherProjectId = (await makeProject(other.id, { serverId: server.id })).id
  })

  it('streams a partial backup from disk with download headers', async () => {
    const row = await makeBackupFile(projectId, 'partial')
    const res = await get(owner.token, projectId, row.id)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/gzip')
    expect(res.headers.get('content-length')).toBe(String(payload.length))
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${row.filename}"`)
    expect(res.headers.get('cache-control')).toContain('no-store')
    // A real stream, not a buffered body.
    expect(res.body).toBeInstanceOf(ReadableStream)
    const got = Buffer.from(await res.arrayBuffer())
    expect(got.length).toBe(payload.length)
    expect(got.equals(payload)).toBe(true)
  })

  it('requires a session', async () => {
    const row = await makeBackupFile(projectId)
    expect((await get(null, projectId, row.id)).status).toBe(401)
  })

  it("refuses another user's project, and a backup id from another project", async () => {
    const theirs = await makeBackupFile(otherProjectId)
    const denied = await get(owner.token, otherProjectId, theirs.id)
    expect([403, 404]).toContain(denied.status)
    // Own project in the URL, someone else's backup id: the row lookup is scoped.
    const crossed = await get(owner.token, projectId, theirs.id)
    expect(crossed.status).toBe(404)
  })

  it('refuses a failed backup with 409', async () => {
    const row = await db.websiteBackup.create({
      data: { projectId, filename: `${uid('failed')}.tar.gz`, status: 'failed' },
    })
    expect((await get(owner.token, projectId, row.id)).status).toBe(409)
  })

  it('never follows a path in the stored file name', async () => {
    const outside = join(storage, 'secret.txt')
    writeFileSync(outside, 'not a backup')
    const row = await db.websiteBackup.create({
      data: { projectId, filename: '../../secret.txt', status: 'completed' },
    })
    const res = await get(owner.token, projectId, row.id)
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('not a backup')
  })

  it('reports a missing archive as 404, not 500', async () => {
    const row = await db.websiteBackup.create({
      data: { projectId, filename: `${uid('gone')}.tar.gz`, status: 'completed' },
    })
    expect((await get(owner.token, projectId, row.id)).status).toBe(404)
  })
})

// ─── Retention ──────────────────────────────────────────────────────────

describe('backup retention', () => {
  const base = Date.now() - 100 * DAY

  async function seed(pid: string, specs: Array<{ type: string; status: string }>) {
    // Oldest first, one minute apart.
    const ids: string[] = []
    for (let i = 0; i < specs.length; i++) {
      const r = await db.websiteBackup.create({
        data: {
          projectId: pid,
          filename: `${uid('b')}.tar.gz`,
          type: specs[i].type,
          status: specs[i].status,
          createdAt: new Date(base + i * 60_000),
        },
      })
      ids.push(r.id)
    }
    return ids
  }

  it('with no plan setting, keeps the newest 10 manual + 5 pre-deploy', async () => {
    const u = await makeUser('be-ret')
    const p = await makeProject(u.id)
    const manual = await seed(p.id, Array.from({ length: 13 }, () => ({ type: 'manual', status: 'completed' })))
    const pre = await seed(p.id, Array.from({ length: 7 }, () => ({ type: 'pre-deploy', status: 'completed' })))

    const res = await pruneBackups(p.id)
    expect(res.policy).toBe('default')
    expect(res.deleted).toBe(13 - DEFAULT_KEEP_MANUAL + (7 - DEFAULT_KEEP_PRE_DEPLOY))

    const left = new Set((await db.websiteBackup.findMany({ where: { projectId: p.id } })).map((r) => r.id))
    expect(left.size).toBe(DEFAULT_KEEP_MANUAL + DEFAULT_KEEP_PRE_DEPLOY)
    // The oldest go, the newest stay.
    for (const id of manual.slice(0, 13 - DEFAULT_KEEP_MANUAL)) expect(left.has(id)).toBe(false)
    for (const id of manual.slice(13 - DEFAULT_KEEP_MANUAL)) expect(left.has(id)).toBe(true)
    for (const id of pre.slice(0, 7 - DEFAULT_KEEP_PRE_DEPLOY)) expect(left.has(id)).toBe(false)
    for (const id of pre.slice(7 - DEFAULT_KEEP_PRE_DEPLOY)) expect(left.has(id)).toBe(true)

    // Running it again changes nothing.
    expect((await pruneBackups(p.id)).deleted).toBe(0)
  })

  it('never deletes the newest completed backup, even when it is the oldest row', async () => {
    const u = await makeUser('be-ret2')
    const p = await makeProject(u.id)
    const [onlyCompleted, ...rest] = await seed(p.id, [
      { type: 'manual', status: 'completed' },
      ...Array.from({ length: 12 }, () => ({ type: 'manual', status: 'partial' })),
    ])
    const res = await pruneBackups(p.id)
    expect(res.deleted).toBe(2) // 13 rows, 10 allowed; the completed one is protected
    const left = new Set((await db.websiteBackup.findMany({ where: { projectId: p.id } })).map((r) => r.id))
    expect(left.has(onlyCompleted)).toBe(true)
    expect(left.has(rest[0])).toBe(false)
    expect(left.has(rest[1])).toBe(false)
    expect(left.has(rest[rest.length - 1])).toBe(true)
  })

  it("applies the plan's maxBackups when it is set, instead of the default", async () => {
    const u = await makeUser('be-ret3')
    const plan = await makePlan({ maxBackups: 3 })
    await db.subscription.create({
      data: {
        userId: u.id,
        planId: plan.id,
        status: 'active',
        currentPeriodStart: new Date(Date.now() - DAY),
        currentPeriodEnd: new Date(Date.now() + 29 * DAY),
      },
    })
    const p = await makeProject(u.id)
    const ids = await seed(p.id, Array.from({ length: 6 }, () => ({ type: 'manual', status: 'completed' })))
    const res = await pruneBackups(p.id).finally(() =>
      // The scenario files share one database: an active subscription left
      // here was renewed and suspended by the billing tests' far-future sweep,
      // which made them slow enough to time out.
      db.subscription.updateMany({ where: { userId: u.id }, data: { status: 'cancelled' } })
    )
    expect(res.policy).toBe('plan')
    expect(res.maxKept).toBe(3)
    expect(res.deleted).toBe(3)
    const left = (await db.websiteBackup.findMany({ where: { projectId: p.id } })).map((r) => r.id).sort()
    expect(left).toEqual(ids.slice(3).sort())
  })
})

// ─── Environment variables: audit + total cap ────────────────────────────

describe('environment variables', () => {
  const SECRET_A = 'sk_live_SUPERSECRET_value_A_9f8e7d'
  const SECRET_B = 'sk_live_SUPERSECRET_value_B_1a2b3c'
  const SECRET_C = 'import-secret-C-77aa'

  const post = (token: string | null, pid: string, body: unknown) =>
    envRoute.POST(authed(token, `/api/hosting/${pid}/env`, { method: 'POST', body: JSON.stringify(body) }), params({ id: pid }))

  it('audit-logs create, update, delete and import with key names only', async () => {
    const p = await makeProject(owner.id)

    const created = await post(owner.token, p.id, { key: 'API_TOKEN', value: SECRET_A })
    expect(created.status).toBe(201)
    const varId = (await created.json()).envVar.id as string

    const patched = await envVarRoute.PATCH(
      authed(owner.token, `/api/hosting/${p.id}/env/${varId}`, {
        method: 'PATCH',
        body: JSON.stringify({ key: 'API_KEY', value: SECRET_B }),
      }),
      params({ id: p.id, varId })
    )
    expect(patched.status).toBe(200)

    const imported = await post(owner.token, p.id, {
      action: 'import',
      content: `DATABASE_URL=${SECRET_C}\nAPI_KEY=${SECRET_A}\n`,
    })
    expect(imported.status).toBe(201)

    const removed = await envVarRoute.DELETE(
      authed(owner.token, `/api/hosting/${p.id}/env/${varId}`, { method: 'DELETE' }),
      params({ id: p.id, varId })
    )
    expect(removed.status).toBe(200)

    const logs = await db.auditLog.findMany({
      where: { resourceId: p.id, action: { startsWith: 'project.env.' } },
      orderBy: { createdAt: 'asc' },
    })
    const byAction = new Map(logs.map((l) => [l.action, JSON.parse(l.metadata)]))
    expect(byAction.get('project.env.create')).toMatchObject({ key: 'API_TOKEN' })
    expect(byAction.get('project.env.update')).toMatchObject({ key: 'API_KEY', previousKey: 'API_TOKEN', valueChanged: true })
    expect(byAction.get('project.env.import')).toMatchObject({ added: 1, updated: 1, addedKeys: ['DATABASE_URL'], updatedKeys: ['API_KEY'] })
    expect(byAction.get('project.env.delete')).toMatchObject({ key: 'API_KEY' })
    for (const l of logs) expect(l.userId).toBe(owner.id)

    const everything = logs.map((l) => l.metadata).join('\n')
    for (const secret of [SECRET_A, SECRET_B, SECRET_C, 'SUPERSECRET']) {
      expect(everything).not.toContain(secret)
    }
  })

  it('does not audit or write anything for another user', async () => {
    const p = await makeProject(owner.id)
    const res = await post(other.token, p.id, { key: 'X', value: 'y' })
    expect([403, 404]).toContain(res.status)
    expect(await db.environmentVariable.count({ where: { projectId: p.id } })).toBe(0)
    expect(await db.auditLog.count({ where: { resourceId: p.id, action: { startsWith: 'project.env.' } } })).toBe(0)
  })

  it('enforces 500 variables as a total per project', async () => {
    const p = await makeProject(owner.id)
    await db.environmentVariable.createMany({
      data: Array.from({ length: 498 }, (_, i) => ({ projectId: p.id, key: `K_${i}`, value: 'x', encrypted: false })),
    })

    // A single create up to the limit is fine...
    expect((await post(owner.token, p.id, { key: 'K_498', value: 'v' })).status).toBe(201)
    // ...an import that would cross it is refused whole, writing nothing.
    const tooMany = await post(owner.token, p.id, { action: 'import', content: 'NEW_1=a\nNEW_2=b\n' })
    expect(tooMany.status).toBe(400)
    expect(await db.environmentVariable.count({ where: { projectId: p.id } })).toBe(499)
    expect(await db.environmentVariable.count({ where: { projectId: p.id, key: 'NEW_1' } })).toBe(0)

    // An import that only overwrites existing keys does not grow the total.
    expect((await post(owner.token, p.id, { action: 'import', content: 'K_1=new\nK_2=new\n' })).status).toBe(201)

    expect((await post(owner.token, p.id, { key: 'K_499', value: 'v' })).status).toBe(201)
    const over = await post(owner.token, p.id, { key: 'K_500', value: 'v' })
    expect(over.status).toBe(400)
    expect((await over.json()).error).toContain('500')
    expect(await db.environmentVariable.count({ where: { projectId: p.id } })).toBe(500)
  })
})
