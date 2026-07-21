/**
 * tests/unit/totp.test.ts
 * ════════════════════════════════════════════════════════════════════════════
 * Two-factor authentication round-trip.
 *
 * Added while migrating otplib 12 → 13, which replaced the `authenticator`
 * singleton with a class API and — critically — changed `verify` to return a
 * RESULT OBJECT rather than a boolean. A naive port (`return totp.verifySync(…)`)
 * would be truthy for every input, silently accepting any 6 digits as a valid
 * second factor. These tests exist to catch exactly that.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'bun:test'

process.env.JWT_SECRET = 'test-secret-not-for-production-use-32chars-min'
process.env.ENCRYPTION_KEY =
  '0000000000000000000000000000000000000000000000000000000000000000'

import {
  generateSecret,
  generateToken,
  verifyToken,
  generateQRCode,
} from '../../src/lib/totp'

describe('TOTP two-factor', () => {
  it('generates a base32 secret', () => {
    const s = generateSecret()
    expect(s.length).toBeGreaterThan(15)
    expect(/^[A-Z2-7]+=*$/.test(s)).toBe(true)
  })

  it('generates a 6-digit token', () => {
    expect(/^\d{6}$/.test(generateToken(generateSecret()))).toBe(true)
  })

  it('accepts the correct current token', () => {
    const secret = generateSecret()
    expect(verifyToken(generateToken(secret), secret)).toBe(true)
  })

  // The migration-hazard tests: each of these passes trivially if verify
  // returns a truthy object instead of a boolean.
  it('REJECTS a wrong token', () => {
    const secret = generateSecret()
    const right = generateToken(secret)
    const wrong = right === '000000' ? '111111' : '000000'
    expect(verifyToken(wrong, secret)).toBe(false)
  })

  it('REJECTS a valid token generated from a different secret', () => {
    const secret = generateSecret()
    expect(verifyToken(generateToken(generateSecret()), secret)).toBe(false)
  })

  it('REJECTS non-numeric garbage', () => {
    const secret = generateSecret()
    expect(verifyToken('abcdef', secret)).toBe(false)
    expect(verifyToken('', secret)).toBe(false)
  })

  it('tolerates whitespace a user might paste', () => {
    const secret = generateSecret()
    const t = generateToken(secret)
    expect(verifyToken(`${t.slice(0, 3)} ${t.slice(3)}`, secret)).toBe(true)
  })

  it('builds a scannable otpauth QR code', async () => {
    const uri = await generateQRCode(generateSecret(), 'user@example.com', 'Apsamo Panel')
    expect(uri.startsWith('data:image/png;base64,')).toBe(true)
  })
})
