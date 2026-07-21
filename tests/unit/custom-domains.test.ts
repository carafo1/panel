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
