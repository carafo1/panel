/**
 * tests/unit/ssrf.test.ts — unit tests for the SSRF guard (src/lib/ssrf.ts).
 * IP-literal cases are deterministic (dns.lookup of a literal needs no network).
 */
import { describe, it, expect } from 'bun:test'
import { isBlockedAddress, assertPublicUrl } from '../../src/lib/ssrf'

describe('ssrf guard', () => {
  describe('isBlockedAddress — must block', () => {
    const blocked = [
      '127.0.0.1', // loopback
      '169.254.169.254', // cloud metadata
      '10.0.0.5', // RFC1918
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '::1', // v6 loopback
      '::',
      'fe80::1', // link-local
      'fc00::1', // ULA
      'fd12:3456::1',
      'ff02::1', // multicast
      '::ffff:127.0.0.1', // v4-mapped loopback
    ]
    for (const ip of blocked) {
      it(`blocks ${ip}`, () => expect(isBlockedAddress(ip)).toBe(true))
    }
  })

  describe('isBlockedAddress — must allow public', () => {
    const allowed = [
      '8.8.8.8',
      '1.1.1.1',
      '172.15.0.1', // just outside 172.16/12
      '172.32.0.1',
      '93.184.216.34',
      '2606:4700:4700::1111',
      '::ffff:8.8.8.8', // v4-mapped public
    ]
    for (const ip of allowed) {
      it(`allows ${ip}`, () => expect(isBlockedAddress(ip)).toBe(false))
    }
  })

  describe('assertPublicUrl', () => {
    it('rejects non-http(s) schemes', async () => {
      await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow()
    })
    it('rejects loopback literal', async () => {
      await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toThrow()
    })
    it('rejects cloud-metadata literal', async () => {
      await expect(
        assertPublicUrl('http://169.254.169.254/latest/meta-data/')
      ).rejects.toThrow()
    })
  })
})
