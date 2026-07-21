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

/* ────────────────────────────────────────────────────────────────────
 * Continuous verification
 * ──────────────────────────────────────────────────────────────────── */

export interface DomainSweepResult {
  checked: number
  connected: number
  stillPending: number
  failed: number
}

/**
 * Re-check every pending custom domain and connect the ones that now resolve.
 *
 * Without this, a customer who adds the DNS record has to come back and press
 * "Verify" — and if they don't, their site never goes live even though the
 * DNS is correct. This runs on the worker tick so a domain connects on its own
 * within minutes of propagating.
 *
 * Only touches domains that are already attached and unverified. Verified
 * domains are left alone: re-checking them would risk pulling a live site out
 * of the proxy over a transient DNS blip.
 */
export async function sweepPendingDomains(): Promise<DomainSweepResult> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { configureProjectProxy } = require('@/lib/vps/proxy') as typeof import('@/lib/vps/proxy')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createNotification } = require('@/lib/notifications') as typeof import('@/lib/notifications')

  const pending = await db.websiteDomain
    .findMany({
      where: { verified: false },
      select: {
        id: true,
        domain: true,
        projectId: true,
        isPrimary: true,
        verificationToken: true,
        sslEnabled: true,
        createdAt: true,
        project: { select: { userId: true, name: true } },
      },
      take: 200,
    })
    .catch(() => [])

  if (pending.length === 0) {
    return { checked: 0, connected: 0, stillPending: 0, failed: 0 }
  }

  const serverIps = await getServerIps()
  let connected = 0
  let failed = 0
  const touchedProjects = new Set<string>()

  for (const row of pending) {
    try {
      // A row with no token predates this feature; mint one so the TXT proof
      // is available rather than skipping the domain forever.
      let token = row.verificationToken
      if (!token) {
        token = generateVerificationToken()
        await db.websiteDomain.update({
          where: { id: row.id },
          data: { verificationToken: token },
        })
      }

      const result = await checkOwnership({ domain: row.domain, token, serverIps })

      if (!result.verified) {
        await db.websiteDomain.update({
          where: { id: row.id },
          data: {
            lastCheckedAt: new Date(),
            lastCheckError: result.detail.slice(0, 300),
          },
        })
        continue
      }

      // Re-check the conflict at connect time: another project could have
      // claimed and verified this hostname while this row sat pending.
      const conflict = await findConflict(row.domain, row.projectId)
      if (conflict.conflict) {
        await db.websiteDomain.update({
          where: { id: row.id },
          data: {
            lastCheckedAt: new Date(),
            lastCheckError: 'Domain is now in use by another site on this platform.',
          },
        })
        failed++
        continue
      }

      await db.websiteDomain.update({
        where: { id: row.id },
        data: {
          verified: true,
          verifiedAt: new Date(),
          verificationMethod: result.method,
          lastCheckedAt: new Date(),
          lastCheckError: null,
          // Caddy issues the certificate on first request once the hostname
          // is in its config; 'pending' until we observe it succeed.
          sslStatus: row.sslEnabled ? 'pending' : 'none',
        },
      })

      if (row.isPrimary) {
        await db.project
          .update({ where: { id: row.projectId }, data: { customDomain: row.domain } })
          .catch(() => {})
      }

      touchedProjects.add(row.projectId)
      connected++

      await createNotification({
        userId: row.project.userId,
        title: 'Domain Connected',
        message: `${row.domain} is verified and now serving ${row.project.name} over HTTPS.`,
        type: 'success',
        link: '/?tab=hosting',
      }).catch(() => {})
    } catch (err) {
      failed++
      console.error('[domain-sweep] failed for', row.domain, err)
    }
  }

  // Reload the proxy once per project, not once per domain.
  for (const projectId of touchedProjects) {
    await configureProjectProxy(projectId).catch((err: unknown) =>
      console.error('[domain-sweep] proxy reload failed for', projectId, err)
    )
  }

  return {
    checked: pending.length,
    connected,
    stillPending: pending.length - connected - failed,
    failed,
  }
}
