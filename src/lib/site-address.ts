/**
 * Public address of a customer website.
 * =====================================
 *
 * Product rule: a website is only ever reachable on a real domain — one held
 * in the customer's account, or one they own elsewhere and have verified.
 * No `<slug>.<platform domain>` address is ever served, published in DNS,
 * issued a certificate, or shown to anyone.
 *
 * `Project.subdomain` still exists, but only as an INTERNAL slug-like value
 * (it historically held `<slug>.<brand>` and names nothing public now). Never
 * build a URL from it.
 *
 * Pure and dependency-free so it can run in client components, the Next
 * proxy, and server code alike.
 */

/** Shown wherever a website has no domain yet. */
export const NO_DOMAIN_LABEL = 'No domain connected'

/** Returned by every site-creating API when no domain is chosen. */
export const DOMAIN_REQUIRED_MESSAGE =
  'Choose a domain for this website — buy one or connect a domain you own.'

/** The platform's own domain (apsamo.com unless rebranded). */
export function platformDomain(): string {
  return (
    (typeof process !== 'undefined' &&
      (process.env.BRAND_DOMAIN || process.env.NEXT_PUBLIC_BRAND_DOMAIN)) ||
    'apsamo.com'
  ).toLowerCase()
}

/** True for the platform domain itself or any name under it. */
export function isPlatformHostname(host: string | null | undefined, brand = platformDomain()): boolean {
  const h = (host || '').trim().toLowerCase().replace(/\.$/, '')
  if (!h) return false
  const b = brand.toLowerCase()
  return h === b || h.endsWith(`.${b}`)
}

export interface SiteAddressSource {
  customDomain?: string | null
  websiteDomains?: Array<{ domain: string; isPrimary?: boolean | null; verified?: boolean | null }> | null
}

/**
 * The hostname a website is publicly served on, or null when it has none.
 *
 *   1. `customDomain` — a domain in the account, or an external domain the
 *      sweep promoted after verification.
 *   2. The primary VERIFIED WebsiteDomain, then any verified one.
 *
 * A platform hostname is never returned, even if old data still carries one.
 */
export function siteHostname(p: SiteAddressSource | null | undefined, brand = platformDomain()): string | null {
  if (!p) return null
  const cd = (p.customDomain || '').trim().toLowerCase()
  if (cd && !isPlatformHostname(cd, brand)) return cd
  const verified = (p.websiteDomains || []).filter(
    (d) => d && d.verified === true && d.domain && !isPlatformHostname(d.domain, brand)
  )
  const primary = verified.find((d) => d.isPrimary) || verified[0]
  return primary ? primary.domain.toLowerCase() : null
}

/** `https://<domain>` for the site, or null when no domain is connected. */
export function siteUrl(p: SiteAddressSource | null | undefined, brand = platformDomain()): string | null {
  const host = siteHostname(p, brand)
  return host ? `https://${host}` : null
}

/** Display text for a site's address. */
export function siteAddressLabel(p: SiteAddressSource | null | undefined, brand = platformDomain()): string {
  return siteHostname(p, brand) || NO_DOMAIN_LABEL
}

/**
 * A stored URL (e.g. an old Deployment.deployUrl) unless it points at the
 * platform domain — those retired `<slug>.<brand>` addresses are never shown.
 */
export function publicUrlOrNull(url: string | null | undefined, brand = platformDomain()): string | null {
  const v = (url || '').trim()
  if (!v) return null
  try {
    return isPlatformHostname(new URL(v.includes('://') ? v : `https://${v}`).hostname, brand) ? null : v
  } catch {
    return null
  }
}
