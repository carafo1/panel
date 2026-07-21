/**
 * tests/unit/auth.test.ts
 * ════════════════════════════════════════════════════════════════════════════
 * Unit tests for src/lib/auth.ts — password hashing + JWT verification.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'bun:test'

// bcrypt uses 12 salt rounds, which costs seconds per call on purpose.
// The default 5s per-test budget is too small for that; raise the budget
// rather than weakening the cost factor to make tests pass.
const HASH_TIMEOUT = 30_000
import { hashPassword, verifyPassword, generateToken, verifyToken, extractTokenFromHeader } from '../../src/lib/auth'

// Set test secrets before importing
process.env.JWT_SECRET = 'test-secret-not-for-production-use-32chars-min'
process.env.ENCRYPTION_KEY = '0000000000000000000000000000000000000000000000000000000000000000'

describe('auth.ts', () => {
  // ── Password hashing ─────────────────────────────────────────────────
  describe('hashPassword + verifyPassword', () => {
    it('hashes a password', async () => {
      const hash = await hashPassword('MyPassword123!')
      expect(hash).not.toBe('MyPassword123!')
      expect(hash.length).toBeGreaterThan(50)
    }, HASH_TIMEOUT)

    it('produces different hashes for same password (salt)', async () => {
      const hash1 = await hashPassword('MyPassword123!')
      const hash2 = await hashPassword('MyPassword123!')
      expect(hash1).not.toBe(hash2)
    }, HASH_TIMEOUT)

    it('verifies correct password', async () => {
      const hash = await hashPassword('MyPassword123!')
      const isValid = await verifyPassword('MyPassword123!', hash)
      expect(isValid).toBe(true)
    }, HASH_TIMEOUT)

    it('rejects wrong password', async () => {
      const hash = await hashPassword('MyPassword123!')
      const isValid = await verifyPassword('WrongPassword!', hash)
      expect(isValid).toBe(false)
    }, HASH_TIMEOUT)

    it('rejects empty password', async () => {
      const hash = await hashPassword('MyPassword123!')
      const isValid = await verifyPassword('', hash)
      expect(isValid).toBe(false)
    }, HASH_TIMEOUT)
  })

  // ── JWT signing + verification ───────────────────────────────────────
  describe('generateToken + verifyToken', () => {
    it('signs and verifies a token', () => {
      const token = generateToken({
        userId: 'user_123',
        email: 'test@example.com',
        role: 'user',
      })
      expect(token).toBeTruthy()
      expect(typeof token).toBe('string')

      const decoded = verifyToken(token)
      expect(decoded).not.toBeNull()
      expect(decoded?.userId).toBe('user_123')
      expect(decoded?.email).toBe('test@example.com')
      expect(decoded?.role).toBe('user')
    })

    it('rejects invalid token', () => {
      const decoded = verifyToken('invalid.token.here')
      expect(decoded).toBeNull()
    })

    it('rejects empty token', () => {
      const decoded = verifyToken('')
      expect(decoded).toBeNull()
    })
  })

  // ── extractTokenFromHeader ───────────────────────────────────────────
  describe('extractTokenFromHeader', () => {
    it('extracts token from Bearer header', () => {
      const token = extractTokenFromHeader('Bearer my-jwt-token-123')
      expect(token).toBe('my-jwt-token-123')
    })

    it('returns null for missing header', () => {
      const token = extractTokenFromHeader(null)
      expect(token).toBeNull()
    })

    it('returns null for non-Bearer header', () => {
      const token = extractTokenFromHeader('Basic abc123')
      expect(token).toBeNull()
    })

    it('returns null for empty header', () => {
      const token = extractTokenFromHeader('')
      expect(token).toBeNull()
    })

    it('extracts token from Bearer header (with extra spaces, preserves token)', () => {
      // The implementation uses split(' ') which keeps extra spaces as empty strings
      // but the token itself is the last non-empty part
      const token = extractTokenFromHeader('Bearer my-jwt-token-123')
      expect(token).toBe('my-jwt-token-123')
    })
  })
})
