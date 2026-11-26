/**
 * Every website needs a real domain (product rule): no `<slug>.<platform
 * domain>` address is created for any site.
 *
 *   - create (wizard + legacy) and import refuse a request without a domain
 *     with 400 and the customer-facing message;
 *   - the domain is validated like a custom domain (shape, platform names,
 *     cross-tenant conflicts, "in my account");
 *   - a domain in the account becomes customDomain; one owned elsewhere is
 *     attached pending verification and is not served until verified.
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '@/lib/db'
import * as create from '@/app/api/hosting/create/route'
import * as importRoute from '@/app/api/hosting/import/route'
import { DOMAIN_REQUIRED_MESSAGE } from '@/lib/site-address'
import { BRAND_DOMAIN } from '@/lib/brand-config'
import { makeUser, makeProject, authed, uid } from './helpers'

type U = Awaited<ReturnType<typeof makeUser>>
let admin: U
let customer: U

// Staff skip the plan requirement, which is not what is under test here.
beforeAll(async () => {
  admin = await makeUser('sdr-admin', 'admin')
  customer = await makeUser('sdr-customer')
  await db.server.create({
    data: { name: uid('sdr'), ip: '127.0.0.1', sshHost: 'localhost', cpuCores: 1, ramGB: 1, storageGB: 10, bandwidthGB: 100, status: 'active' },
  })
})

let ip = 1
const post = (route: typeof create.POST | typeof importRoute.POST, u: U, path: string, body: unknown) =>
  route(
    authed(u.token, path, {
      method: 'POST',
      body: JSON.stringify(body),
      // A distinct client per call, so the per-IP rate limit never interferes.
      headers: { 'x-forwarded-for': `198.51.100.${ip++}` },
    })
  )

const wizard = (extra: Record<string, unknown>) => ({
  name: uid('Sunrise Bakery'),
  method: 'static',
  source: 'manual',
  deployMode: 'manual',
  ...extra,
})

describe('creating a website requires a domain', () => {
  it('wizard: no domain → 400 with the customer message, nothing created', async () => {
    const before = await db.project.count({ where: { userId: admin.id } })
    for (const extra of [{}, { domainType: 'subdomain' }, { domainType: 'external', domain: '  ' }]) {
      const res = await post(create.POST, admin, '/api/hosting/create', wizard(extra))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe(DOMAIN_REQUIRED_MESSAGE)
      expect(body.code).toBe('DOMAIN_REQUIRED')
    }
    expect(await db.project.count({ where: { userId: admin.id } })).toBe(before)
  })

  it('legacy payload: no domain → 400 as well', async () => {
    const res = await post(create.POST, admin, '/api/hosting/create', { name: uid('legacy'), framework: 'nextjs', deployMode: 'manual' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(DOMAIN_REQUIRED_MESSAGE)
  })

  it('validates the domain like a custom domain', async () => {
    const bad = await post(create.POST, admin, '/api/hosting/create', wizard({ domainType: 'external', domain: 'not a domain' }))
    expect(bad.status).toBe(400)
    const platform = await post(create.POST, admin, '/api/hosting/create', wizard({ domainType: 'external', domain: `my-shop.${BRAND_DOMAIN}` }))
    expect(platform.status).toBe(400)
    expect((await platform.json()).error).toMatch(/belongs to the platform/)
    const notMine = await post(create.POST, admin, '/api/hosting/create', wizard({ domainType: 'existing', domain: `${uid('nope')}.com` }))
    expect(notMine.status).toBe(400)
    // Already serving another tenant.
    const taken = `${uid('taken')}.com`.toLowerCase()
    await makeProject(customer.id, { customDomain: taken })
    const clash = await post(create.POST, admin, '/api/hosting/create', wizard({ domainType: 'external', domain: taken }))
    expect(clash.status).toBe(409)
  })

  it('an external domain is attached pending verification; no platform address is stored as the site address', async () => {
    const domain = `${uid('mine')}.example.org`.toLowerCase()
    const res = await post(create.POST, admin, '/api/hosting/create', wizard({ domainType: 'external', domain }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.project.customDomain).toBeNull()
    expect(body.project.domain).toBe(domain)
    expect(body.project.subdomain).toBeUndefined()
    expect(body.project.pendingDomain?.domain).toBe(domain)
    const row = await db.websiteDomain.findUnique({ where: { domain } })
    expect(row).toMatchObject({ projectId: body.project.id, verified: false, isPrimary: true })
  })

  it('a domain in the account becomes the site domain at once', async () => {
    const domain = `${uid('owned')}.com`.toLowerCase()
    await db.domain.create({ data: { userId: admin.id, name: domain, status: 'active', provider: 'dynadot' } })
    const res = await post(create.POST, admin, '/api/hosting/create', wizard({ domainType: 'existing', domain }))
    expect(res.status).toBe(201)
    const project = await db.project.findUniqueOrThrow({ where: { id: (await res.json()).project.id } })
    expect(project.customDomain).toBe(domain)
  })
})

describe('importing a website requires a domain', () => {
  it('no domain → 400 before anything is created', async () => {
    const before = await db.project.count({ where: { userId: customer.id } })
    const res = await post(importRoute.POST, customer, '/api/hosting/import', {
      name: uid('moved'),
      sourceType: 'wordpress-backup',
      sourceMode: 'upload',
      uploadId: 'does-not-matter',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(DOMAIN_REQUIRED_MESSAGE)
    expect(await db.project.count({ where: { userId: customer.id } })).toBe(before)
  })
})

describe('unauthenticated', () => {
  it('create and import refuse a request without a session', async () => {
    const anon = { ...customer, token: null as unknown as string }
    expect((await post(create.POST, anon, '/api/hosting/create', wizard({}))).status).toBe(401)
    expect((await post(importRoute.POST, anon, '/api/hosting/import', { name: 'x' })).status).toBe(401)
  })
})

describe('platform-zone cleanup of retired site addresses', () => {
  it('deletes exactly the project subdomain records and logs them; skips when the zone is not ours', async () => {
    const { cleanupPlatformSiteRecords } = await import('@/lib/site-dns-cleanup')
    const brand = 'apsamo.com'
    const deleted: Array<{ name: string; type: string }> = []
    const r = await cleanupPlatformSiteRecords({
      brand,
      isConfigured: () => true,
      zoneExists: async () => true,
      getZoneRecords: async () => [
        { name: 'panel.apsamo.com', type: 'A' },
        { name: 'mail.apsamo.com', type: 'A' },
        { name: 'apsamo.com', type: 'MX' },
        { name: 'shop-1a2b.apsamo.com', type: 'A' },
        { name: 'www.shop-1a2b.apsamo.com', type: 'CNAME' },
      ],
      listProjectSubdomains: async () => ['shop-1a2b.apsamo.com', 'panel.apsamo.com'],
      deleteRecordSets: async (_zone, rrsets) => {
        deleted.push(...rrsets)
        return { ok: true, detail: 'ok' }
      },
    })
    expect(deleted).toEqual([
      { name: 'shop-1a2b.apsamo.com', type: 'A' },
      { name: 'www.shop-1a2b.apsamo.com', type: 'CNAME' },
    ])
    expect(r.removed).toHaveLength(2)

    const skipped = await cleanupPlatformSiteRecords({
      brand,
      isConfigured: () => true,
      zoneExists: async () => false,
      deleteRecordSets: async () => {
        throw new Error('must not be called')
      },
    })
    expect(skipped.skipped).toMatch(/not hosted/)
    expect(skipped.removed).toEqual([])
  })
})
