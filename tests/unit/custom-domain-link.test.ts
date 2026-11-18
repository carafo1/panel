/**
 * tests/unit/custom-domain-link.test.ts
 * ════════════════════════════════════════════════════════════════════════════
 * Register no longer writes project.customDomain for an unverified custom
 * domain; POST /api/domains/[id]/verify links it once DNS proves control.
 * Regression: without this, a verified custom domain was never attached to
 * its project. These pin who may link and when.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'bun:test'

import { decideCustomDomainLink, customDomainLinkMessage } from '../../src/lib/custom-domain-link'

const base = {
  provider: 'custom',
  domainName: 'shop.example',
  projectId: 'p1',
  canConfigure: true,
  projectCustomDomain: null as string | null,
  inUseElsewhere: false,
  reserved: false,
}

describe('decideCustomDomainLink', () => {
  it('links a verified custom domain to a project with no primary domain', () => {
    expect(decideCustomDomainLink(base)).toEqual({ action: 'link' })
  })

  it('is idempotent when the project already uses this domain', () => {
    expect(decideCustomDomainLink({ ...base, projectCustomDomain: 'SHOP.example.' })).toEqual({
      action: 'already_linked',
    })
  })

  it('never replaces a different, existing primary domain', () => {
    expect(decideCustomDomainLink({ ...base, projectCustomDomain: 'live-site.example' })).toEqual({
      action: 'skip',
      reason: 'project_has_other_domain',
    })
  })

  it('requires configure access to the project', () => {
    expect(decideCustomDomainLink({ ...base, canConfigure: false })).toEqual({ action: 'skip', reason: 'no_access' })
  })

  it('skips registrar domains and domains without a project', () => {
    expect(decideCustomDomainLink({ ...base, provider: 'dynadot' })).toEqual({ action: 'skip', reason: 'not_custom' })
    expect(decideCustomDomainLink({ ...base, projectId: null })).toEqual({ action: 'skip', reason: 'no_project' })
  })

  it('refuses platform hostnames and hostnames another project serves', () => {
    expect(decideCustomDomainLink({ ...base, reserved: true })).toEqual({ action: 'skip', reason: 'reserved' })
    expect(decideCustomDomainLink({ ...base, inUseElsewhere: true })).toEqual({
      action: 'skip',
      reason: 'in_use_elsewhere',
    })
  })

  it('explains customer-visible skips and stays silent otherwise', () => {
    expect(customDomainLinkMessage('project_has_other_domain')).toBeTruthy()
    expect(customDomainLinkMessage('no_access')).toBeTruthy()
    expect(customDomainLinkMessage('not_custom')).toBe(null)
  })
})
