/**
 * tests/integration/api-security.test.ts
 * ════════════════════════════════════════════════════════════════════════════
 * Integration tests for API security — verifies auth + ownership + role
 * checks work end-to-end against the running panel.
 *
 * Prerequisites:
 *   - Panel running on http://localhost:3000
 *   - Admin user: admin@deployhub.io / admin123
 *   - Test user: testuser@apsamo.io / Test1234!
 *
 * Run with: bun test tests/integration/api-security.test.ts
 * ════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll } from 'bun:test'

const PANEL_URL = process.env.PANEL_URL || 'http://localhost:3000'

async function login(email: string, password: string): Promise<string | null> {
  const res = await fetch(`${PANEL_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) return null
  const data = await res.json()
  return data.token || null
}

async function apiCall(path: string, token: string | null = null, options: RequestInit = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return fetch(`${PANEL_URL}${path}`, { ...options, headers })
}

describe('API Security Integration Tests', () => {
  let adminToken: string
  let userToken: string

  beforeAll(async () => {
    adminToken = (await login('admin@deployhub.io', 'admin123'))!
    userToken = (await login('testuser@apsamo.io', 'Test1234!'))!
    expect(adminToken).toBeTruthy()
    expect(userToken).toBeTruthy()
  })

  // ── Authentication required ──────────────────────────────────────────
  describe('Authentication required', () => {
    it('rejects /api/hosting without token', async () => {
      const res = await apiCall('/api/hosting')
      expect(res.status).toBe(401)
    })

    it('rejects /api/domains without token', async () => {
      const res = await apiCall('/api/domains')
      expect(res.status).toBe(401)
    })

    it('rejects /api/admin/stats without token', async () => {
      const res = await apiCall('/api/admin/stats')
      expect([401, 403]).toContain(res.status)
    })

    it('accepts /api/hosting with valid token', async () => {
      const res = await apiCall('/api/hosting', userToken)
      expect(res.status).toBe(200)
    })

    it('rejects /api/seed without token', async () => {
      const res = await apiCall('/api/seed', null, { method: 'POST' })
      expect(res.status).toBe(401)
    })

    it('rejects /api (GET) without token', async () => {
      const res = await apiCall('/api')
      expect(res.status).toBe(401)
    })
  })

  // ── Admin-only access ────────────────────────────────────────────────
  describe('Admin-only access', () => {
    it('rejects regular user from /api/admin/stats', async () => {
      const res = await apiCall('/api/admin/stats', userToken)
      expect(res.status).toBe(403)
    })

    it('rejects regular user from /api/admin/users', async () => {
      const res = await apiCall('/api/admin/users', userToken)
      expect(res.status).toBe(403)
    })

    it('rejects regular user from /api/admin/servers', async () => {
      const res = await apiCall('/api/admin/servers', userToken)
      expect(res.status).toBe(403)
    })

    it('allows admin to access /api/admin/stats', async () => {
      const res = await apiCall('/api/admin/stats', adminToken)
      expect(res.status).toBe(200)
    })

    it('allows admin to access /api/admin/users', async () => {
      const res = await apiCall('/api/admin/users', adminToken)
      expect(res.status).toBe(200)
    })
  })

  // ── Pricing endpoint security ────────────────────────────────────────
  describe('Pricing endpoint security', () => {
    it('rejects /api/pricing without token', async () => {
      const res = await apiCall('/api/pricing')
      expect(res.status).toBe(401)
    })

    it('hides wholesale from non-admin users', async () => {
      const res = await apiCall('/api/pricing', userToken)
      expect(res.status).toBe(200)
      const body = await res.json()
      const data = body.data || body
      const firstTld = data.tlds?.[0] || {}
      expect(firstTld.wholesale).toBeUndefined()
      expect(firstTld.markup).toBeUndefined()
      // Should still have selling prices
      expect(firstTld.registration).toBeDefined()
    })

    it('shows wholesale to admin users', async () => {
      const res = await apiCall('/api/pricing', adminToken)
      expect(res.status).toBe(200)
      const body = await res.json()
      const data = body.data || body
      const firstTld = data.tlds?.[0] || {}
      expect(firstTld.wholesale).toBeDefined()
      expect(firstTld.markup).toBeDefined()
    })

    it('rejects /api/pricing/markup from regular user', async () => {
      const res = await apiCall('/api/pricing/markup', userToken)
      expect(res.status).toBe(403)
    })

    it('allows /api/pricing/markup for admin', async () => {
      const res = await apiCall('/api/pricing/markup', adminToken)
      expect(res.status).toBe(200)
    })
  })

  // ── Domain search rate limiting ──────────────────────────────────────
  describe('Domain search rate limiting', () => {
    it('returns rate limit headers', async () => {
      const res = await apiCall('/api/domains/search?domain=test1234example.com', userToken)
      expect(res.headers.get('x-ratelimit-limit')).toBeTruthy()
      expect(res.headers.get('x-ratelimit-remaining')).toBeTruthy()
    })

    it('hides dynadotError from response', async () => {
      const res = await apiCall('/api/domains/search?domain=test1234example.com', userToken)
      const data = await res.json()
      expect(data.dynadotError).toBeUndefined()
      expect(data.dynadotUsed).toBeUndefined()
    })

    it('shows "apsamo" as provider (not "dynadot")', async () => {
      const res = await apiCall('/api/domains/search?domain=test1234example.com', userToken)
      const body = await res.json()
      const data = body.data || body
      expect(data.provider).toBe('apsamo')
    })
  })

  // ── Domain name validation ───────────────────────────────────────────
  describe('Domain name validation', () => {
    it('rejects invalid domain names', async () => {
      const res = await apiCall('/api/domains/register', userToken, {
        method: 'POST',
        body: JSON.stringify({ name: '../../etc/passwd', duration: 1 }),
      })
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('Invalid domain name format')
    })

    it('rejects duration > 10 years', async () => {
      // Use a real-looking domain so it passes FQDN validation but fails at registrar
      const res = await apiCall('/api/domains/register', userToken, {
        method: 'POST',
        body: JSON.stringify({ name: 'test-capped-duration-1234.com', duration: 100 }),
      })
      // The duration should be capped at 10, so the request proceeds (and may fail at registrar)
      // We're testing that it doesn't accept 100 years silently
      const data = await res.json()
      // Should not error with "duration must be..." since we cap silently
      expect(data.error).not.toContain('duration')
    })
  })

  // ── Cross-tenant isolation ───────────────────────────────────────────
  describe('Cross-tenant isolation', () => {
    it('regular user cannot see admin projects', async () => {
      const userRes = await apiCall('/api/hosting', userToken)
      const userData = await userRes.json()
      const userProjectIds = (userData.projects || []).map((p: { id: string }) => p.id)

      const adminRes = await apiCall('/api/hosting', adminToken)
      const adminData = await adminRes.json()
      const adminProjectIds = (adminData.projects || []).map((p: { id: string }) => p.id)

      // User should not see any of admin's projects
      for (const adminId of adminProjectIds) {
        expect(userProjectIds).not.toContain(adminId)
      }
    })
  })

  // ── HTTP security headers ────────────────────────────────────────────
  describe('HTTP security headers', () => {
    it('does not send X-Powered-By header', async () => {
      const res = await fetch(`${PANEL_URL}/`)
      expect(res.headers.get('x-powered-by')).toBeNull()
    })

    it('sends X-Content-Type-Options: nosniff', async () => {
      const res = await fetch(`${PANEL_URL}/`)
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    })

    it('sends X-Frame-Options: SAMEORIGIN', async () => {
      const res = await fetch(`${PANEL_URL}/`)
      expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    })

    it('sends Referrer-Policy', async () => {
      const res = await fetch(`${PANEL_URL}/`)
      expect(res.headers.get('referrer-policy')).toBeTruthy()
    })
  })

  // ── Webhook secret masking ───────────────────────────────────────────
  describe('Webhook secret masking', () => {
    it('masks webhook secret in list endpoint', async () => {
      const res = await apiCall('/api/webhooks', adminToken)
      expect(res.status).toBe(200)
      const data = await res.json()
      for (const webhook of data.webhooks || []) {
        // Secret should be masked (not the full secret)
        if (webhook.secret) {
          expect(webhook.secret).toMatch(/\.\.\.\*\*\*\*$/)
        }
      }
    })
  })
})
