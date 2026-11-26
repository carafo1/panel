/** Staging sites: plan gating, lifecycle, isolation from live, and the copy commands. */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '@/lib/db'
import * as staging from '@/app/api/hosting/[id]/staging/route'
import * as hosting from '@/app/api/hosting/route'
import { copyFilesCommand, copyFilesScript, copyDatabaseCommand, stagingMode } from '@/lib/staging'
import { checkLimit } from '@/lib/plan-limits'
import { makeUser, makeProject, makePlan, authed, params, uid } from './helpers'

/** Live sites always have a real domain; staging lives at staging.<domain>. */
const liveDomain = () => `${uid('live')}.example.com`

let ip = 0
const call = (token: string, id: string, method: 'GET' | 'POST' | 'DELETE', body?: Record<string, unknown>) => {
  const req = authed(token, `/api/hosting/${id}/staging`, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'x-forwarded-for': `10.99.${++ip & 255}.${(ip >> 8) & 255}` },
  })
  return method === 'GET' ? staging.GET(req, params({ id })) : method === 'POST' ? staging.POST(req, params({ id })) : staging.DELETE(req, params({ id }))
}

async function demoServer() {
  // No SSH host: simulated outside production.
  return db.server.create({ data: { name: 'demo', ip: '192.0.2.10', sshHost: '', cpuCores: 2, ramGB: 4, storageGB: 40, bandwidthGB: 1000 } })
}

async function waitFor(id: string, until: (s: string | null) => boolean, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const p = await db.project.findUnique({ where: { id }, select: { stagingStatus: true } })
    if (p && until(p.stagingStatus)) return p.stagingStatus
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('timed out waiting for staging')
}

// Runs the generated commands in a real shell against temp folders.
const BASH = Bun.which('bash') || (process.platform === 'win32' ? 'C:/Users/kct/dev/git/bin/bash.exe' : null)
const haveBash = !!BASH && (process.platform !== 'win32' || existsSync(BASH))
function sh(cmd: string) {
  const r = Bun.spawnSync([BASH!, '-c', cmd])
  return { code: r.exitCode, err: r.stderr.toString() }
}
const posix = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)

describe('staging copy commands', () => {
  it.skipIf(!haveBash)('WordPress: copies wp-content only, and a missing source never touches the destination', () => {
    const root = mkdtempSync(join(tmpdir(), 'stg-wp-'))
    const live = join(root, 'live'), stg = join(root, 'stg')
    mkdirSync(join(live, 'wp-content', 'plugins'), { recursive: true })
    writeFileSync(join(live, 'wp-content', 'plugins', 'shop.php'), 'live plugin')
    writeFileSync(join(live, 'wp-config-docker.php'), 'LIVE DB PASSWORD')
    mkdirSync(join(stg, 'wp-content'), { recursive: true })
    writeFileSync(join(stg, 'wp-content', 'old.txt'), 'stale')
    writeFileSync(join(stg, 'wp-config-docker.php'), 'staging db')

    expect(sh(copyFilesScript('wordpress', posix(live), posix(stg), { replace: true })).code).toBe(0)
    expect(readFileSync(join(stg, 'wp-content', 'plugins', 'shop.php'), 'utf8')).toBe('live plugin')
    expect(existsSync(join(stg, 'wp-content', 'old.txt'))).toBe(false)
    expect(existsSync(join(stg, 'wp-content.staging-old'))).toBe(false)
    expect(readFileSync(join(stg, 'wp-config-docker.php'), 'utf8')).toBe('staging db')

    // Source without wp-content: fail, destination intact.
    const empty = join(root, 'empty')
    mkdirSync(empty)
    const r = sh(copyFilesScript('wordpress', posix(empty), posix(stg), { replace: true }))
    expect(r.code).not.toBe(0)
    expect(readFileSync(join(stg, 'wp-content', 'plugins', 'shop.php'), 'utf8')).toBe('live plugin')
    rmSync(root, { recursive: true, force: true })
  })

  it.skipIf(!haveBash)('file sites: replaces files but never copies or deletes .env, .git or generated build files', () => {
    const root = mkdtempSync(join(tmpdir(), 'stg-files-'))
    const a = join(root, 'a'), b = join(root, 'b')
    mkdirSync(join(a, 'public'), { recursive: true })
    writeFileSync(join(a, 'public', 'index.html'), 'new')
    writeFileSync(join(a, '.env'), 'SECRET=live')
    writeFileSync(join(a, 'docker-compose.yml'), 'live compose')
    mkdirSync(join(b, '.git'), { recursive: true })
    writeFileSync(join(b, '.env'), 'SECRET=staging')
    writeFileSync(join(b, 'docker-compose.yml'), 'staging compose')
    writeFileSync(join(b, 'removed.html'), 'gone')

    expect(sh(copyFilesScript('files', posix(a), posix(b), { replace: true })).code).toBe(0)
    expect(readFileSync(join(b, 'public', 'index.html'), 'utf8')).toBe('new')
    expect(readFileSync(join(b, '.env'), 'utf8')).toBe('SECRET=staging')
    expect(readFileSync(join(b, 'docker-compose.yml'), 'utf8')).toBe('staging compose')
    expect(existsSync(join(b, '.git'))).toBe(true)
    expect(existsSync(join(b, 'removed.html'))).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it.skipIf(!haveBash)('WordPress: copies wp-content between the site/ layout and the older flat layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'stg-layout-'))
    const live = join(root, 'live'), stg = join(root, 'stg')
    // Live: new layout (everything in site/). Staging: old flat layout.
    mkdirSync(join(live, 'site', 'wp-content', 'themes'), { recursive: true })
    writeFileSync(join(live, 'site', 'wp-content', 'themes', 'style.css'), 'live theme')
    writeFileSync(join(live, 'site', 'wp-config.php'), 'LIVE DB PASSWORD')
    mkdirSync(join(stg, 'wp-content'), { recursive: true })
    expect(sh(copyFilesScript('wordpress', posix(live), posix(stg), { replace: true })).code).toBe(0)
    expect(readFileSync(join(stg, 'wp-content', 'themes', 'style.css'), 'utf8')).toBe('live theme')
    expect(existsSync(join(stg, 'wp-config.php'))).toBe(false)
    // And into a new-layout staging site.
    mkdirSync(join(stg, 'site', 'wp-content'), { recursive: true })
    expect(sh(copyFilesScript('wordpress', posix(live), posix(stg), { replace: true })).code).toBe(0)
    expect(readFileSync(join(stg, 'site', 'wp-content', 'themes', 'style.css'), 'utf8')).toBe('live theme')
    rmSync(root, { recursive: true, force: true })
  })

  it.skipIf(!haveBash || process.platform === 'win32')('WordPress: a wp-content symlink is refused, never followed', () => {
    const root = mkdtempSync(join(tmpdir(), 'stg-link-'))
    const live = join(root, 'live'), stg = join(root, 'stg'), secret = join(root, 'host-secret')
    mkdirSync(live, { recursive: true })
    mkdirSync(join(stg, 'wp-content'), { recursive: true })
    mkdirSync(secret)
    writeFileSync(join(secret, 'shadow'), 'root:hash')
    symlinkSync(secret, join(live, 'wp-content'))
    const r = sh(copyFilesScript('wordpress', posix(live), posix(stg), { replace: true }))
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('not a link')
    expect(existsSync(join(stg, 'wp-content', 'shadow'))).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it('the copy runs in a sandbox container that sees only the two sites', () => {
    const cmd = copyFilesCommand('wordpress', '/opt/deployhub/projects/live', '/opt/deployhub/projects/stg', { replace: true })
    expect(cmd.startsWith('docker run --rm --network none')).toBe(true)
    expect(cmd).toContain('-v /opt/deployhub/projects/live:/src:ro -v /opt/deployhub/projects/stg:/dst')
    expect(cmd).toContain('--cap-drop ALL')
    expect(cmd).toContain('/src/site')
    expect(cmd).not.toContain('/opt/deployhub/projects/live/wp-content')
    expect(() => copyFilesCommand('files', '/etc', '/opt/deployhub/projects/stg', { replace: false })).toThrow()
    expect(() => copyFilesCommand('files', '/opt/deployhub/projects/a/../../../etc', '/opt/deployhub/projects/stg', { replace: false })).toThrow()
  })

  it('database copy passes credentials as quoted env values and always removes the dump', () => {
    const cmd = copyDatabaseCommand(
      { type: 'mysql', container: 'live-db', name: 'wp_live', user: 'u', password: "pa'ss" },
      { type: 'mysql', container: 'stg-db', name: 'wp_stg', user: 'u2', password: 'p2' },
      '/tmp/x.sql'
    )
    expect(cmd).toContain("MYSQL_PWD='pa'\\''ss'")
    expect(cmd.endsWith('rc=$?; rm -f /tmp/x.sql; exit $rc')).toBe(true)
  })

  it('knows which sites can be staged', () => {
    expect(stagingMode({ deploymentMethod: 'wordpress', deploymentSource: 'template', stack: 'wordpress', framework: 'wordpress', repoUrl: null }).mode).toBe('wordpress')
    expect(stagingMode({ deploymentMethod: 'nodejs', deploymentSource: 'git', stack: 'nodejs', framework: 'nextjs', repoUrl: 'https://github.com/a/b' }).mode).toBe('git')
    expect(stagingMode({ deploymentMethod: 'docker', deploymentSource: 'git', stack: 'docker', framework: 'docker', repoUrl: 'x' }).mode).toBeNull()
    expect(stagingMode({ deploymentMethod: 'static', deploymentSource: 'zip', stack: 'static', framework: 'static', repoUrl: null }).mode).toBe('files')
  })
})

describe('staging sites', () => {
  it('is refused when the plan does not include staging', async () => {
    const u = await makeUser('stg-noplan')
    const plan = await makePlan({ stagingEnvironment: false })
    await db.subscription.create({ data: { userId: u.id, planId: plan.id, status: 'active', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400_000) } })
    const server = await demoServer()
    const live = await makeProject(u.id, { serverId: server.id, deploymentMethod: 'wordpress', stack: 'wordpress', framework: 'wordpress' })

    const info = await (await call(u.token, live.id, 'GET')).json()
    expect(info.planAllows).toBe(false)
    expect((await call(u.token, live.id, 'POST', { action: 'create' })).status).toBe(403)
  })

  it('creates a hidden staging copy, refreshes it, pushes it and removes it', async () => {
    const u = await makeUser('stg-owner')
    const stranger = await makeUser('stg-stranger')
    const plan = await makePlan({ stagingEnvironment: true, projects: 1 })
    await db.subscription.create({ data: { userId: u.id, planId: plan.id, status: 'active', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400_000) } })
    const server = await demoServer()
    const live = await makeProject(u.id, { serverId: server.id, deploymentMethod: 'wordpress', stack: 'wordpress', framework: 'wordpress', deployPath: '/opt/deployhub/projects/live', customDomain: liveDomain() })
    await db.environmentVariable.create({ data: { projectId: live.id, key: 'API_KEY', value: 'enc', encrypted: true } })

    expect((await call(stranger.token, live.id, 'POST', { action: 'create' })).status).toBeGreaterThanOrEqual(403)

    const res = await call(u.token, live.id, 'POST', { action: 'create' })
    expect(res.status).toBe(201)
    const { staging: s } = await res.json()
    // staging.<live domain>, never a platform subdomain. PowerDNS is not
    // configured in tests, so the customer is told which record to add.
    expect(s.domain).toBe(`staging.${live.customDomain}`)
    expect(s.url).toBe(`https://staging.${live.customDomain}`)
    expect(s.domainStatus).toBe('awaiting_dns')
    expect(s.dnsRecord).toMatchObject({ type: 'A', name: `staging.${live.customDomain}` })
    const stagingRow = await db.websiteDomain.findUnique({ where: { domain: `staging.${live.customDomain}` } })
    expect(stagingRow).toMatchObject({ projectId: s.id, verified: false, isPrimary: true, connectionMethod: 'manual' })
    expect((await call(u.token, live.id, 'POST', { action: 'create' })).status).toBe(409)
    expect(await waitFor(s.id, (st) => st !== 'creating')).toBe('ready')

    const row = await db.project.findUnique({ where: { id: s.id }, include: { envVars: true } })
    expect(row?.environment).toBe('staging')
    expect(row?.parentProjectId).toBe(live.id)
    expect(row?.deploymentSource).toBe('imported')
    expect(row?.envVars.map((e) => e.key)).toEqual(['API_KEY'])

    // Hidden from the site list and not counted against the 1-site plan.
    const list = await (await hosting.GET(authed(u.token, '/api/hosting'))).json()
    expect(list.projects.map((p: { id: string }) => p.id)).toEqual([live.id])
    expect((await checkLimit(u.id, 'websites', { addition: 0 })).allowed).toBe(true)

    // A staging site can't have its own staging.
    expect((await call(u.token, s.id, 'POST', { action: 'create' })).status).toBe(409)

    expect((await call(u.token, live.id, 'POST', { action: 'sync' })).status).toBe(202)
    expect(await waitFor(s.id, (st) => st !== 'syncing')).toBe('ready')

    expect((await call(u.token, live.id, 'POST', { action: 'push', database: false })).status).toBe(202)
    expect(await waitFor(s.id, (st) => st !== 'pushing')).toBe('ready')
    // A backup of the live site was taken before pushing.
    const backups = await db.websiteBackup.findMany({ where: { projectId: live.id } })
    expect(backups.some((b) => b.type === 'pre-deploy')).toBe(true)
    expect((await db.project.findUnique({ where: { id: s.id } }))?.stagingPushedAt).not.toBeNull()

    expect((await call(u.token, live.id, 'DELETE')).status).toBe(200)
    expect(await db.project.findUnique({ where: { id: s.id } })).toBeNull()
    expect(await db.project.findUnique({ where: { id: live.id } })).not.toBeNull()
  }, 60_000)

  it('git sites stage a branch and go live by merging, not by pushing', async () => {
    const u = await makeUser('stg-git')
    const server = await demoServer()
    const live = await makeProject(u.id, {
      serverId: server.id, deploymentMethod: 'nodejs', deploymentSource: 'git', repoUrl: 'https://github.com/acme/site', sourceBranch: 'main',
      customDomain: liveDomain(),
    })
    expect((await call(u.token, live.id, 'POST', { action: 'create', branch: 'bad..branch' })).status).toBe(400)
    const res = await call(u.token, live.id, 'POST', { action: 'create', branch: 'develop' })
    expect(res.status).toBe(201)
    const { staging: s } = await res.json()
    expect(s.branch).toBe('develop')
    await waitFor(s.id, (st) => st !== 'creating')
    const push = await call(u.token, live.id, 'POST', { action: 'push' })
    expect(push.status).toBe(409)
    expect((await push.json()).error).toMatch(/merge/i)
  }, 60_000)

  it('is refused for a live site without a domain (there is no platform address)', async () => {
    const u = await makeUser('stg-nodomain')
    const server = await demoServer()
    const live = await makeProject(u.id, { serverId: server.id, deploymentMethod: 'static', deploymentSource: 'zip' })
    const res = await call(u.token, live.id, 'POST', { action: 'create' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/domain/i)
    expect(await db.project.count({ where: { parentProjectId: live.id } })).toBe(0)
  })

  it('deleting the live site also deletes its staging copy', async () => {
    const u = await makeUser('stg-purge')
    const server = await demoServer()
    const live = await makeProject(u.id, { serverId: server.id, deploymentMethod: 'static', deploymentSource: 'zip', customDomain: liveDomain() })
    const { staging: s } = await (await call(u.token, live.id, 'POST', { action: 'create' })).json()
    await waitFor(s.id, (st) => st !== 'creating')
    const { purgeProject } = await import('@/lib/project-teardown')
    await purgeProject(live.id)
    expect(await db.project.findUnique({ where: { id: s.id } })).toBeNull()
  }, 60_000)
})
