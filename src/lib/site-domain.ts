/**
 * Server-side validation of the domain chosen for a new website.
 *
 * Every site-creating path (create wizard, legacy create, import, onboarding
 * checkout) runs the customer's choice through `resolveSiteDomainChoice`, so
 * "a website must have a real domain" is enforced in one place and the
 * checks match the ones the Domains tab applies to a custom domain.
 */
import { db } from '@/lib/db'
import { BRAND_DOMAIN } from '@/lib/brand-config'
import { isValidHostname, isReservedHostname, findConflict } from '@/lib/custom-domains'
import { DOMAIN_REQUIRED_MESSAGE, siteHostname, isPlatformHostname } from '@/lib/site-address'

export { DOMAIN_REQUIRED_MESSAGE }

/**
 * Value stored in `Project.subdomain` for a new site.
 *
 * INTERNAL ONLY. The column predates the "real domain only" rule and keeps
 * its historical `<slug>.<brand>` shape so every row looks the same and the
 * DNS cleanup (see site-dns-cleanup.ts) can match old and new rows with one
 * rule. Nothing may serve, publish, certify or display it.
 */
export function internalSiteKey(slug: string): string {
  return `${slug}.${BRAND_DOMAIN}`
}

export type SiteDomainType = 'existing' | 'external' | 'new'

export type SiteDomainChoice =
  | {
      ok: true
      domain: string
      /** Held in the account: written to Project.customDomain at once. */
      customDomain: string | null
      /** Registered elsewhere: attached as a pending WebsiteDomain. */
      externalDomain: string | null
    }
  | { ok: false; status: number; error: string; code: string }

/**
 * Validate a requested domain for a new website.
 *
 * `domainType`:
 *   existing — must be a Domain in this account.
 *   external / new — registered elsewhere; attached pending verification.
 *   missing — inferred: a domain in the account is 'existing', otherwise
 *             'external'. Lets older callers that only send `domain` work.
 * The retired 'subdomain' choice (and any other value) without a domain is
 * rejected with DOMAIN_REQUIRED.
 */
export async function resolveSiteDomainChoice(opts: {
  userId: string
  domainType?: unknown
  domain?: unknown
}): Promise<SiteDomainChoice> {
  const requested = typeof opts.domain === 'string' ? opts.domain.trim().toLowerCase().replace(/\.$/, '') : ''
  if (!requested) {
    return { ok: false, status: 400, code: 'DOMAIN_REQUIRED', error: DOMAIN_REQUIRED_MESSAGE }
  }
  const type = typeof opts.domainType === 'string' ? opts.domainType : undefined
  if (type !== undefined && type !== 'existing' && type !== 'external' && type !== 'new') {
    return { ok: false, status: 400, code: 'DOMAIN_REQUIRED', error: DOMAIN_REQUIRED_MESSAGE }
  }
  if (!isValidHostname(requested)) {
    return { ok: false, status: 400, code: 'INVALID_DOMAIN', error: `"${requested}" is not a valid domain name.` }
  }
  if (isReservedHostname(requested, BRAND_DOMAIN)) {
    return {
      ok: false,
      status: 400,
      code: 'RESERVED_DOMAIN',
      error: `${requested} belongs to the platform and cannot be used. Use your own domain.`,
    }
  }
  // Platform-wide, so a customer cannot claim a hostname already serving
  // another tenant here.
  const clash = await findConflict(requested)
  if (clash.conflict) {
    return { ok: false, status: 409, code: 'DOMAIN_IN_USE', error: `${requested} is already in use on this platform.` }
  }

  const owned = await db.domain.findFirst({
    where: { userId: opts.userId, name: requested, status: { not: 'deleted' } },
    select: { id: true },
  })
  const effective: SiteDomainType = type ?? (owned ? 'existing' : 'external')

  if (effective === 'existing') {
    if (!owned) {
      return {
        ok: false,
        status: 400,
        code: 'DOMAIN_NOT_IN_ACCOUNT',
        error: `${requested} is not in your account. Choose "A domain I own elsewhere" if it is with another registrar.`,
      }
    }
    return { ok: true, domain: requested, customDomain: requested, externalDomain: null }
  }
  // SECURITY: an unverified external hostname is never written to
  // `customDomain` (that is what the proxy serves). It is attached as a
  // pending WebsiteDomain and connected once DNS proves ownership.
  return { ok: true, domain: requested, customDomain: null, externalDomain: requested }
}

/**
 * The domain a website is meant to be reached on, verified or not: its
 * `customDomain`, else its primary (then any) attached WebsiteDomain. Used
 * where the address must be written INTO the site (WordPress siteurl, an
 * app's APP_URL) before DNS is verified — never for routing, which only uses
 * verified domains. Null when the site has no domain at all.
 */
export async function intendedSiteHost(projectId: string): Promise<string | null> {
  const p = await db.project.findUnique({
    where: { id: projectId },
    select: {
      customDomain: true,
      websiteDomains: { select: { domain: true, isPrimary: true, verified: true }, orderBy: { createdAt: 'asc' } },
    },
  })
  if (!p) return null
  const verified = siteHostname(p)
  if (verified) return verified
  const rows = p.websiteDomains.filter((d) => !isPlatformHostname(d.domain))
  return (rows.find((d) => d.isPrimary) || rows[0])?.domain.toLowerCase() ?? null
}
