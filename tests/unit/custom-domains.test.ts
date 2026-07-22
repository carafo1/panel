/**
 * tests/unit/custom-domains.test.ts
 * ════════════════════════════════════════════════════════════════════════════
 * Guards on attaching externally-registered domains.
 *
 * Before this existed, a customer could attach ANY hostname — including one
 * already serving another tenant, or the control panel's own — and mark it
 * verified themselves with a PATCH of {verified: true}. These tests pin the
 * rules that replaced that.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'bun:test'

process.env.JWT_SECRET = 'test-secret-not-for-production-use-32chars-min'
process.env.ENCRYPTION_KEY =
  '0000000000000000000000000000000000000000000000000000000000000000'

import {
  isValidHostname,
  isReservedHostname,
  generateVerificationToken,
  describeConnection,
} from '../../src/lib/custom-domains'

describe('custom domain hostname validation', () => {
  it('accepts ordinary domains and subdomains', () => {
    for (const h of ['example.com', 'www.example.com', 'a.b.example.co.uk', 'x-y.example.com']) {
      expect(isValidHostname(h)).toBe(true)
    }
  })

  it('rejects input that would corrupt a Caddy site block', () => {
    for (const h of [
      '',
      'localhost',        // no TLD
      'example',          // no dot
      '.example.com',     // leading dot
      'example.com.',     // trailing dot
      'a..b.com',         // empty label
      '-bad.example.com', // label starts with a hyphen
      'bad-.example.com', // label ends with a hyphen
      '192.168.1.1',      // an IP, not a name
      'exam ple.com',     // whitespace
    ]) {
      expect(isValidHostname(h)).toBe(false)
    }
  })

  it('rejects the platform\'s own hostnames', () => {
    // Serving the panel's hostname from a customer container would be a
    // session-theft / phishing vector.
    expect(isReservedHostname('apsamo.com', 'apsamo.com')).toBe(true)
    expect(isReservedHostname('panel.apsamo.com', 'apsamo.com')).toBe(true)
    expect(isReservedHostname('mail.apsamo.com', 'apsamo.com')).toBe(true)
    expect(isReservedHostname('anything.apsamo.com', 'apsamo.com')).toBe(true)
  })

  it('allows a customer domain that merely contains the brand name', () => {
    // Must not over-block: "apsamo.com.evil.net" is not ours, but neither is
    // a legitimate customer domain like "myapsamo.com".
    expect(isReservedHostname('myapsamo.com', 'apsamo.com')).toBe(false)
    expect(isReservedHostname('example.com', 'apsamo.com')).toBe(false)
  })

  it('issues unique, high-entropy verification tokens', () => {
    const a = generateVerificationToken()
    const b = generateVerificationToken()
    expect(a).not.toBe(b)
    expect(a.startsWith('apsamo-verify-')).toBe(true)
    // 16 random bytes as hex.
    expect(a.length).toBeGreaterThanOrEqual('apsamo-verify-'.length + 32)
  })
})

/**
 * The connection pipeline shown to the customer.
 *
 * "Live" must mean an HTTPS request actually succeeded — not merely that the
 * hostname was written into a config file. The stage is derived from observed
 * facts, so these tests pin that a domain cannot appear Live prematurely.
 */
describe('connection pipeline stages', () => {
  // Nameserver delegation is the default method, so a fresh domain starts by
  // waiting on the registrar change — not on a DNS record.
  const base = {
    verified: false,
    sslEnabled: true,
    sslStatus: 'none' as string,
    connectionMethod: 'nameserver',
    zoneCreated: false,
  }

  it('starts at Waiting for Nameserver Update and asks the customer to act', () => {
    const c = describeConnection(base)
    expect(c.stage).toBe('awaiting_nameservers')
    expect(c.label).toContain('Nameserver')
    expect(c.needsAction).toBe(true)
    expect(c.percent).toBeLessThan(50)
  })

  it('surfaces the DNS reason when there is one', () => {
    const c = describeConnection({
      ...base,
      lastCheckError: 'example.com currently points to 1.2.3.4, not to this server.',
    })
    expect(c.detail).toContain('1.2.3.4')
  })

  it('reports Nameservers Verified before the zone is published', () => {
    // Delegation proven but our zone isn't live yet — the domain resolves to
    // nothing in this window, so it must not claim to be connected.
    const c = describeConnection({ ...base, verified: true, zoneCreated: false })
    expect(c.stage).toBe('nameservers_verified')
    expect(c.percent).toBeLessThan(100)
  })

  it('is NOT live once verified but before the certificate exists', () => {
    const c = describeConnection({
      ...base,
      verified: true,
      zoneCreated: true,
      sslStatus: 'pending',
    })
    expect(c.stage).toBe('installing_ssl')
    expect(c.stage).not.toBe('live')
    expect(c.percent).toBeLessThan(100)
  })

  it('reaches Live only when the certificate is confirmed issued', () => {
    const c = describeConnection({
      ...base,
      verified: true,
      zoneCreated: true,
      sslStatus: 'issued',
    })
    expect(c.stage).toBe('live')
    expect(c.percent).toBe(100)
    expect(c.needsAction).toBe(false)
  })

  it('treats an SSL-disabled domain as live once verified', () => {
    const c = describeConnection({
      verified: true,
      sslEnabled: false,
      sslStatus: 'none',
      connectionMethod: 'nameserver',
      zoneCreated: true,
    })
    expect(c.stage).toBe('live')
  })

  it('uses record wording for the advanced (manual DNS) method', () => {
    const c = describeConnection({ ...base, connectionMethod: 'manual' })
    expect(c.stage).toBe('awaiting_nameservers')
    expect(c.label).toContain('DNS Record')
  })

  it('does not gate the manual method on a zone we do not host', () => {
    // With manual DNS the customer keeps their own host, so there is no
    // Apsamo zone to wait for — it must go straight to SSL.
    const c = describeConnection({
      ...base,
      connectionMethod: 'manual',
      verified: true,
      zoneCreated: false,
      sslStatus: 'pending',
    })
    expect(c.stage).toBe('installing_ssl')
  })

  it('reports a cross-tenant clash as blocked, not merely pending', () => {
    const c = describeConnection({
      ...base,
      lastCheckError: 'Domain is now in use by another site on this platform.',
    })
    expect(c.stage).toBe('blocked')
    expect(c.needsAction).toBe(true)
  })
})
