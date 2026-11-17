/** Dynadot keys saved from Admin: encrypted, override .env, never returned, testable. */
import { describe, it, expect, spyOn, afterEach } from 'bun:test'
import { db } from '@/lib/db'
import * as route from '@/app/api/admin/dynadot/route'
import { applyDynadotSettings } from '@/lib/dynadot-settings'
import { dynadotService } from '@/lib/dynadot-service'
import { makeUser, authed } from './helpers'

const KEY = 'TestKeyAbc123456789XYZtestkey'
const SECRET = 'abcdef0123456789abcdef0123456789'

function mockDynadot(reply: (url: URL) => unknown) {
  const urls: URL[] = []
  const spy = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    urls.push(url)
    return new Response(JSON.stringify(reply(url)), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch)
  return { urls, restore: () => spy.mockRestore() }
}

afterEach(async () => {
  await db.appSetting.deleteMany({ where: { key: { startsWith: 'dynadot.' } } })
  await applyDynadotSettings()
})

describe('Dynadot keys in Admin', () => {
  it('only admins can see or change them', async () => {
    const u = await makeUser('dyn-cust')
    expect((await route.GET(authed(u.token, '/api/admin/dynadot'))).status).toBe(403)
    expect((await route.PUT(authed(u.token, '/api/admin/dynadot', { method: 'PUT', body: JSON.stringify({ apiKey: KEY }) }))).status).toBe(403)
  })

  it('saves encrypted, takes effect at once, never returns the key, and can be removed', async () => {
    const admin = await makeUser('dyn-admin', 'admin')
    const before = process.env.DYNADOT_API_KEY
    const dyn = mockDynadot(() => ({ SearchResponse: { ResponseCode: 0, SearchResults: [{ DomainName: 'x.com', Available: 'yes' }] } }))
    try {
      const res = await route.PUT(authed(admin.token, '/api/admin/dynadot', { method: 'PUT', body: JSON.stringify({ apiKey: KEY, secretKey: SECRET }) }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(JSON.stringify(body)).not.toContain(KEY)
      expect(body.source).toBe('settings')
      expect(body.keyHint).toBe(`…${KEY.slice(-4)}`)
      expect(body.test.ok).toBe(true)

      const stored = await db.appSetting.findUnique({ where: { key: 'dynadot.apiKey' } })
      expect(stored?.value).not.toContain(KEY)
      expect(process.env.DYNADOT_API_KEY).toBe(KEY)
      // The long-lived service sees the new key without a restart.
      expect(dynadotService.demoMode).toBe(false)
      // The test call went to Dynadot with the saved key and was a search only.
      expect(dyn.urls[0].hostname).toBe('api.dynadot.com')
      expect(dyn.urls[0].searchParams.get('key')).toBe(KEY)
      expect(dyn.urls[0].searchParams.get('command')).toBe('search')
    } finally {
      dyn.restore()
    }

    const cleared = await (await route.DELETE(authed(admin.token, '/api/admin/dynadot', { method: 'DELETE' }))).json()
    expect(cleared.source).toBe(before ? 'env' : null)
    expect(process.env.DYNADOT_API_KEY).toBe(before)
  })

  it('test reports the IP Dynadot refused', async () => {
    const admin = await makeUser('dyn-ip', 'admin')
    const dyn = mockDynadot(() => ({ Response: { ResponseCode: -1, Status: 'error', Error: 'unauthorized ip address: 203.0.113.7' } }))
    try {
      const r = await (await route.PUT(authed(admin.token, '/api/admin/dynadot', { method: 'PUT', body: JSON.stringify({ apiKey: KEY }) }))).json()
      expect(r.test.ok).toBe(false)
      expect(r.test.blockedIp).toBe('203.0.113.7')
      expect(r.test.message).not.toContain(KEY)
    } finally {
      dyn.restore()
    }
  })

  it('rejects keys that are not plain letters and numbers', async () => {
    const admin = await makeUser('dyn-bad', 'admin')
    const r = await route.PUT(authed(admin.token, '/api/admin/dynadot', { method: 'PUT', body: JSON.stringify({ apiKey: 'short' }) }))
    expect(r.status).toBe(400)
    const r2 = await route.PUT(authed(admin.token, '/api/admin/dynadot', { method: 'PUT', body: JSON.stringify({ apiKey: KEY, secretKey: 'has spaces and !' }) }))
    expect(r2.status).toBe(400)
  })
})
