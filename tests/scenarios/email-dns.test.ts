/**
 * Domains → DNS → "Generate email records".
 *
 * The panel used to insert `p=PLACEHOLDER_REPLACE_WITH_DKIM_KEY` as the DKIM
 * record. Published to DNS, that makes receivers fail DKIM and file the
 * customer's mail as spam. The endpoint now returns the real key from Mailcow,
 * or no DKIM record at all with a reason. Mailcow is faked at the fetch layer.
 */
import { describe, it, expect, beforeAll, afterEach } from 'bun:test'
import { db } from '@/lib/db'
import * as emailDns from '@/app/api/domains/[id]/email-dns/route'
import { makeUser, authed, params, uid } from './helpers'

const REAL_FETCH = globalThis.fetch
const DKIM_TXT = 'v=DKIM1;k=rsa;t=s;s=email;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtestkey'

type Owner = Awaited<ReturnType<typeof makeUser>>
let owner: Owner
let other: Owner
let domainId: string
let domainName: string

/** Point the Mailcow client at a fake server for one test. */
function fakeMailcow(handler: (path: string) => unknown) {
  process.env.MAILCOW_API_URL = 'https://mailcow.fake.test'
  process.env.MAILCOW_API_KEY = 'fake-key-for-tests'
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (!url.startsWith('https://mailcow.fake.test/api/v1')) return REAL_FETCH(input)
    const body = handler(url.replace('https://mailcow.fake.test/api/v1', ''))
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
}

const call = async (token: string, id: string, qs = '') => {
  const res = await emailDns.GET(authed(token, `/api/domains/${id}/email-dns${qs}`), params({ id }))
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

beforeAll(async () => {
  owner = await makeUser('dns-owner')
  other = await makeUser('dns-other')
  domainName = `${uid('mail')}.example.test`.toLowerCase()
  const d = await db.domain.create({ data: { userId: owner.id, name: domainName, status: 'active' } })
  domainId = d.id
})

afterEach(() => {
  globalThis.fetch = REAL_FETCH
  delete process.env.MAILCOW_API_URL
  delete process.env.MAILCOW_API_KEY
})

describe('GET /api/domains/[id]/email-dns', () => {
  it('never returns a placeholder DKIM record when Mailcow is not connected', async () => {
    const { status, body } = await call(owner.token, domainId, '?mx=mail.example.com')
    expect(status).toBe(200)
    expect(JSON.stringify(body)).not.toContain('PLACEHOLDER')
    expect(body.records.map((r: { type: string; name: string }) => `${r.type} ${r.name}`)).toEqual([
      'MX @',
      'TXT @',
      'TXT _dmarc',
    ])
    expect(body.records[0].value).toBe('mail.example.com')
    expect(body.dkim).toMatchObject({ available: false, reason: 'mailcow_not_configured' })
    expect(body.dkim.message.length).toBeGreaterThan(10)
  })

  it('includes the real DKIM key from Mailcow when the domain has one', async () => {
    fakeMailcow((path) => {
      if (path.startsWith('/get/domain/')) return [{ domain_name: domainName, active: '1' }]
      if (path.startsWith('/get/dkim/')) return { dkim_txt: DKIM_TXT, dkim_selector: 'dkim', length: '2048' }
      return {}
    })
    const { status, body } = await call(owner.token, domainId, '?mx=mail.example.com')
    expect(status).toBe(200)
    const dkim = body.records.find((r: { name: string }) => r.name.endsWith('._domainkey'))
    expect(dkim).toBeDefined()
    expect(dkim.name).toBe('dkim._domainkey')
    expect(dkim.value).toContain('p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtestkey')
    expect(body.dkim).toEqual({ available: true, name: 'dkim._domainkey' })
  })

  it('explains that email is not set up when Mailcow does not know the domain', async () => {
    fakeMailcow(() => [])
    const { body } = await call(owner.token, domainId)
    expect(body.dkim).toMatchObject({ available: false, reason: 'no_key' })
    expect(body.records.some((r: { name: string }) => r.name.endsWith('._domainkey'))).toBe(false)
  })

  it('defaults the mail server to the configured host', async () => {
    const { body } = await call(owner.token, domainId)
    expect(typeof body.mailServer).toBe('string')
    expect(body.mailServer).toMatch(/^mail\./)
  })

  it('rejects an invalid mail server hostname', async () => {
    const { status } = await call(owner.token, domainId, `?mx=${encodeURIComponent('bad host; rm -rf /')}`)
    expect(status).toBe(400)
  })

  it("does not reveal another customer's domain", async () => {
    const { status } = await call(other.token, domainId)
    expect(status).toBe(404)
  })

  it('requires a login', async () => {
    const res = await emailDns.GET(authed(null, `/api/domains/${domainId}/email-dns`), params({ id: domainId }))
    expect(res.status).toBe(401)
  })
})
