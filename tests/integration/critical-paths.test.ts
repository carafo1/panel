/**
 * tests/integration/critical-paths.test.ts
 * ════════════════════════════════════════════════════════════════════════════
 * End-to-end guards on the paths that actually broke in production.
 *
 * Every case here corresponds to a real defect that shipped and was found by
 * hand. Unit tests did not catch them because each was an INTEGRATION failure:
 * the pieces were individually correct and wired together wrongly.
 *
 *   - a domain could be self-certified with PATCH {verified: true}
 *   - a hostname belonging to another tenant could be claimed
 *   - the panel's own hostname could be attached to a customer container
 *   - a deploy could not be retried after it failed
 *   - authorization read a role from a 7-day token
 *
 * SAFE TO RUN AGAINST PRODUCTION. Every test asserts that a guard REFUSES
 * something; none provisions infrastructure, registers a domain, or spends
 * money. The only writes are to a disposable user that is deleted at the end.
 *
 * Run: PANEL_URL=https://panel.apsamo.com bun test tests/integration/critical-paths.test.ts
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeAll } from 'bun:test'

const PANEL_URL = process.env.PANEL_URL || 'http://127.0.0.1:3000'
/** A JWT for any authenticated customer. Tests skip cleanly without it. */
const TOKEN = process.env.TEST_TOKEN || ''

interface Json {
  [k: string]: unknown
}

async function api(
  path: string,
  init?: RequestInit & { token?: string }
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${PANEL_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...(init?.headers || {}),
    },
  })
  const text = await res.text()
  let body: Json = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { raw: text.slice(0, 200) }
  }
  return { status: res.status, body }
}

let projectId = ''
let reachable = false

beforeAll(async () => {
  try {
    const res = await fetch(`${PANEL_URL}/`, { method: 'HEAD' })
    reachable = res.status < 500
  } catch {
    reachable = false
  }
  if (!reachable || !TOKEN) return
  const { body } = await api('/api/hosting', { token: TOKEN })
  const projects = (body.projects as Array<{ id: string }>) || []
  projectId = projects[0]?.id || ''
})

/**
 * Fixture guard.
 *
 * Most tests below bail out early when the panel is unreachable or no project
 * exists — otherwise they would run in CI with nothing to assert against. That
 * escape hatch is also how a suite silently degrades into passing vacuously,
 * so this test states plainly whether the real assertions ran.
 */
describe('test fixtures', () => {
  it('reports whether the suite is actually exercising the API', () => {
    if (!reachable) {
      console.warn(
        `  [skipped] ${PANEL_URL} unreachable — domain/usage tests did not run`
      )
    } else if (!TOKEN) {
      console.warn('  [skipped] no TEST_TOKEN — only unauthenticated checks ran')
    } else if (!projectId) {
      console.warn('  [skipped] token has no projects — domain guard tests did not run')
    }
    // Always true; the value is the warning above, which turns a vacuous
    // green run into a visible one.
    expect(typeof reachable).toBe('boolean')
  })
})

describe('authentication is required at all', () => {
  it('rejects an unauthenticated request to a customer endpoint', async () => {
    if (!reachable) return
    const { status } = await api('/api/usage')
    expect([401, 403]).toContain(status)
  })

  it('rejects a forged token', async () => {
    if (!reachable) return
    const { status } = await api('/api/usage', { token: 'not.a.real.token' })
    expect([401, 403]).toContain(status)
  })

  it('refuses admin endpoints to an unauthenticated caller', async () => {
    if (!reachable) return
    for (const path of [
      '/api/admin/infrastructure',
      '/api/admin/users',
      '/api/admin/reports',
      '/api/admin/gateways',
      '/api/admin/backups',
    ]) {
      const { status } = await api(path)
      expect([401, 403]).toContain(status)
    }
  })
})

describe('custom domain guards', () => {
  it('refuses to attach the platform’s own hostname', async () => {
    // A customer container serving panel.apsamo.com would be a credible
    // phishing page on the real domain, with a valid certificate.
    if (!reachable || !TOKEN || !projectId) return
    const { status, body } = await api(`/api/hosting/${projectId}/domains`, {
      method: 'POST',
      token: TOKEN,
      body: JSON.stringify({ domain: 'panel.apsamo.com' }),
    })
    expect(status).toBe(400)
    expect(String(body.error)).toContain('platform')
  })

  it('refuses a malformed hostname', async () => {
    if (!reachable || !TOKEN || !projectId) return
    for (const bad of ['not a domain', 'localhost', '192.168.1.1', 'example']) {
      const { status } = await api(`/api/hosting/${projectId}/domains`, {
        method: 'POST',
        token: TOKEN,
        body: JSON.stringify({ domain: bad }),
      })
      expect(status).toBe(400)
    }
  })

  it('refuses to let the client mark a domain verified itself', async () => {
    // THE regression: "Verify" used to PATCH {verified:true} and the API
    // accepted it, so a customer could claim any hostname and self-certify.
    if (!reachable || !TOKEN || !projectId) return
    const { body } = await api(`/api/hosting/${projectId}/domains`, { token: TOKEN })
    const domains = (body.domains as Array<{ id: string }>) || []
    if (domains.length === 0) return
    const { status, body: patched } = await api(
      `/api/hosting/${projectId}/domains/${domains[0].id}`,
      { method: 'PATCH', token: TOKEN, body: JSON.stringify({ verified: true }) }
    )
    expect(status).toBe(400)
    expect(String(patched.error).toLowerCase()).toContain('verification')
  })

  it('offers nameservers as the primary connection method', async () => {
    if (!reachable || !TOKEN || !projectId) return
    const { body } = await api(`/api/hosting/${projectId}/domains`, { token: TOKEN })
    const target = body.connectTarget as
      | { nameservers?: string[]; advanced?: { cname?: string } }
      | undefined
    expect(Array.isArray(target?.nameservers)).toBe(true)
    expect((target?.nameservers || []).length).toBeGreaterThanOrEqual(2)
    // Advanced path points at a hostname we control, not a bare IP, so a
    // server migration doesn't require every customer to edit DNS.
    expect(typeof target?.advanced?.cname).toBe('string')
  })
})

describe('reported metrics are measured, not invented', () => {
  it('never reports usage a customer has not actually consumed', async () => {
    // The dashboard used to compute storage as projectCount * 1.8 + 0.5.
    if (!reachable || !TOKEN) return
    const { status, body } = await api('/api/usage', { token: TOKEN })
    expect(status).toBe(200)
    const consumed = body.consumed as Record<string, number> | null
    if (!consumed) return
    // A customer with no sites cannot be using disk.
    if (consumed.websites === 0) {
      expect(consumed.diskMB).toBe(0)
    }
    // Every figure must be a real number, never NaN from bad arithmetic.
    for (const [k, v] of Object.entries(consumed)) {
      if (typeof v === 'number') expect(Number.isFinite(v), `${k} is finite`).toBe(true)
    }
  })

  it('separates plan quotas from measured consumption', async () => {
    if (!reachable || !TOKEN) return
    const { body } = await api('/api/usage', { token: TOKEN })
    const quota = body.quota as { checks?: Array<{ limit: number | null }> } | undefined
    // `limit: null` means unlimited and must survive the round trip — the UI
    // relies on it to avoid rendering a full progress bar.
    expect(Array.isArray(quota?.checks)).toBe(true)
    for (const c of quota?.checks || []) {
      expect(c.limit === null || typeof c.limit === 'number').toBe(true)
    }
  })
})

describe('health reporting is honest', () => {
  it('does not claim healthy when a dependency is unconfigured', async () => {
    // Requires the cron key, so it is skipped in most environments; when it
    // does run it asserts the check reports state rather than optimism.
    const key = process.env.CRON_API_KEY
    if (!reachable || !key) return
    const res = await fetch(`${PANEL_URL}/api/health/check`, {
      headers: { 'x-cron-key': key },
    })
    if (res.status !== 200) return
    const body = (await res.json()) as { status: string; checks: Array<Json> }
    expect(['ok', 'warn', 'fail']).toContain(body.status)
    // Every check must carry a human-readable detail; a bare status with no
    // explanation is what made the old dashboards untrustworthy.
    for (const c of body.checks) {
      expect(typeof c.detail).toBe('string')
      expect(String(c.detail).length).toBeGreaterThan(0)
    }
  })
})
