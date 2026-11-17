/** Cloudflare CDN/WAF/DDoS: honest pricing, plan gating and the exact API calls made. */
import { describe, it, expect, spyOn, afterEach } from 'bun:test'
import { db } from '@/lib/db'
import { zoneNameFor } from '@/lib/cdn'
import * as plans from '@/app/api/billing/plans/route'
import * as cdn from '@/app/api/hosting/[id]/cdn/route'
import * as zone from '@/app/api/hosting/[id]/cdn/[zoneId]/route'
import * as adminCf from '@/app/api/admin/cloudflare/route'
import { makeUser, makeProject, makePlan, authed, params } from './helpers'

let ip = 0
const h = () => ({ 'x-forwarded-for': `10.44.${++ip & 255}.${(ip >> 8) & 255}` })

type Call = { method: string; path: string; body: unknown }
function mockCloudflare() {
  const calls: Call[] = []
  const spy = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = url.pathname.replace('/client/v4', '') + url.search
    const method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, body })
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 })
    if (path === '/user/tokens/verify') return ok({ status: 'active' })
    if (path.startsWith('/accounts')) return ok([{ id: 'acct-1', name: 'Apsamo' }])
    if (method === 'POST' && path === '/zones') return ok({ id: 'zone-1', status: 'pending', name_servers: ['kim.ns.cloudflare.com', 'lou.ns.cloudflare.com'] })
    if (method === 'GET' && path.startsWith('/zones/zone-1/dns_records')) return ok([{ id: 'rec-old', type: 'A', content: '1.2.3.4' }, { id: 'mx', type: 'MX', content: 'mail' }])
    if (method === 'GET' && path === '/zones/zone-1') return ok({ status: 'active', name_servers: ['kim.ns.cloudflare.com', 'lou.ns.cloudflare.com'] })
    return ok({})
  }) as typeof fetch)
  return { calls, restore: () => spy.mockRestore() }
}

afterEach(async () => {
  await db.appSetting.deleteMany({ where: { key: { startsWith: 'cloudflare.' } } })
})

describe('CDN', () => {
  it('finds the zone for a hostname', () => {
    expect(zoneNameFor('shop.example.com')).toBe('example.com')
    expect(zoneNameFor('www.example.co.uk')).toBe('example.co.uk')
    expect(zoneNameFor('example.org')).toBe('example.org')
  })

  it('pricing does not advertise CDN, WAF or DDoS until Cloudflare is connected', async () => {
    await makePlan({ cdnIntegration: true, wafLevel: 'Advanced', ddosLevel: 'Advanced', active: true })
    const env = process.env.NODE_ENV
    ;(process.env as Record<string, string>).NODE_ENV = 'production'
    try {
      const data = await (await plans.GET(new Request('http://localhost/api/billing/plans'))).json()
      expect(data.plans.length).toBeGreaterThan(0)
      for (const p of data.plans) {
        expect(p.cdnIntegration).toBe(false)
        expect(p.wafLevel).toBeNull()
        expect(p.ddosLevel).toBeNull()
      }
    } finally {
      ;(process.env as Record<string, string>).NODE_ENV = env!
    }
  })

  it('admin connects Cloudflare; the token is stored encrypted and never returned', async () => {
    const cf = mockCloudflare()
    try {
      const admin = await makeUser('cf-admin', 'admin')
      const res = await adminCf.PUT(authed(admin.token, '/api/admin/cloudflare', { method: 'PUT', body: JSON.stringify({ token: 'cf-token-abcdefghijklmnopqrstuvwxyz' }) }))
      expect(res.status).toBe(200)
      const stored = await db.appSetting.findUnique({ where: { key: 'cloudflare.apiToken' } })
      expect(stored?.value).not.toContain('cf-token-abcdefghijklmnopqrstuvwxyz')
      const status = await (await adminCf.GET(authed(admin.token, '/api/admin/cloudflare'))).json()
      expect(status.mode).toBe('live')
      expect(JSON.stringify(status)).not.toContain('cf-token')
      const cust = await makeUser('cf-cust')
      expect((await adminCf.GET(authed(cust.token, '/api/admin/cloudflare'))).status).toBe(403)
    } finally {
      cf.restore()
    }
  })

  it('protects a site domain: imports DNS, proxies only the site hostnames, SSL full, no forced HTTPS', async () => {
    const admin = await makeUser('cf-admin2', 'admin')
    const cf = mockCloudflare()
    try {
      await adminCf.PUT(authed(admin.token, '/api/admin/cloudflare', { method: 'PUT', body: JSON.stringify({ token: 'cf-token-abcdefghijklmnopqrstuvwxyz' }) }))
      const u = await makeUser('cf-owner')
      const plan = await makePlan({ cdnIntegration: true, ddosLevel: null })
      await db.subscription.create({ data: { userId: u.id, planId: plan.id, status: 'active', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400_000) } })
      const server = await db.server.create({ data: { name: 'cf', ip: '203.0.113.9', cpuCores: 1, ramGB: 1, storageGB: 10, bandwidthGB: 100 } })
      const domain = `shop-${Date.now()}.example.com`
      const site = await makeProject(u.id, { serverId: server.id, customDomain: `www.${domain}` })

      // Not this site's domain.
      const wrong = await cdn.POST(authed(u.token, `/api/hosting/${site.id}/cdn`, { method: 'POST', body: JSON.stringify({ domain: 'someone-else.com' }), headers: h() }), params({ id: site.id }))
      expect(wrong.status).toBe(404)

      const info = await (await cdn.GET(authed(u.token, `/api/hosting/${site.id}/cdn`), params({ id: site.id }))).json()
      expect(info.candidates).toEqual(['example.com'])

      cf.calls.length = 0
      const res = await cdn.POST(authed(u.token, `/api/hosting/${site.id}/cdn`, { method: 'POST', body: JSON.stringify({ domain: 'example.com' }), headers: h() }), params({ id: site.id }))
      expect(res.status).toBe(201)
      const { zone: z } = await res.json()
      expect(z.nameservers).toEqual(['kim.ns.cloudflare.com', 'lou.ns.cloudflare.com'])

      const create = cf.calls.find((c) => c.method === 'POST' && c.path === '/zones')!
      expect(create.body).toMatchObject({ name: 'example.com', type: 'full', jump_start: true, account: { id: 'acct-1' } })
      // The old A record for the site host is replaced; MX is left alone.
      expect(cf.calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/dns_records/rec-old'))).toBe(true)
      expect(cf.calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/dns_records/mx'))).toBe(false)
      const rec = cf.calls.find((c) => c.method === 'POST' && c.path === '/zones/zone-1/dns_records')!
      expect(rec.body).toMatchObject({ type: 'A', name: `www.${domain}`, content: '203.0.113.9', proxied: true })
      expect(cf.calls.find((c) => c.path === '/zones/zone-1/settings/ssl')?.body).toEqual({ value: 'full' })
      expect(cf.calls.some((c) => c.path.includes('always_use_https'))).toBe(false)

      // Under-attack mode needs a plan with a DDoS tier.
      const ua = await zone.PATCH(authed(u.token, '/x', { method: 'PATCH', body: JSON.stringify({ securityLevel: 'under_attack' }) }), params({ id: site.id, zoneId: z.id }))
      expect(ua.status).toBe(403)
      const hi = await zone.PATCH(authed(u.token, '/x', { method: 'PATCH', body: JSON.stringify({ securityLevel: 'high' }) }), params({ id: site.id, zoneId: z.id }))
      expect(hi.status).toBe(200)
      expect(cf.calls.find((c) => c.path === '/zones/zone-1/settings/security_level')?.body).toEqual({ value: 'high' })

      const refreshed = await (await zone.POST(authed(u.token, '/x', { method: 'POST', body: JSON.stringify({ action: 'refresh' }), headers: h() }), params({ id: site.id, zoneId: z.id }))).json()
      expect(refreshed.zone.status).toBe('active')

      const purge = await zone.POST(authed(u.token, '/x', { method: 'POST', body: JSON.stringify({ action: 'purge' }), headers: h() }), params({ id: site.id, zoneId: z.id }))
      expect(purge.status).toBe(200)
      expect(cf.calls.some((c) => c.path === '/zones/zone-1/purge_cache')).toBe(true)

      const del = await zone.DELETE(authed(u.token, '/x', { method: 'DELETE' }), params({ id: site.id, zoneId: z.id }))
      expect(del.status).toBe(200)
      expect(cf.calls.some((c) => c.method === 'DELETE' && c.path === '/zones/zone-1')).toBe(true)
      expect(await db.cdnZone.count({ where: { projectId: site.id } })).toBe(0)
    } finally {
      cf.restore()
    }
  })

  it('is refused on plans without CDN', async () => {
    const u = await makeUser('cf-noplan')
    const plan = await makePlan({ cdnIntegration: false })
    await db.subscription.create({ data: { userId: u.id, planId: plan.id, status: 'active', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400_000) } })
    const site = await makeProject(u.id, { customDomain: `nocdn-${Date.now()}.com` })
    const res = await cdn.POST(authed(u.token, `/api/hosting/${site.id}/cdn`, { method: 'POST', body: JSON.stringify({ domain: site.customDomain }), headers: h() }), params({ id: site.id }))
    expect(res.status).toBe(403)
  })
})
