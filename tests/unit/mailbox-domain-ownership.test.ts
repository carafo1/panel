/**
 * tests/unit/mailbox-domain-ownership.test.ts
 * ════════════════════════════════════════════════════════════════════════════
 * POST /api/hosting/[id]/email used to upsert a Domain row for ANY domainName
 * (another tenant's domain, gmail.com) and re-assign another user's Domain row
 * to the caller's project before its 403 check. The mail tenant guard also
 * counted unverified WebsiteDomains. These tests pin the pure rules that
 * replaced both (lib/mailcow-tenant).
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'bun:test'

import { mailDomainNames, decideMailboxDomain } from '../../src/lib/mailcow-tenant'

const OWNER = 'user-owner'
const PROJECT = 'project-1'

describe('mailDomainNames', () => {
  it('includes the custom domain and only VERIFIED website domains', () => {
    const names = mailDomainNames({
      customDomain: 'Primary.Example.',
      customDomainVerified: true,
      websiteDomains: [
        { domain: 'verified.example', verified: true },
        { domain: 'someone-elses.example', verified: false },
        { domain: 'VERIFIED.example', verified: true },
      ],
    })
    expect(names.sort()).toEqual(['primary.example', 'verified.example'])
  })

  it('ignores an unproven customDomain (the flag is absent or false)', () => {
    const websiteDomains = [{ domain: 'verified.example', verified: true }]
    expect(mailDomainNames({ customDomain: 'victim.example', websiteDomains })).toEqual(['verified.example'])
    expect(
      mailDomainNames({ customDomain: 'victim.example', customDomainVerified: false, websiteDomains })
    ).toEqual(['verified.example'])
  })

  it('is empty when there is nothing verified', () => {
    expect(mailDomainNames({ customDomain: null, websiteDomains: [{ domain: 'x.example', verified: false }] })).toEqual([])
  })
})

describe('decideMailboxDomain', () => {
  const base = {
    allowedDomains: ['primary.example', 'site.example'],
    verifiedWebsiteDomains: ['site.example'],
    ownerId: OWNER,
    projectId: PROJECT,
  }

  it('rejects domains that are not the project\'s own (other tenants, gmail.com)', () => {
    for (const domainName of ['gmail.com', 'other-tenant.example', 'unverified.example']) {
      const d = decideMailboxDomain({ ...base, domainName, existing: null })
      expect(d.ok).toBe(false)
      if (!d.ok) expect(d.status).toBe(403)
    }
  })

  it('rejects a Domain row owned by another user without touching it', () => {
    const d = decideMailboxDomain({
      ...base,
      domainName: 'site.example',
      existing: { id: 'd1', userId: 'someone-else', projectId: 'their-project', status: 'active', verified: true },
    })
    expect(d).toEqual({ ok: false, status: 403, error: 'You do not own this domain.' })
  })

  it('reuses the owner\'s row and links it only when it has no project', () => {
    const unlinked = decideMailboxDomain({
      ...base,
      domainName: 'primary.example',
      existing: { id: 'd2', userId: OWNER, projectId: null, status: 'active', verified: null },
    })
    expect(unlinked).toEqual({ ok: true, action: 'reuse', domainId: 'd2', linkProject: true })

    const elsewhere = decideMailboxDomain({
      ...base,
      domainName: 'primary.example',
      existing: { id: 'd3', userId: OWNER, projectId: 'other-project', status: 'active', verified: true },
    })
    expect(elsewhere).toEqual({ ok: true, action: 'reuse', domainId: 'd3', linkProject: false })
  })

  it('refuses a domain still awaiting verification unless it is a verified website domain', () => {
    const pending = decideMailboxDomain({
      ...base,
      domainName: 'primary.example',
      existing: { id: 'd4', userId: OWNER, projectId: PROJECT, status: 'pending_verification', verified: false },
    })
    expect(pending.ok).toBe(false)

    const provenElsewhere = decideMailboxDomain({
      ...base,
      domainName: 'site.example',
      existing: { id: 'd5', userId: OWNER, projectId: PROJECT, status: 'pending_verification', verified: false },
    })
    expect(provenElsewhere.ok).toBe(true)
  })

  it('creates a new Domain row only for a verified website domain', () => {
    expect(decideMailboxDomain({ ...base, domainName: 'site.example', existing: null })).toEqual({
      ok: true,
      action: 'create',
    })
    // customDomain with no Domain row behind it is not proof on its own.
    const d = decideMailboxDomain({ ...base, domainName: 'primary.example', existing: null })
    expect(d.ok).toBe(false)
  })

  it('normalises case and trailing dots', () => {
    const d = decideMailboxDomain({ ...base, domainName: 'SITE.example.', existing: null })
    expect(d.ok).toBe(true)
  })
})
