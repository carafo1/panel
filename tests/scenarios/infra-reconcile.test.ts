/**
 * Infrastructure reconciliation (src/lib/infra-reconcile.ts): containers,
 * certificates and registrar state compared with the database.
 *
 * Docker, the TLS probe and Dynadot are all injected fakes — nothing here
 * reaches a server or the registrar. Other scenario files share the database,
 * so assertions only look at the rows this file creates.
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '@/lib/db'
import {
  checkContainers,
  checkCertificates,
  checkRegistrar,
  findContainer,
  runInfraReconcile,
  lastInfraReport,
  type ContainerRow,
} from '@/lib/infra-reconcile'
import { makeUser, makeProject, uid } from './helpers'

const DAY = 24 * 60 * 60 * 1000
let userId: string
let serverId: string
let otherServerId: string
const p: Record<string, string> = {}

beforeAll(async () => {
  userId = (await makeUser('infra')).id
  const mk = (name: string) =>
    db.server.create({
      data: { name: uid(name), ip: '127.0.0.1', sshHost: 'localhost', cpuCores: 1, ramGB: 1, storageGB: 10, bandwidthGB: 100 },
    })
  serverId = (await mk('infra-a')).id
  otherServerId = (await mk('infra-b')).id
  const site = async (key: string, extra: Record<string, unknown>) => {
    p[key] = (await makeProject(userId, { serverId, ...extra })).id
  }
  await site('healthy', { containerName: uid('dh-healthy') })
  await site('byId', { containerId: 'abcdef1234567890' })
  await site('compose', { containerName: uid('dh-wp') })
  await site('stopped', { containerName: uid('dh-stopped') })
  await site('gone', { containerName: uid('dh-gone') })
  await site('stoppedProject', { containerName: uid('dh-off'), status: 'stopped' })
  p.unreachable = (await makeProject(userId, { serverId: otherServerId, containerName: uid('dh-x') })).id
})

async function containerFake(): Promise<(serverId: string) => Promise<ContainerRow[]>> {
  const rows = await db.project.findMany({ where: { id: { in: Object.values(p) } } })
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
  return async (sid: string) => {
    if (sid === otherServerId) throw new Error('Cannot connect to the Docker daemon')
    return [
      { id: 'f'.repeat(64), name: byId[p.healthy].containerName!, state: 'running' },
      { id: 'abcdef1234567890' + 'e'.repeat(48), name: 'renamed-by-hand', state: 'running' },
      { id: 'c'.repeat(64), name: `${byId[p.compose].containerName}-wordpress-1`, state: 'running' },
      { id: 'd'.repeat(64), name: byId[p.stopped].containerName!, state: 'exited' },
    ]
  }
}

describe('container check', () => {
  it('finds containers by name, id and compose service; reports missing and stopped ones', async () => {
    const r = await checkContainers({ force: true, listContainers: await containerFake() })
    const missing = r.missing.map((m) => m.projectId)
    const stopped = r.notRunning.map((m) => m.projectId)
    expect(missing).toContain(p.gone)
    expect(missing).not.toContain(p.healthy)
    expect(missing).not.toContain(p.byId)
    expect(missing).not.toContain(p.compose)
    expect(stopped).toEqual(expect.arrayContaining([p.stopped]))
    expect(stopped).not.toContain(p.healthy)
    // Only 'running' projects are checked.
    expect([...missing, ...stopped]).not.toContain(p.stoppedProject)
  })

  it('an unreadable Docker is a server error, never "container missing"', async () => {
    const r = await checkContainers({ force: true, listContainers: await containerFake() })
    expect(r.serverErrors.map((e) => e.serverId)).toContain(otherServerId)
    expect(r.missing.map((m) => m.projectId)).not.toContain(p.unreachable)
  })

  it('never changes a project: the check is report-only', async () => {
    await checkContainers({ force: true, listContainers: await containerFake() })
    const gone = await db.project.findUnique({ where: { id: p.gone } })
    expect(gone?.status).toBe('running')
  })

  it('matches short ids in either direction, and never on a too-short id', () => {
    const rows = [{ id: 'abcdef123456', name: 'x', state: 'running' }]
    expect(findContainer(rows, null, 'abcdef1234567890')).not.toBeNull()
    expect(findContainer(rows, null, 'abc')).toBeNull()
  })
})

describe('certificate check', () => {
  it('records the real probe result and reports not-served and expiring certificates', async () => {
    await db.project.update({ where: { id: p.healthy }, data: { sslCertStatus: 'issued' } })
    await db.project.update({ where: { id: p.gone }, data: { sslCertStatus: 'issued' } })
    const now = new Date()
    const r = await checkCertificates({
      force: true,
      now,
      probeCertificates: async (sid, projects) => {
        if (sid === otherServerId) throw new Error('ssh: connection refused')
        return projects.map((x) => {
          if (x.id === p.healthy) return { projectId: x.id, ok: true, notAfter: new Date(now.getTime() + 60 * DAY) }
          if (x.id === p.byId) return { projectId: x.id, ok: true, notAfter: new Date(now.getTime() + 5 * DAY) }
          return { projectId: x.id, ok: false }
        })
      },
    })
    const notServed = r.notServed.filter((n) => Object.values(p).includes(n.projectId))
    expect(notServed.find((n) => n.projectId === p.gone)?.previous).toBe('issued')
    expect(notServed.map((n) => n.projectId)).not.toContain(p.healthy)
    expect(r.expiringSoon.map((e) => e.projectId)).toEqual(expect.arrayContaining([p.byId]))
    expect(r.expiringSoon.map((e) => e.projectId)).not.toContain(p.healthy)
    expect(r.serverErrors.map((e) => e.serverId)).toContain(otherServerId)
  })

  it('skips projects with SSL off', async () => {
    await db.project.update({ where: { id: p.compose }, data: { sslEnabled: false } })
    const seen: string[] = []
    await checkCertificates({
      force: true,
      probeCertificates: async (_sid, projects) => {
        seen.push(...projects.map((x) => x.id))
        return []
      },
    })
    expect(seen).not.toContain(p.compose)
  })
})

describe('registrar drift', () => {
  const names: Record<string, string> = {}
  beforeAll(async () => {
    // '0-' sorts first, so registrarSkip 0 covers these rows.
    const mk = async (key: string, expiresAt: Date | null) => {
      names[key] = `0-${uid(key)}.com`.toLowerCase()
      await db.domain.create({
        data: { userId, name: names[key], status: 'active', provider: 'dynadot', registrar: 'dynadot', expiresAt },
      })
    }
    const now = Date.now()
    await mk('same', new Date(now + 300 * DAY))
    await mk('drift', new Date(now + 100 * DAY))
    await mk('expired', new Date(now + 10 * DAY))
    await mk('missing', new Date(now + 200 * DAY))
  })

  it('corrects expiry from the registrar, reports expired and unreadable domains', async () => {
    const now = new Date()
    const same = await db.domain.findUnique({ where: { name: names.same } })
    const registrar: Record<string, Date> = {
      [names.same]: same!.expiresAt!,
      [names.drift]: new Date(now.getTime() + 465 * DAY),
      [names.expired]: new Date(now.getTime() - 2 * DAY),
    }
    const r = await checkRegistrar({
      now,
      registrarSkip: 0,
      getDomainInfo: async (name) => {
        if (name === names.missing) throw new Error('domain not found in account')
        if (!registrar[name]) return { status: 'active' } // someone else's test row
        return { status: 'active', expiry: registrar[name].toISOString() }
      },
    })
    const fixed = r.expiryCorrected.map((x) => x.domain)
    expect(fixed).toContain(names.drift)
    expect(fixed).not.toContain(names.same)
    const drift = await db.domain.findUnique({ where: { name: names.drift } })
    expect(drift?.expiresAt?.toISOString()).toBe(registrar[names.drift].toISOString())
    expect(r.expiredAtRegistrar.map((x) => x.domain)).toContain(names.expired)
    // An unreadable domain is reported and left exactly as it was.
    expect(r.lookupFailed.map((x) => x.domain)).toContain(names.missing)
    const missing = await db.domain.findUnique({ where: { name: names.missing } })
    expect(missing?.status).toBe('active')
    const log = await db.domainLog.findFirst({ where: { domainId: drift!.id, action: 'reconcile_expiry' } })
    expect(log?.status).toBe('success')
  })

  it('is skipped in a test run without an injected reader (never reaches Dynadot)', async () => {
    const r = await checkRegistrar({})
    expect(r.skipped).toBeTruthy()
    expect(r.checked).toBe(0)
  })
})

describe('summary', () => {
  it('stores the last summary for the admin report', async () => {
    const s = await runInfraReconcile({
      force: true,
      registrarSkip: 0,
      listContainers: await containerFake(),
      probeCertificates: async (_sid, projects) => projects.map((x) => ({ projectId: x.id, ok: false })),
      getDomainInfo: async () => {
        throw new Error('registrar down')
      },
    })
    const stored = await lastInfraReport()
    expect(stored?.ranAt).toBe(s.ranAt)
    expect(stored?.containers.missing.map((m) => m.projectId)).toContain(p.gone)
    // Registrar down: every domain is a lookup failure, none is changed.
    expect(s.registrar.expiryCorrected).toEqual([])
  })

  it('a test process without fakes skips the infrastructure checks', async () => {
    const s = await runInfraReconcile({})
    expect(s.containers.skipped).toBeTruthy()
    expect(s.certificates.skipped).toBeTruthy()
    expect(s.registrar.skipped).toBeTruthy()
  })
})
