/**
 * Hosting-management hardening (route audit, round 4):
 *   - an unverified domain can never become a site's served hostname
 *     (primary PATCH refused; proxy and CDN ignore an unproven customDomain)
 *   - IP rules: expired ones are dropped and disabled, allow-lists reach Caddy
 *   - certificate actions are limited per website; a healthy certificate is
 *     not force-renewed
 *   - backups are limited per website
 *   - compose never starts with a symlinked bind source
 *
 * No Docker, Caddy or ACME is reached: the projects here have no server, so
 * every proxy regeneration fails cleanly (and must be reported as not applied).
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '@/lib/db'
import * as domainRoute from '@/app/api/hosting/[id]/domains/[domainId]/route'
import * as sslRoute from '@/app/api/hosting/[id]/ssl/route'
import * as backupsRoute from '@/app/api/hosting/[id]/backups/route'
import { buildServerProxyConfigs, expireIpRules, generateCaddyBlock } from '@/lib/vps/proxy'
import { BIND_SOURCE_GUARD } from '@/lib/vps/deploy-safety'
import { makeUser, makeProject, authed, params, uid } from './helpers'

type U = Awaited<ReturnType<typeof makeUser>>
let owner: U
let other: U
let serverId: string

beforeAll(async () => {
  owner = await makeUser('hh-owner')
  other = await makeUser('hh-other')
  serverId = (
    await db.server.create({
      data: { name: uid('hh'), ip: '127.0.0.1', sshHost: 'localhost', cpuCores: 1, ramGB: 1, storageGB: 10, bandwidthGB: 100 },
    })
  ).id
})

describe('unverified domains are never served', () => {
  it('refuses to make an unverified domain primary', async () => {
    const p = await makeProject(owner.id)
    const row = await db.websiteDomain.create({ data: { projectId: p.id, domain: `${uid('victim')}.com` } })
    const res = await domainRoute.PATCH(
      authed(owner.token, `/api/hosting/${p.id}/domains/${row.id}`, { method: 'PATCH', body: JSON.stringify({ isPrimary: true }) }),
      params({ id: p.id, domainId: row.id })
    )
    expect(res.status).toBe(409)
    const after = await db.project.findUnique({ where: { id: p.id } })
    expect(after?.customDomain).toBeNull()
  })

  it('a verified domain can become primary; a failed proxy update is reported, not hidden', async () => {
    const p = await makeProject(owner.id)
    const row = await db.websiteDomain.create({
      data: { projectId: p.id, domain: `${uid('mine')}.com`, verified: true, verifiedAt: new Date() },
    })
    const res = await domainRoute.PATCH(
      authed(owner.token, `/api/hosting/${p.id}/domains/${row.id}`, { method: 'PATCH', body: JSON.stringify({ isPrimary: true }) }),
      params({ id: p.id, domainId: row.id })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.applied).toBe(false) // no server in this test: Caddy was not updated, and the answer says so
    expect((await db.project.findUnique({ where: { id: p.id } }))?.customDomain).toBe(row.domain)
  })

  it('the proxy serves a customDomain only when it is verified or owned with us', async () => {
    const mk = (customDomain: string, userId = owner.id) =>
      makeProject(userId, { serverId, customDomain, containerName: uid('dh'), externalPort: 30000 + Math.floor(Math.random() * 1000) })
    const unproven = await mk(`${uid('unproven')}.com`)
    const verified = await mk(`${uid('verified')}.com`)
    await db.websiteDomain.create({ data: { projectId: verified.id, domain: verified.customDomain!, verified: true } })
    const owned = await mk(`${uid('owned')}.com`)
    await db.domain.create({ data: { userId: owner.id, name: owned.customDomain!.toLowerCase(), status: 'active', provider: 'dynadot' } })
    const someoneElses = await mk(`${uid('theirs')}.com`)
    await db.domain.create({ data: { userId: other.id, name: someoneElses.customDomain!.toLowerCase(), status: 'active', provider: 'dynadot' } })

    const { servedHosts, configs } = await buildServerProxyConfigs(serverId, true)
    expect(servedHosts.get(unproven.id)).toBe(unproven.subdomain)
    expect(servedHosts.get(verified.id)).toBe(verified.customDomain)
    expect(servedHosts.get(owned.id)).toBe(owned.customDomain)
    expect(servedHosts.get(someoneElses.id)).toBe(someoneElses.subdomain)
    expect(configs.map((c) => c.hostname)).not.toContain(unproven.customDomain)
  })
})

describe('IP rules', () => {
  it('drops expired rules from the config and disables them', async () => {
    const p = await makeProject(owner.id, { serverId, containerName: uid('dh-ip'), externalPort: 31999 })
    const past = new Date(Date.now() - 60_000)
    const future = new Date(Date.now() + 3_600_000)
    await db.ipBlock.createMany({
      data: [
        { projectId: p.id, ipAddress: '203.0.113.1', action: 'deny', expiresAt: past },
        { projectId: p.id, ipAddress: '203.0.113.2', action: 'deny', expiresAt: future },
        { projectId: p.id, ipAddress: '203.0.113.3', action: 'deny' },
      ],
    })
    const { configs, servedHosts } = await buildServerProxyConfigs(serverId, true)
    const mine = configs.find((c) => c.hostname === servedHosts.get(p.id))!
    const ips = (mine.ipBlocks || []).map((b) => b.ipAddress)
    expect(ips).not.toContain('203.0.113.1')
    expect(ips).toEqual(expect.arrayContaining(['203.0.113.2', '203.0.113.3']))

    const n = await expireIpRules()
    expect(n).toBeGreaterThanOrEqual(1)
    const expired = await db.ipBlock.findFirst({ where: { projectId: p.id, ipAddress: '203.0.113.1' } })
    expect(expired?.enabled).toBe(false)
    expect(await expireIpRules()).toBe(0) // idempotent
  })

  it('an allow-list is enforced by Caddy itself', () => {
    const block = generateCaddyBlock({
      hostname: 'site.example.test',
      upstream: 'localhost:3000',
      ssl: false,
      ipBlocks: [
        { ipAddress: '198.51.100.7', action: 'allow' },
        { ipAddress: '198.51.100.9', action: 'deny' },
      ],
    })
    expect(block).toContain('not client_ip 198.51.100.7')
    expect(block).toContain('respond @notallowed 403')
    expect(block).toContain('client_ip 198.51.100.9')
    // Rules come before the proxy, so they actually apply.
    expect(block.indexOf('@notallowed')).toBeLessThan(block.indexOf('reverse_proxy'))
  })
})

describe('certificate actions', () => {
  const post = (u: U, id: string, body: unknown) =>
    sslRoute.POST(authed(u.token, `/api/hosting/${id}/ssl`, { method: 'POST', body: JSON.stringify(body) }), params({ id }))

  it('does not force-renew a certificate with more than 30 days left', async () => {
    const p = await makeProject(owner.id, {
      sslCertStatus: 'issued',
      sslCertExpiry: new Date(Date.now() + 60 * 24 * 3600 * 1000),
    })
    const res = await post(owner, p.id, { action: 'renew' })
    expect(res.status).toBe(409)
    expect((await db.project.findUnique({ where: { id: p.id } }))?.sslCertStatus).toBe('issued')
  })

  it('limits renew/toggle actions per website per hour', async () => {
    const p = await makeProject(owner.id)
    await db.auditLog.createMany({
      data: Array.from({ length: sslRoute.SSL_ACTIONS_PER_HOUR }, () => ({
        userId: owner.id,
        action: 'project.ssl.renew',
        resource: 'project',
        resourceId: p.id,
        metadata: '{}',
      })),
    })
    const res = await post(owner, p.id, { action: 'renew' })
    expect(res.status).toBe(429)
  })

  it('another customer cannot act on the website at all', async () => {
    const p = await makeProject(owner.id)
    const res = await post(other, p.id, { action: 'renew' })
    expect([403, 404]).toContain(res.status)
  })
})

describe('backups', () => {
  it('refuses a third backup within ten minutes', async () => {
    const p = await makeProject(owner.id)
    await db.websiteBackup.createMany({
      data: [
        { projectId: p.id, filename: `${uid('b')}.tar.gz`, sizeBytes: 1000, status: 'completed', type: 'manual' },
        { projectId: p.id, filename: `${uid('b')}.tar.gz`, sizeBytes: 1000, status: 'completed', type: 'manual' },
      ],
    })
    const res = await backupsRoute.POST(
      authed(owner.token, `/api/hosting/${p.id}/backups`, { method: 'POST', body: '{}' }),
      params({ id: p.id })
    )
    expect(res.status).toBe(429)
  })
})

const BASH = process.platform === 'win32' ? 'C:/Users/kct/dev/git/bin/bash.exe' : '/bin/bash'
describe.skipIf(process.platform === 'win32' || !existsSync(BASH))('compose bind sources', () => {
  it('refuses to start when wp-content or db-data is a link', () => {
    const root = mkdtempSync(join(tmpdir(), 'bind-guard-'))
    const site = join(root, 'site')
    mkdirSync(site)
    mkdirSync(join(root, 'host-dir'))
    symlinkSync(join(root, 'host-dir'), join(site, 'db-data'))
    const r = Bun.spawnSync([BASH, '-c', `cd '${site}' && ${BIND_SOURCE_GUARD}echo STARTED`])
    expect(r.exitCode).toBe(97)
    expect(r.stdout.toString()).not.toContain('STARTED')

    rmSync(join(site, 'db-data'))
    mkdirSync(join(site, 'wp-content'))
    writeFileSync(join(site, 'wp-config-docker.php'), '<?php')
    const ok = Bun.spawnSync([BASH, '-c', `cd '${site}' && ${BIND_SOURCE_GUARD}echo STARTED`])
    expect(ok.exitCode).toBe(0)
    expect(ok.stdout.toString()).toContain('STARTED')
    rmSync(root, { recursive: true, force: true })
  })
})

describe('domain search input', () => {
  it('rejects an invalid name with 400 before any registrar lookup', async () => {
    const search = await import('@/app/api/domains/search/route')
    const get = (d: string) =>
      search.GET(new Request(`http://localhost/api/domains/search?domain=${encodeURIComponent(d)}`, {
        headers: { 'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 200) + 1}` },
      }))
    for (const bad of ['not a domain', 'nodot', '-bad.com', 'bad-.com', 'a..com', 'x.c0m', 'evil.com/../x']) {
      expect((await get(bad)).status).toBe(400)
    }
    const bulk = await search.POST(new Request('http://localhost/api/domains/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '198.51.100.250' },
      body: JSON.stringify({ domains: ['good.com', 'not valid'] }),
    }))
    expect(bulk.status).toBe(400)
  })
})
