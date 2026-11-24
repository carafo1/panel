/**
 * tests/unit/safe-fetch.test.ts
 *
 * Outbound fetches of tenant URLs (webhooks, uptime monitors) must:
 *   - refuse every non-public IPv6 form, including NAT64 (64:ff9b::/96),
 *     6to4 (2002::/16) and hex-written IPv4-mapped addresses;
 *   - connect only to the address that passed the check (pinned request);
 *   - never follow a redirect into a private address.
 * Plus HTML escaping of user values in transactional emails.
 */
import { describe, it, expect, afterAll } from 'bun:test'
import {
  isBlockedAddress,
  parseIpv6,
  checkPublicUrlSyntax,
  pinnedRequest,
  fetchPublicTarget,
  readTextCapped,
  assertPublicUrl,
} from '../../src/lib/ssrf'
import { escapeHtml } from '../../src/lib/email'

describe('IPv6 blocklist additions', () => {
  const blocked = [
    '64:ff9b::a9fe:a9fe', // NAT64 → 169.254.169.254
    '64:ff9b::127.0.0.1',
    '64:ff9b:1::1',
    '2002:7f00:1::1', // 6to4 of 127.0.0.1
    '2002::',
    '::ffff:7f00:1', // IPv4-mapped loopback, hex form (what URL parsing produces)
    '::ffff:a9fe:a9fe',
    '::127.0.0.1', // IPv4-compatible
    'fec0::1', // site-local
    '2001::1', // Teredo
    '2001:db8::1',
    '100::1',
  ]
  for (const ip of blocked) it(`blocks ${ip}`, () => expect(isBlockedAddress(ip)).toBe(true))

  for (const ip of ['2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '::ffff:808:808']) {
    it(`allows ${ip}`, () => expect(isBlockedAddress(ip)).toBe(false))
  }

  it('blocks unparseable input defensively', () => {
    expect(isBlockedAddress('not:an:ip')).toBe(true)
    expect(isBlockedAddress('1.2.3')).toBe(true)
  })

  it('parses compressed and v4-tailed forms', () => {
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(parseIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304])
  })
})

describe('checkPublicUrlSyntax (save-time)', () => {
  it('accepts a public https URL', () => expect(checkPublicUrlSyntax('https://example.com/hook')).toBeNull())
  it('refuses other schemes', () => expect(checkPublicUrlSyntax('file:///etc/passwd')).not.toBeNull())
  it('refuses localhost and private literals', () => {
    expect(checkPublicUrlSyntax('http://localhost:3000/')).not.toBeNull()
    expect(checkPublicUrlSyntax('http://[::ffff:127.0.0.1]/')).not.toBeNull()
    expect(checkPublicUrlSyntax('http://169.254.169.254/')).not.toBeNull()
  })
  it('refuses embedded credentials', () => expect(checkPublicUrlSyntax('https://u:p@example.com/')).not.toBeNull())
})

describe('assertPublicUrl', () => {
  it('rejects a hex-form IPv4-mapped loopback literal', async () => {
    await expect(assertPublicUrl('http://[::ffff:127.0.0.1]/')).rejects.toThrow()
  })
  it('returns the checked target for a public literal', async () => {
    const t = await assertPublicUrl('https://1.1.1.1/x')
    expect(t.address).toBe('1.1.1.1')
    expect(t.isIpLiteral).toBe(true)
  })
})

describe('pinnedRequest', () => {
  it('connects to the checked address and keeps Host / SNI', () => {
    const r = pinnedRequest(
      { url: new URL('https://hooks.example.com:8443/in?a=1'), host: 'hooks.example.com', address: '93.184.216.34', family: 4, isIpLiteral: false },
      { method: 'POST', headers: { 'X-Test': '1' } }
    )
    expect(r.url).toBe('https://93.184.216.34:8443/in?a=1')
    const h = r.init.headers as Headers
    expect(h.get('host')).toBe('hooks.example.com:8443')
    expect(h.get('x-test')).toBe('1')
    expect(r.init.tls).toEqual({ serverName: 'hooks.example.com' })
    expect(r.init.redirect).toBe('manual')
    expect(r.init.proxy).toBe(false)
  })
  it('brackets IPv6 addresses', () => {
    const r = pinnedRequest({ url: new URL('http://example.com/'), host: 'example.com', address: '2606:4700::1', family: 6, isIpLiteral: false })
    expect(r.url).toBe('http://[2606:4700::1]/')
  })
})

describe('redirects are not followed', () => {
  let internalHits = 0
  const internal = Bun.serve({ port: 0, fetch: () => { internalHits++; return new Response('secret') } })
  const bouncer = Bun.serve({
    port: 0,
    fetch: () => new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${internal.port}/` } }),
  })
  afterAll(() => {
    internal.stop(true)
    bouncer.stop(true)
  })

  it('returns the 3xx itself and never reaches the redirect target', async () => {
    // Target omitted = the guard was bypassed (as tests do for localhost);
    // the redirect policy must still hold.
    const res = await fetchPublicTarget(undefined, `http://127.0.0.1:${bouncer.port}/`)
    expect(res.status).toBe(302)
    expect(internalHits).toBe(0)
  })
})

describe('readTextCapped', () => {
  it('stops reading at the cap', async () => {
    const big = new Response('x'.repeat(100_000))
    const { text, truncated } = await readTextCapped(big, 1000)
    expect(text.length).toBe(1000)
    expect(truncated).toBe(true)
  })
  it('reads a small body whole', async () => {
    expect(await readTextCapped(new Response('ok'), 1000)).toEqual({ text: 'ok', truncated: false })
  })
})

describe('email escaping', () => {
  it('escapes markup and quotes', () => {
    expect(escapeHtml('<a href="https://evil">x</a> & \'y\'')).toBe(
      '&lt;a href=&quot;https://evil&quot;&gt;x&lt;/a&gt; &amp; &#39;y&#39;'
    )
  })
})
