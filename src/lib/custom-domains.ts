/**
 * Externally-registered custom domains.
 *
 * A customer who bought a domain at GoDaddy/Namecheap can point it at this
 * platform. Two rules make that safe, and neither was previously enforced:
 *
 *  1. OWNERSHIP MUST BE PROVEN before the domain reaches the reverse proxy.
 *     Without it, anyone could attach any hostname — including one already
 *     serving another customer here — and Caddy would happily serve it.
 *
 *  2. A DOMAIN BELONGS TO ONE PROJECT, PLATFORM-WIDE. The old duplicate check
 *     was scoped to a single project, so two tenants could both claim the same
 *     name and whoever wrote `customDomain` last won the Caddy block.
 *
 * Verification accepts either proof, because both demonstrate DNS control:
 *
 *   dns-txt   — a TXT record at _apsamo-verify.<domain> matching the token.
 *               Works before the customer switches live traffic over.
 *   a-record  — the domain's A record already resolves to this server, which
 *               is itself proof of control and means it's ready to serve.
 */
import { randomBytes } from 'crypto'
import { db } from '@/lib/db'
import { getDnsRecords } from '@/lib/dns'

/** Subdomain the TXT challenge is published at. */
export const VERIFY_PREFIX = '_apsamo-verify'

export interface VerifyResult {
  verified: boolean
  method?: 'dns-txt' | 'a-record'
  detail: string
}

/** Hostname shape check. Deliberately strict — this ends up in a Caddy block. */
export function isValidHostname(input: string): boolean {
  const h = input.trim().toLowerCase()
  if (!h || h.length > 253) return false
  if (h.includes('..') || h.startsWith('.') || h.endsWith('.')) return false
  // Must be a dotted name with a plausible TLD; rejects "localhost" and IPs.
  if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(h)) {
    return false
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false
  return true
}

/**
 * Hostnames customers must never be able to claim.
 *
 * Attaching `panel.apsamo.com` would let a customer's container serve the
 * control panel's own hostname, which is a phishing and session-theft risk.
 */
export function isReservedHostname(host: string, brandDomain: string): boolean {
  const h = host.toLowerCase()
  const brand = brandDomain.toLowerCase()
  if (h === brand) return true
  // Any subdomain of the brand belongs to the platform, not to customers —
  // those are handed out by the provisioner, not claimed by hand.
  if (h.endsWith(`.${brand}`)) return true
  return false
}

export function generateVerificationToken(): string {
  return `apsamo-verify-${randomBytes(16).toString('hex')}`
}

/**
 * Is this domain already claimed by a different project?
 *
 * Checks BOTH tables: `WebsiteDomain` rows and the legacy
 * `Project.customDomain` column, since the latter is what actually reaches
 * Caddy and predates this model.
 */
export async function findConflict(
  domain: string,
  excludeProjectId?: string
): Promise<{ conflict: true; owner: string } | { conflict: false }> {
  const existing = await db.websiteDomain.findUnique({
    where: { domain },
    select: { projectId: true },
  })
  if (existing && existing.projectId !== excludeProjectId) {
    return { conflict: true, owner: existing.projectId }
  }

  const legacy = await db.project.findFirst({
    where: { customDomain: domain, ...(excludeProjectId ? { id: { not: excludeProjectId } } : {}) },
    select: { id: true },
  })
  if (legacy) return { conflict: true, owner: legacy.id }

  return { conflict: false }
}

/**
 * Check whether the customer has proven control of the domain.
 *
 * Never throws — a DNS lookup failure is reported as "not yet verified" with
 * the reason, because that is what the customer needs to see.
 */
export async function checkOwnership(opts: {
  domain: string
  token: string
  serverIps: string[]
}): Promise<VerifyResult> {
  const { domain, token, serverIps } = opts

  // ── Proof 1: TXT challenge ────────────────────────────────────────
  // getDnsRecords already returns [] for NXDOMAIN/ENODATA rather than throwing.
  const txt = await getDnsRecords(`${VERIFY_PREFIX}.${domain}`, 'TXT')
  if (txt.some((v) => v.trim() === token)) {
    return {
      verified: true,
      method: 'dns-txt',
      detail: `TXT record at ${VERIFY_PREFIX}.${domain} matches.`,
    }
  }

  // ── Proof 2: A record already points here ─────────────────────────
  // If the domain resolves to this server, the owner has already pointed it
  // at us, which is equally strong proof of control and means it is ready
  // to serve immediately.
  const a = await getDnsRecords(domain, 'A')
  if (a.length > 0 && a.some((ip) => serverIps.includes(ip))) {
    return {
      verified: true,
      method: 'a-record',
      detail: `${domain} resolves to this server (${a.filter((ip) => serverIps.includes(ip)).join(', ')}).`,
    }
  }
  if (a.length > 0) {
    return {
      verified: false,
      detail: `${domain} currently points to ${a.join(', ')}, not to this server. Add the TXT record, or point the A record here.`,
    }
  }

  return {
    verified: false,
    detail: `No proof found yet. Add a TXT record at ${VERIFY_PREFIX}.${domain} with the value shown, or point ${domain}'s A record at this server. DNS changes can take up to an hour to propagate.`,
  }
}

/** The public IPs a customer may point an A record at. */
export async function getServerIps(): Promise<string[]> {
  const servers = await db.server
    .findMany({ where: { status: 'active' }, select: { ip: true, sshHost: true } })
    .catch(() => [])
  const ips = new Set<string>()
  for (const s of servers) {
    if (s.ip) ips.add(s.ip)
    // sshHost is often the same public address, and is what the provisioner
    // actually connects to.
    if (s.sshHost && /^\d+\.\d+\.\d+\.\d+$/.test(s.sshHost)) ips.add(s.sshHost)
  }
  return [...ips]
}
