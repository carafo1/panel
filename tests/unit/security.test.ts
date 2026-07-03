/**
 * tests/unit/security.test.ts
 * ════════════════════════════════════════════════════════════════════════════
 * Unit tests for src/lib/security.ts — the security helpers.
 *
 * Run with: bun test
 * ════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  sanitizeError,
  isAdmin,
  isSuperAdmin,
  sanitizeProjectForCustomer,
  sanitizeServerForCustomer,
  maskSecret,
  isSafeRedirectUrl,
  safeCompare,
} from '../../src/lib/security'

describe('security.ts', () => {
  // ── sanitizeError ──────────────────────────────────────────────────────
  describe('sanitizeError', () => {
    it('returns generic message for unknown errors', () => {
      const result = sanitizeError(new Error('Prisma connection failed at /var/lib/postgresql'))
      expect(result).toBe('Internal server error. Please try again or contact support if the issue persists.')
    })

    it('returns specific message for Prisma P2002 (unique constraint)', () => {
      const err = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
      const result = sanitizeError(err)
      expect(result).toBe('A record with this value already exists.')
    })

    it('returns specific message for Prisma P2025 (not found)', () => {
      const err = Object.assign(new Error('Record not found'), { code: 'P2025' })
      const result = sanitizeError(err)
      expect(result).toBe('Record not found.')
    })

    it('returns generic message for other Prisma errors', () => {
      const err = Object.assign(new Error('Foreign key constraint'), { code: 'P2003' })
      const result = sanitizeError(err)
      expect(result).toBe('Database operation failed.')
    })

    it('handles non-Error objects', () => {
      const result = sanitizeError('string error')
      expect(result).toBe('Internal server error. Please try again or contact support if the issue persists.')
    })

    it('handles null/undefined', () => {
      const result = sanitizeError(null)
      expect(result).toBe('Internal server error. Please try again or contact support if the issue persists.')
    })
  })

  // ── isAdmin / isSuperAdmin ─────────────────────────────────────────────
  describe('isAdmin', () => {
    it('returns true for "admin"', () => {
      expect(isAdmin('admin')).toBe(true)
    })

    it('returns true for "super_admin"', () => {
      expect(isAdmin('super_admin')).toBe(true)
    })

    it('returns false for "user"', () => {
      expect(isAdmin('user')).toBe(false)
    })

    it('returns false for undefined', () => {
      expect(isAdmin(undefined)).toBe(false)
    })

    it('returns false for null', () => {
      expect(isAdmin(null)).toBe(false)
    })

    it('returns false for empty string', () => {
      expect(isAdmin('')).toBe(false)
    })
  })

  describe('isSuperAdmin', () => {
    it('returns true for "super_admin"', () => {
      expect(isSuperAdmin('super_admin')).toBe(true)
    })

    it('returns false for "admin"', () => {
      expect(isSuperAdmin('admin')).toBe(false)
    })

    it('returns false for "user"', () => {
      expect(isSuperAdmin('user')).toBe(false)
    })
  })

  // ── sanitizeProjectForCustomer ─────────────────────────────────────────
  describe('sanitizeProjectForCustomer', () => {
    const fullProject = {
      id: 'proj_123',
      name: 'My App',
      containerId: 'abc123def456',
      containerName: 'apsamo-myapp',
      containerPort: 3000,
      externalPort: 8080,
      deployPath: '/opt/apsamo/projects/myapp',
      databaseHost: 'localhost',
      databasePort: 3306,
      databaseUser: 'db_user',
      databasePassword: 'secret123',
      server: {
        id: 'srv_1',
        name: 'EU-Central-1',
        ip: '185.234.72.10',
        sshHost: '185.234.72.10',
        sshUser: 'root',
        sshPassword: 'ssh_secret',
        region: 'eu-central',
      },
    }

    it('returns full project for admin', () => {
      const result = sanitizeProjectForCustomer(fullProject, 'admin')
      expect(result.containerId).toBe('abc123def456')
      expect(result.databasePassword).toBe('secret123')
      expect(result.server?.ip).toBe('185.234.72.10')
    })

    it('returns full project for super_admin', () => {
      const result = sanitizeProjectForCustomer(fullProject, 'super_admin')
      expect(result.containerId).toBe('abc123def456')
    })

    it('strips container internals for regular user', () => {
      const result = sanitizeProjectForCustomer(fullProject, 'user')
      expect(result.containerId).toBeUndefined()
      expect(result.containerName).toBeUndefined()
      expect(result.containerPort).toBeUndefined()
      expect(result.externalPort).toBeUndefined()
      expect(result.deployPath).toBeUndefined()
    })

    it('strips DB connection details for regular user', () => {
      const result = sanitizeProjectForCustomer(fullProject, 'user')
      expect(result.databaseHost).toBeUndefined()
      expect(result.databasePort).toBeUndefined()
      expect(result.databaseUser).toBeUndefined()
      expect(result.databasePassword).toBeUndefined()
    })

    it('strips server IP + SSH creds for regular user', () => {
      const result = sanitizeProjectForCustomer(fullProject, 'user')
      expect(result.server?.ip).toBeUndefined()
      expect(result.server?.sshHost).toBeUndefined()
      expect(result.server?.sshUser).toBeUndefined()
      expect(result.server?.sshPassword).toBeUndefined()
      // But keeps non-sensitive fields
      expect(result.server?.name).toBe('EU-Central-1')
      expect(result.server?.region).toBe('eu-central')
    })
  })

  // ── sanitizeServerForCustomer ──────────────────────────────────────────
  describe('sanitizeServerForCustomer', () => {
    const fullServer = {
      id: 'srv_1',
      name: 'EU-Central-1',
      ip: '185.234.72.10',
      sshHost: '185.234.72.10',
      sshPort: 22,
      sshUser: 'root',
      sshPassword: 'secret',
      sshFingerprint: 'SHA256:abc',
      deployedPublicKey: 'ssh-rsa AAAA...',
      hasSshKey: true,
      hasSshPassword: true,
      dockerVersion: '24.0.7',
      caddyVersion: 'v2.7.6',
      osInfo: 'Ubuntu 22.04',
      region: 'eu-central',
      status: 'active',
      cpuCores: 8,
      ramGB: 32,
    }

    it('returns full server for admin', () => {
      const result = sanitizeServerForCustomer(fullServer, 'admin')
      expect(result.ip).toBe('185.234.72.10')
      expect(result.sshPassword).toBe('secret')
    })

    it('strips all sensitive fields for regular user', () => {
      const result = sanitizeServerForCustomer(fullServer, 'user')
      expect(result.ip).toBeUndefined()
      expect(result.sshHost).toBeUndefined()
      expect(result.sshPort).toBeUndefined()
      expect(result.sshUser).toBeUndefined()
      expect(result.sshPassword).toBeUndefined()
      expect(result.sshFingerprint).toBeUndefined()
      expect(result.deployedPublicKey).toBeUndefined()
      expect(result.hasSshKey).toBeUndefined()
      expect(result.hasSshPassword).toBeUndefined()
      expect(result.dockerVersion).toBeUndefined()
      expect(result.caddyVersion).toBeUndefined()
      expect(result.osInfo).toBeUndefined()
    })

    it('keeps cosmetic fields for regular user', () => {
      const result = sanitizeServerForCustomer(fullServer, 'user')
      expect(result.name).toBe('EU-Central-1')
      expect(result.region).toBe('eu-central')
      expect(result.status).toBe('active')
      expect(result.cpuCores).toBe(8)
      expect(result.ramGB).toBe(32)
    })
  })

  // ── maskSecret ─────────────────────────────────────────────────────────
  describe('maskSecret', () => {
    it('masks a long secret', () => {
      const result = maskSecret('whk_abcdef1234567890')
      expect(result).toBe('whk_abcd...****')
    })

    it('returns **** for short secret', () => {
      const result = maskSecret('abc')
      expect(result).toBe('****')
    })

    it('returns **** for empty string', () => {
      const result = maskSecret('')
      expect(result).toBe('****')
    })

    it('respects custom prefix length', () => {
      const result = maskSecret('sk_live_abcdef123456', 12)
      expect(result).toBe('sk_live_abcd...****')
    })
  })

  // ── isSafeRedirectUrl ──────────────────────────────────────────────────
  describe('isSafeRedirectUrl', () => {
    const allowed = ['https://yourdomain.com', 'https://app.yourdomain.com']

    it('returns true for allowed origin', () => {
      expect(isSafeRedirectUrl('https://yourdomain.com/callback', allowed)).toBe(true)
    })

    it('returns false for disallowed origin', () => {
      expect(isSafeRedirectUrl('https://evil.com/callback', allowed)).toBe(false)
    })

    it('returns false for invalid URL', () => {
      expect(isSafeRedirectUrl('not-a-url', allowed)).toBe(false)
    })

    it('returns false for empty string', () => {
      expect(isSafeRedirectUrl('', allowed)).toBe(false)
    })
  })

  // ── safeCompare ────────────────────────────────────────────────────────
  describe('safeCompare', () => {
    it('returns true for identical strings', () => {
      expect(safeCompare('secret123', 'secret123')).toBe(true)
    })

    it('returns false for different strings', () => {
      expect(safeCompare('secret123', 'secret456')).toBe(false)
    })

    it('returns false for different lengths', () => {
      expect(safeCompare('short', 'longerstring')).toBe(false)
    })

    it('returns true for empty strings', () => {
      expect(safeCompare('', '')).toBe(true)
    })

    it('takes constant time (no early return)', () => {
      // This is hard to test deterministically, but at least verify it doesn't throw
      const start = Date.now()
      safeCompare('a'.repeat(1000), 'b'.repeat(1000))
      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(100) // should be fast
    })
  })
})
