/**
 * Orphaned-resource report, single-orphan removal and the admin capacity view.
 *
 * Docker output is injected as fake text; nothing here reaches Docker, SSH or
 * the filesystem of a server. Other scenario files share the database, so
 * assertions only look at names this file creates.
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '@/lib/db'
import {
  checkOrphans,
  detectOrphans,
  loadOrphanReferences,
  parseMemUsage,
  removeOrphanContainer,
  runInfraReconcile,
  type OrphanInventory,
  type OrphanRemovalOps,
} from '@/lib/infra-reconcile'
import { buildCapacityReport, capacityWarnings, parseDf, parseFree } from '@/app/api/admin/capacity/capacity'
import * as capacityRoute from '@/app/api/admin/capacity/route'
import * as removeRoute from '@/app/api/admin/infrastructure/orphans/remove/route'
import { authed, makeProject, makeUser, uid } from './helpers'

const HOUR = 60 * 60 * 1000
let serverId: string
let admin: { id: string; token: string }
let customer: { token: string }
const n: Record<string, string> = {}

const created = (msAgo: number) => {
  const d = new Date(Date.now() - msAgo)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000 UTC`
}

beforeAll(async () => {
  admin = await makeUser('cap-admin', 'admin')
  customer = await makeUser('cap-cust', 'user')
  serverId = (
    await db.server.create({
      data: { name: uid('cap'), ip: '127.0.0.1', sshHost: 'localhost', cpuCores: 2, ramGB: 4, storageGB: 80, bandwidthGB: 100 },
    })
  ).id
  const slug = uid('capsite').toLowerCase()
  n.slug = slug
  n.app = `deployhub-${slug}`
  n.db = `deployhub-db-${slug.slice(0, 8)}-a1b2`
  n.byId = `deployhub-renamed-${slug}`
  n.orphanA = `deployhub-db-${uid('gone').toLowerCase()}`
  n.orphanB = `deployhub-${uid('old').toLowerCase()}`
  n.young = `deployhub-${uid('young').toLowerCase()}`
  const project = await makeProject(admin.id, {
    slug,
    serverId,
    containerName: n.app,
    containerId: 'feedbeef1234567890',
    deployPath: `/opt/deployhub/projects/${slug}`,
  })
  n.projectId = project.id
  await db.websiteDatabase.create({
    data: {
      projectId: project.id, name: 'wp', type: 'mariadb', host: n.db, port: 3306,
      username: 'u', password: 'x', externalRef: n.db, isPrimary: true,
    },
  })
})

function fakeInventory(): OrphanInventory {
  const t = '\t'
  return {
    containers: [
      ['a'.repeat(64), n.app, 'running', created(48 * HOUR), '', 'deployhub_app_data'],
      ['b'.repeat(64), n.db, 'running', created(48 * HOUR), '', 'dbvol_ref'],
      ['feedbeef1234567890' + 'c'.repeat(46), n.byId, 'running', created(48 * HOUR), '', ''],
      ['d'.repeat(64), n.orphanA, 'running', created(48 * HOUR), '', 'orphan_db_vol,mailcowdockerized_vmail-vol-1'],
      ['e'.repeat(64), n.orphanB, 'exited', created(48 * HOUR), '', ''],
      ['f'.repeat(64), 'mailcowdockerized-postfix-mailcow-1', 'running', created(48 * HOUR), 'mailcowdockerized', ''],
      ['1'.repeat(64), 'caddy', 'running', created(48 * HOUR), '', ''],
    ]
      .map((r) => r.join(t))
      .join('\n'),
    stats: [
      `${n.app}${t}150MiB / 3.8GiB`,
      `${n.db}${t}100MiB / 3.8GiB`,
      `${n.orphanA}${t}102.5MiB / 3.8GiB`,
      `mailcowdockerized-postfix-mailcow-1${t}60MiB / 3.8GiB`,
    ].join('\n'),
    danglingVolumes: [
      `leftover_vol${t}2048`,
      `mailcowdockerized_crypt-vol-1${t}10`,
      `nosize_vol${t}`,
    ].join('\n'),
    projectDirs: [`/opt/deployhub/projects/${n.slug}${t}5000`, `/opt/deployhub/projects/abandoned-x${t}777`].join('\n'),
  }
}

describe('orphan detection', () => {
  it('lists unreferenced deployhub containers, never referenced or non-deployhub ones', async () => {
    const found = detectOrphans(serverId, fakeInventory(), await loadOrphanReferences())
    const names = found.containers.map((c) => c.name)
    expect(names).toContain(n.orphanA)
    expect(names).toContain(n.orphanB)
    // Referenced by Project.containerName, WebsiteDatabase.host and Project.containerId.
    expect(names).not.toContain(n.app)
    expect(names).not.toContain(n.db)
    expect(names).not.toContain(n.byId)
    // Not ours at all.
    expect(names).not.toContain('mailcowdockerized-postfix-mailcow-1')
    expect(names).not.toContain('caddy')
    const a = found.containers.find((c) => c.name === n.orphanA)!
    expect(a.memoryBytes).toBe(Math.round(102.5 * 1024 * 1024))
    expect(a.volumes).toEqual(['orphan_db_vol']) // the Mailcow volume is never offered
    expect(found.containers.find((c) => c.name === n.orphanB)!.memoryBytes).toBeNull()
  })

  it('excludes Mailcow volumes and keeps unmeasured sizes as null', async () => {
    const found = detectOrphans(serverId, fakeInventory(), await loadOrphanReferences())
    const vols = Object.fromEntries(found.volumes.map((v) => [v.name, v.sizeBytes]))
    expect(vols.leftover_vol).toBe(2048)
    expect(vols.nosize_vol).toBeNull()
    expect(Object.keys(vols).some((v) => v.startsWith('mailcowdockerized_'))).toBe(false)
  })

  it('reports project folders no project owns', async () => {
    const found = detectOrphans(serverId, fakeInventory(), await loadOrphanReferences())
    const paths = found.folders.map((f) => f.path)
    expect(paths).toContain('/opt/deployhub/projects/abandoned-x')
    expect(paths).not.toContain(`/opt/deployhub/projects/${n.slug}`)
  })

  it('parses docker memory units', () => {
    expect(parseMemUsage('1.5GiB / 3.8GiB')).toBe(Math.round(1.5 * 1024 ** 3))
    expect(parseMemUsage('12MB / 1GB')).toBe(12_000_000)
    expect(parseMemUsage('--')).toBeNull()
  })

  it('checkOrphans uses the injected reader per server, reports unreadable servers, and lands in the summary', async () => {
    const read = async (sid: string) => {
      if (sid === serverId) return fakeInventory()
      throw new Error('Cannot connect to the Docker daemon')
    }
    const r = await checkOrphans({ readOrphanInventory: read })
    expect(r.containers.filter((c) => c.serverId === serverId).map((c) => c.name)).toEqual(
      expect.arrayContaining([n.orphanA, n.orphanB])
    )
    expect(r.orphanMemoryBytes).toBeGreaterThanOrEqual(Math.round(102.5 * 1024 * 1024))
    const s = await runInfraReconcile({
      force: true,
      readOrphanInventory: read,
      listContainers: async () => [],
      probeCertificates: async () => [],
      getDomainInfo: async () => ({ status: 'active' }),
    })
    expect(s.orphans?.containers.map((c) => c.name)).toContain(n.orphanA)
  })

  it('never runs in a test process without an injected reader, even with force', async () => {
    const r = await checkOrphans({ force: true })
    expect(r.skipped).toBeTruthy()
    expect(r.serversChecked).toBe(0)
  })
})

describe('removeOrphanContainer', () => {
  function fakeOps(calls: string[], age = 48 * HOUR): OrphanRemovalOps {
    return {
      inspect: async (_sid, name) => {
        const row = fakeInventory().containers.split('\n').find((l) => l.split('\t')[1] === name)
        if (!row && name !== n.young) return null
        const [id, , state] = row ? row.split('\t') : ['9'.repeat(64), '', 'running']
        return {
          id: id!, name, state: state!, composeProject: '',
          createdAt: new Date(Date.now() - (name === n.young ? 5 * 60 * 1000 : age)).toISOString(),
          volumes: name === n.orphanA ? ['orphan_db_vol', 'mailcowdockerized_vmail-vol-1'] : [],
        }
      },
      remove: async (_sid, name, volumes) => {
        calls.push(`${name}|${volumes.join(',')}`)
        return { volumesRemoved: volumes, volumesKept: [] }
      },
    }
  }

  it('removes an unreferenced orphan and only its non-Mailcow volumes', async () => {
    const calls: string[] = []
    const r = await removeOrphanContainer({ serverId, name: n.orphanA }, { ops: fakeOps(calls) })
    expect(r.ok).toBe(true)
    expect(calls).toEqual([`${n.orphanA}|orphan_db_vol`])
  })

  it('refuses referenced containers, by name and by live container id', async () => {
    const calls: string[] = []
    const byName = await removeOrphanContainer({ serverId, name: n.db }, { ops: fakeOps(calls) })
    expect(byName.ok).toBe(false)
    if (!byName.ok) expect(byName.status).toBe(409)
    const byId = await removeOrphanContainer({ serverId, name: n.byId }, { ops: fakeOps(calls) })
    expect(byId.ok).toBe(false)
    if (!byId.ok) expect(byId.code).toBe('REFERENCED')
    expect(calls).toEqual([])
  })

  it('refuses non-deployhub names, missing and too-recent containers', async () => {
    const calls: string[] = []
    for (const bad of ['mailcowdockerized-postfix-mailcow-1', 'caddy', 'deployhub-x;rm -rf /', 'deployhub-']) {
      const r = await removeOrphanContainer({ serverId, name: bad }, { ops: fakeOps(calls) })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.status).toBe(400)
    }
    const missing = await removeOrphanContainer({ serverId, name: 'deployhub-not-there' }, { ops: fakeOps(calls) })
    if (!missing.ok) expect(missing.status).toBe(404)
    const young = await removeOrphanContainer({ serverId, name: n.young }, { ops: fakeOps(calls) })
    expect(young.ok).toBe(false)
    if (!young.ok) expect(young.code).toBe('TOO_RECENT')
    expect(calls).toEqual([])
  })
})

describe('POST /api/admin/infrastructure/orphans/remove', () => {
  const post = (token: string | null, body: unknown) =>
    removeRoute.POST(
      authed(token, '/api/admin/infrastructure/orphans/remove', { method: 'POST', body: JSON.stringify(body) })
    )

  it('requires an admin: 401 without credentials, 403 for a customer', async () => {
    expect((await post(null, { serverId, name: n.orphanA })).status).toBe(401)
    expect((await post(customer.token, { serverId, name: n.orphanA })).status).toBe(403)
  })

  it('rejects names that do not start with deployhub-, and bad bodies', async () => {
    const r = await post(admin.token, { serverId, name: 'mailcowdockerized-postfix-mailcow-1' })
    expect(r.status).toBe(400)
    expect((await post(admin.token, { serverId })).status).toBe(400)
    expect((await post(admin.token, { serverId: 'x y', name: n.orphanA })).status).toBe(400)
  })

  it('refuses a referenced container before touching the server, and audit-logs it', async () => {
    const r = await post(admin.token, { serverId, name: n.app })
    expect(r.status).toBe(409)
    const log = await db.auditLog.findFirst({
      where: { userId: admin.id, action: 'infrastructure.orphan_remove', status: 'failure' },
      orderBy: { createdAt: 'desc' },
    })
    expect(log?.metadata).toContain('REFERENCED')
  })

  it('never reaches Docker in a test run for an unreferenced name', async () => {
    const r = await post(admin.token, { serverId, name: n.orphanA })
    expect(r.status).toBe(503)
  })

  it('404 for an unknown server', async () => {
    expect((await post(admin.token, { serverId: 'nope', name: n.orphanA })).status).toBe(404)
  })
})

describe('capacity', () => {
  it('parses free/df and warns amber/red at the thresholds', () => {
    const ram = parseFree(
      '              total        used        free      shared  buff/cache   available\nMem:           3900        3400         100          10         400         400\nSwap:             0           0           0\n'
    )
    expect(ram).toEqual({ totalMB: 3900, usedMB: 3400, availableMB: 400, availablePct: 10.3 })
    const disk = parseDf('Filesystem 1-blocks Used Available Capacity Mounted on\n/dev/vda1 1000 900 100 90% /\n')
    expect(disk?.usedPct).toBe(90)
    const w = capacityWarnings(ram, disk)
    expect(w.map((x) => `${x.kind}:${x.level}`).sort()).toEqual(['disk:amber', 'ram:amber'])
    expect(capacityWarnings({ ...ram!, availablePct: 5 }, { ...disk!, usedPct: 97 }).every((x) => x.level === 'red')).toBe(true)
    expect(capacityWarnings({ ...ram!, availablePct: 40 }, { ...disk!, usedPct: 50 })).toEqual([])
  })

  it('attributes container memory, database memory and disk to each site, with the orphan list', async () => {
    const report = await buildCapacityReport({
      collect: async (sid, ctx) => {
        if (sid !== serverId) throw new Error('unreachable')
        expect(ctx.sitePaths).toContain(`/opt/deployhub/projects/${n.slug}`)
        return {
          free: 'Mem: 3900 3000 200 10 700 800\n',
          df: 'Filesystem 1-blocks Used Available Capacity Mounted on\n/dev/vda1 100 50 50 50% /\n',
          nproc: '2\n',
          orphan: fakeInventory(),
          siteDu: `/opt/deployhub/projects/${n.slug}\t5000\n`,
        }
      },
    })
    const s = report.servers.find((x) => x.id === serverId)!
    expect(s.error).toBeNull()
    expect(s.cpuCount).toBe(2)
    expect(s.ram?.availableMB).toBe(800)
    expect(s.runningContainers).toBe(6)
    expect(s.warnings).toEqual([])
    const site = s.sites.find((x) => x.projectId === n.projectId)!
    expect(site.containerMemoryBytes).toBe(150 * 1024 * 1024)
    expect(site.databaseMemoryBytes).toBe(100 * 1024 * 1024)
    expect(site.databaseContainers).toEqual([n.db])
    expect(site.diskBytes).toBe(5000)
    expect(s.orphans?.containers.map((c) => c.name)).toEqual(expect.arrayContaining([n.orphanA, n.orphanB]))
    // Other files' servers fail in the fake: reported, not zeroed.
    const other = report.servers.find((x) => x.id !== serverId && !x.demo)
    if (other) expect(other.ram).toBeNull()
  })

  it('GET /api/admin/capacity is admin-only and never measures in a test run', async () => {
    expect((await capacityRoute.GET(authed(null, '/api/admin/capacity'))).status).toBe(401)
    expect((await capacityRoute.GET(authed(customer.token, '/api/admin/capacity'))).status).toBe(403)
    const res = await capacityRoute.GET(authed(admin.token, '/api/admin/capacity?refresh=1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    const mine = body.servers.find((x: { id: string }) => x.id === serverId)
    expect(mine.error).toBe('not measured in a test run')
    expect(mine.ram).toBeNull()
    // Second call within 60 s is served from the cache.
    const again = await (await capacityRoute.GET(authed(admin.token, '/api/admin/capacity'))).json()
    expect(again.cached).toBe(true)
  })
})
