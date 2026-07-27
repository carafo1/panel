/**
 * Domain ownership — who actually controls a domain.
 *
 * The panel supports exactly two kinds of domain, and conflating them is what
 * produced rows claiming to be registered with us that the registrar had never
 * heard of:
 *
 *   MANAGED   Bought (or transferred in) through us and sitting in our Dynadot
 *             account. We can change nameservers, lock it, toggle WHOIS
 *             privacy, pull an auth code, renew it, bill for it.
 *
 *   EXTERNAL  Registered at someone else's registrar. The customer points it
 *             at this server to host a site. We control the HOSTING and, if
 *             they delegate to our nameservers, the DNS zone — but we have no
 *             registrar authority over it whatsoever.
 *
 * The distinguishing fact is not what the row says. `provider` and `registrar`
 * are free-text columns that used to default to "dynadot", so an unlabelled row
 * silently claimed to be ours. The distinguishing fact is whether the registrar
 * gave us an order/domain id when it was registered: `externalId`. No
 * externalId means no registrar relationship, whatever the row claims.
 *
 * Use `assertRegistrarManaged()` at the top of every endpoint that talks to the
 * registrar. Without it, those calls fail deep inside the Dynadot client with
 * "could not find domain in your account", which surfaces to the customer as a
 * generic server error and to us as a support ticket.
 */

import { apiError } from './api-response'

export type DomainMode = 'managed' | 'external'

/** The subset of a Domain row needed to decide ownership. */
export interface OwnershipFields {
  name: string
  provider?: string | null
  registrar?: string | null
  externalId?: string | null
}

/** Registrar back-ends we can actually issue commands to. */
const REGISTRAR_PROVIDERS = new Set(['dynadot'])

/**
 * True when the domain really is in our registrar account.
 *
 * Requires BOTH a registrar provider AND the id that registrar handed back.
 * The id is the part that cannot be faked by a bad default or a hand-written
 * row — it only exists if a registration or transfer actually completed.
 */
export function isRegistrarManaged(domain: OwnershipFields): boolean {
  const provider = (domain.provider || '').toLowerCase()
  if (!REGISTRAR_PROVIDERS.has(provider)) return false
  return Boolean(domain.externalId && domain.externalId.trim())
}

export function domainMode(domain: OwnershipFields): DomainMode {
  return isRegistrarManaged(domain) ? 'managed' : 'external'
}

/**
 * A subdomain (more labels than the registrable name) can never be a
 * registration in its own right — `edma.apsamo.com` is a DNS record inside
 * `apsamo.com`, not a domain anyone can buy.
 *
 * Deliberately conservative: it only flags names that are unambiguously deeper
 * than a public-suffix + one label, so multi-label TLDs (`co.uk`, `com.so`)
 * are not misjudged. This is a sanity check for reconciliation and UI copy, not
 * an authorization boundary.
 */
export function looksLikeSubdomain(name: string): boolean {
  const labels = name.toLowerCase().split('.').filter(Boolean)
  // 2 labels is always a registrable domain (example.com).
  // 3 labels is ambiguous (example.co.uk vs sub.example.com) — don't guess.
  // 4+ labels cannot be a bare registration under any real public suffix.
  return labels.length >= 4
}

/** Why a registrar action is unavailable, in words a customer can act on. */
export function registrarUnavailableReason(domain: OwnershipFields): string {
  return (
    `${domain.name} is not registered through us, so we cannot change it at the registrar. ` +
    `Make this change at the provider you registered it with. ` +
    `You can still manage its DNS and hosting here, and you can transfer it in if you want us to manage it.`
  )
}

/**
 * Guard for registrar-only endpoints.
 *
 * Returns null when the operation may proceed, or a ready-to-return error
 * response when it may not.
 *
 * Deliberately 409 Conflict rather than 403: the caller is allowed to ask, the
 * domain is simply in the wrong state for this operation. 403 would suggest a
 * permissions problem the customer could resolve by logging in as someone else.
 */
export function assertRegistrarManaged(domain: OwnershipFields) {
  if (isRegistrarManaged(domain)) return null
  return apiError.conflict(registrarUnavailableReason(domain))
}
