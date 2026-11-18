/**
 * Linking a verified custom domain to its project
 * ===============================================
 *
 * POST /api/domains/register (provider "custom") no longer writes
 * `project.customDomain` up front: customDomain is what the reverse proxy
 * serves and what mail tenancy trusts, so an unproven hostname must not land
 * there. It is linked here instead, once POST /api/domains/[id]/verify has
 * proven DNS control.
 *
 * Behaviour chosen (least surprising):
 *   - link only a provider "custom" domain that carries a projectId the caller
 *     may 'configure' (lib/project-access);
 *   - link only when the project has NO customDomain, or already has this one
 *     (idempotent). Register used to overwrite unconditionally, but replacing
 *     a different, already-live primary domain from a side effect of verifying
 *     another domain would silently take that site's hostname out of the
 *     proxy. The customer can switch the primary explicitly instead;
 *   - never link a platform hostname, or one another project already serves.
 *
 * Pure so it is unit-tested directly (tests/unit/custom-domain-link.test.ts).
 */

export type CustomDomainLinkReason =
  | 'not_custom'
  | 'no_project'
  | 'no_access'
  | 'reserved'
  | 'in_use_elsewhere'
  | 'project_has_other_domain'

export type CustomDomainLinkDecision =
  | { action: 'link' }
  | { action: 'already_linked' }
  | { action: 'skip'; reason: CustomDomainLinkReason }

const norm = (v: string | null | undefined) => (v || '').trim().toLowerCase().replace(/\.+$/, '')

export function decideCustomDomainLink(input: {
  provider: string | null | undefined
  domainName: string
  projectId: string | null | undefined
  /** The caller has 'configure' on projectId (false when the project is gone). */
  canConfigure: boolean
  /** The project's current customDomain. */
  projectCustomDomain: string | null | undefined
  /** Another project already serves this hostname (WebsiteDomain or customDomain). */
  inUseElsewhere: boolean
  /** Brand / panel hostname — never a customer's. */
  reserved: boolean
}): CustomDomainLinkDecision {
  if (norm(input.provider) !== 'custom') return { action: 'skip', reason: 'not_custom' }
  if (!input.projectId) return { action: 'skip', reason: 'no_project' }
  if (!input.canConfigure) return { action: 'skip', reason: 'no_access' }
  if (input.reserved) return { action: 'skip', reason: 'reserved' }
  if (input.inUseElsewhere) return { action: 'skip', reason: 'in_use_elsewhere' }

  const current = norm(input.projectCustomDomain)
  const name = norm(input.domainName)
  if (current && current === name) return { action: 'already_linked' }
  if (current) return { action: 'skip', reason: 'project_has_other_domain' }
  return { action: 'link' }
}

/** Customer-facing explanation for a domain that was verified but not linked. */
export function customDomainLinkMessage(reason: CustomDomainLinkReason): string | null {
  switch (reason) {
    case 'not_custom':
    case 'no_project':
      return null
    case 'no_access':
      return 'The domain is verified, but you do not have permission to change the linked website, so it was not attached.'
    case 'reserved':
      return 'The domain is verified, but platform hostnames cannot be attached to a website.'
    case 'in_use_elsewhere':
      return 'The domain is verified, but another website on this platform already uses it, so it was not attached.'
    case 'project_has_other_domain':
      return 'The domain is verified. The website already has a different primary domain, so it was not replaced — change the primary domain in the website settings if you want this one.'
  }
}
