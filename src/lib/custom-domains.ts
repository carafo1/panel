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
  method?: 'nameserver' | 'dns-txt' | 'a-record'
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

/**
 * Labels a customer may not take as their <label>.apsamo.com address.
 *
 * Project slugs become subdomains and are written straight into the Caddyfile,
 * so a project named "panel" would emit a `panel.apsamo.com` vhost competing
 * with the control panel's own. isReservedHostname does not cover this: it
 * rejects hostnames *ending in* the brand domain, which is about customers
 * pasting someone else's address, not about which label a slug may occupy.
 *
 * Grounded in what this server actually serves today (panel, mail, pgadmin,
 * pma in the Caddyfile; mail.apsamo.com in mailcow.conf) plus the mail and
 * control-plane names that are conventionally expected to exist.
 */
export const RESERVED_SUBDOMAIN_LABELS = new Set([
  // control plane
  'panel', 'admin', 'dashboard', 'api', 'app', 'billing', 'status',
  'account', 'accounts', 'login', 'auth', 'sso', 'support', 'help', 'docs',
  // database consoles the panel runs
  'pma', 'phpmyadmin', 'pgadmin', 'db', 'database', 'adminer',
  // mail, where a wrong answer silently breaks delivery
  'mail', 'webmail', 'smtp', 'imap', 'pop', 'pop3', 'mx', 'autodiscover',
  'autoconfig', 'mta-sts', 'dmarc', 'dkim', 'spf', 'bounce', 'newsletter',
  // dns
  'ns', 'ns1', 'ns2', 'ns3', 'ns4', 'dns',
  // web conventions
  'www', 'ftp', 'sftp', 'cdn', 'static', 'assets', 'media', 'img', 'images',
  // environments an operator expects to control
  'dev', 'staging', 'stage', 'test', 'qa', 'preview', 'demo', 'sandbox',
  'internal', 'vpn', 'remote', 'git', 'ci', 'registry', 'monitor', 'metrics',
])

/** May a customer project occupy `<label>.<brand>`? */
export function isReservedLabel(label: string): boolean {
  const l = label.toLowerCase()
  // Leading underscore is reserved for protocol records (_dmarc, _acme-challenge).
  if (l.startsWith('_')) return true
  return RESERVED_SUBDOMAIN_LABELS.has(l)
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
  /** 'nameserver' (default) or 'manual'. */
  method?: string
}): Promise<VerifyResult> {
  const { domain, token, serverIps } = opts

  // ── Primary proof: the domain is delegated to our nameservers ─────
  //
  // This is the default path and needs no DNS knowledge from the customer:
  // they change two fields at their registrar and we host the zone. Control
  // of a domain's delegation is the strongest possible proof of ownership —
  // stronger than a TXT record, since it is set at the registrar itself.
  if (opts.method !== 'manual') {
    const { checkNameserverDelegation } = await import('@/lib/dns-zones')
    const ns = await checkNameserverDelegation(domain)
    if (ns.delegated) {
      return { verified: true, method: 'nameserver', detail: ns.detail }
    }
    // Fall through to the record checks — a customer who chose nameservers
    // but already pointed an A record here should not be left stuck.
    const fallback = await checkRecordProofs(domain, token, serverIps)
    if (fallback.verified) return fallback
    return { verified: false, detail: ns.detail }
  }

  return checkRecordProofs(domain, token, serverIps)
}

/** TXT / A-record proofs — the advanced path, and a fallback. */
async function checkRecordProofs(
  domain: string,
  token: string,
  serverIps: string[]
): Promise<VerifyResult> {

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
  /** Domains whose certificate was confirmed working this run. */
  sslConfirmed: number
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
        connectionMethod: true,
        zoneCreated: true,
        createdAt: true,
        project: { select: { userId: true, name: true } },
      },
      take: 200,
    })
    .catch(() => [])

  // Verified domains whose certificate hasn't been confirmed yet. Caddy
  // issues lazily on first request, so an unvisited domain would sit in
  // `pending` forever — the probe both triggers issuance and confirms it.
  const awaitingSsl = await db.websiteDomain
    .findMany({
      where: { verified: true, sslEnabled: true, sslStatus: { in: ['pending', 'failed'] } },
      select: { id: true, domain: true, projectId: true, project: { select: { userId: true, name: true } } },
      take: 50,
    })
    .catch(() => [])

  let sslConfirmed = 0
  for (const row of awaitingSsl) {
    const probe = await probeHttps(row.domain)
    if (probe.ok) {
      await db.websiteDomain
        .update({
          where: { id: row.id },
          data: { sslStatus: 'issued', lastCheckedAt: new Date(), lastCheckError: null },
        })
        .catch(() => {})
      sslConfirmed++
      await createNotification({
        userId: row.project.userId,
        title: 'Website Live',
        message: `${row.domain} is live over HTTPS with a valid certificate.`,
        type: 'success',
        link: '/?tab=hosting',
      }).catch(() => {})
    } else {
      await db.websiteDomain
        .update({
          where: { id: row.id },
          data: { lastCheckedAt: new Date(), lastCheckError: probe.error?.slice(0, 300) ?? null },
        })
        .catch(() => {})
    }
  }

  if (pending.length === 0) {
    return { checked: 0, connected: 0, stillPending: 0, failed: 0, sslConfirmed }
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

      // The zone must exist BEFORE the check: once the registry delegates
      // to us, nothing resolves until we answer for the domain, so a check
      // that waits for the delegation to resolve could never succeed (our
      // nameserver answered REFUSED and the domain stayed "waiting for
      // nameservers" forever). See publishPendingZone.
      if (row.connectionMethod !== 'manual' && !row.zoneCreated) {
        await publishPendingZone(row.id, row.domain)
      }

      const result = await checkOwnership({
        domain: row.domain,
        token,
        serverIps,
        method: row.connectionMethod,
      })

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

      // Delegated to us → we are now authoritative, so publish the zone
      // immediately. Any delay here is a window where the domain resolves
      // to nothing at all.
      if (result.method === 'nameserver') {
        const zone = await ensureZoneForDomain({
          domainRowId: row.id,
          domain: row.domain,
        }).catch((err) => ({ ok: false, detail: String(err) }))
        if (!zone.ok) {
          console.error('[domain-sweep] zone creation failed for', row.domain, zone.detail)
        }
      }

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
    sslConfirmed,
  }
}

/* ────────────────────────────────────────────────────────────────────
 * Connection status
 * ──────────────────────────────────────────────────────────────────── */

export type ConnectionStage =
  | 'awaiting_nameservers'
  | 'nameservers_verified'
  | 'configuring_dns'
  | 'installing_ssl'
  | 'live'
  | 'blocked'

export interface ConnectionStatus {
  stage: ConnectionStage
  label: string
  detail: string
  /** 0-100, for a progress indicator. */
  percent: number
  /** True while the customer still has something to do. */
  needsAction: boolean
}

/**
 * Human-readable connection state for one custom domain.
 *
 * Derived from what has actually been observed, never assumed: `live` means
 * an HTTPS request to the domain succeeded, not merely that the hostname was
 * written into the Caddy config.
 */
export function describeConnection(row: {
  verified: boolean
  sslEnabled: boolean
  sslStatus: string
  lastCheckError?: string | null
  connectionMethod?: string
  zoneCreated?: boolean
}): ConnectionStatus {
  const manual = row.connectionMethod === 'manual'

  if (!row.verified) {
    if ((row.lastCheckError || '').includes('in use by another')) {
      return {
        stage: 'blocked',
        label: 'Blocked',
        detail: row.lastCheckError || 'This domain is in use elsewhere on the platform.',
        percent: 0,
        needsAction: true,
      }
    }
    return {
      stage: 'awaiting_nameservers',
      label: manual ? 'Waiting for DNS Record' : 'Waiting for Nameserver Update',
      detail:
        row.lastCheckError ||
        (manual
          ? 'Point the A record at our server. We re-check every couple of minutes.'
          : 'Update the nameservers at your registrar to the ones shown below. We re-check every couple of minutes.'),
      percent: 10,
      needsAction: true,
    }
  }

  // Delegated to us, but the zone we serve isn't published yet.
  if (!manual && !row.zoneCreated) {
    return {
      stage: 'nameservers_verified',
      label: 'Nameservers Verified',
      detail: 'Your nameservers point here. Building your DNS zone…',
      percent: 40,
      needsAction: false,
    }
  }

  if (!row.sslEnabled) {
    return {
      stage: 'live',
      label: 'Website Live',
      detail: 'Serving over HTTP (SSL is disabled for this domain).',
      percent: 100,
      needsAction: false,
    }
  }

  if (row.sslStatus === 'issued') {
    return {
      stage: 'live',
      label: 'Website Live',
      detail: manual
        ? 'Connected and serving over HTTPS with a valid certificate.'
        : 'DNS is hosted here and the site is serving over HTTPS with a valid certificate.',
      percent: 100,
      needsAction: false,
    }
  }

  if (row.sslStatus === 'failed') {
    return {
      stage: 'installing_ssl',
      label: 'SSL Retrying',
      detail:
        'DNS is configured and the site is served, but the certificate has not been issued yet. This usually clears on its own; Let’s Encrypt rate limits can delay it.',
      percent: 80,
      needsAction: false,
    }
  }

  return {
    stage: 'installing_ssl',
    label: 'Installing SSL',
    detail:
      'DNS configured. The certificate is issued on the first HTTPS request — usually within seconds.',
    percent: 80,
    needsAction: false,
  }
}

/**
 * Confirm HTTPS actually works for a domain.
 *
 * Caddy obtains certificates lazily, on the first request for a hostname, so
 * a domain can sit in `pending` forever if nobody visits it. This both
 * TRIGGERS issuance and verifies the result: a successful TLS handshake is
 * proof the certificate exists, which "we added it to the config" is not.
 */
export async function probeHttps(
  domain: string
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const res = await fetch(`https://${domain}/`, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
      })
      // Any HTTP status means the TLS handshake completed, which is the thing
      // being tested. A 404 from the app still proves the certificate works.
      return { ok: true, status: res.status }
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    }
  }
}

/**
 * Publish the DNS zone for a domain that is now delegated to our nameservers.
 *
 * IMPORTANT: the customer's existing MX and TXT records are read from their
 * OLD DNS and carried into the new zone. Once delegation flips we answer for
 * everything, so publishing a website-only zone would delete their mail
 * routing and SPF — breaking email invisibly, which is far worse than the
 * website being late.
 *
 * Idempotent and safe to call repeatedly.
 */
/**
 * Publish the DNS zone for a domain the customer is connecting by
 * nameservers, before ownership is verified.
 *
 * Why before: the registrar change makes our nameservers the only source of
 * answers for the domain. Until the zone exists they answer REFUSED, the
 * domain resolves nowhere, and the delegation check (which resolves the
 * domain's NS records) can never see it — a deadlock. Hosted DNS providers
 * create the zone when the domain is added for the same reason.
 *
 * Safe before verification: resolvers only ask our nameservers about a
 * domain when its registry delegates it to us, which is itself the proof of
 * control; nothing is served by the web proxy until the domain is verified;
 * and the domain name is unique platform-wide. Creating the zone this early
 * also lets ensureZoneForDomain copy the customer's existing records (MX,
 * TXT, ...) while their old nameservers still answer.
 *
 * Best-effort: a failure is logged and retried by the sweep.
 */
export async function publishPendingZone(domainRowId: string, domain: string): Promise<void> {
  const r = await ensureZoneForDomain({ domainRowId, domain }).catch((err: unknown) => ({
    ok: false,
    detail: err instanceof Error ? err.message : String(err),
  }))
  if (!r.ok) console.error('[dns-zone] could not publish zone for', domain, '-', r.detail)
}

export async function ensureZoneForDomain(opts: {
  domainRowId: string
  domain: string
}): Promise<{ ok: boolean; detail: string }> {
  const {
    isDnsHostingConfigured,
    snapshotExistingRecords,
    buildDefaultRecords,
    createZone,
  } = await import('@/lib/dns-zones')

  if (!isDnsHostingConfigured()) {
    return { ok: false, detail: 'DNS hosting is not configured on this server.' }
  }

  const serverIps = await getServerIps()
  if (serverIps.length === 0) {
    return { ok: false, detail: 'No server IP available to point the zone at.' }
  }

  // Snapshot BEFORE creating the zone — once ours is authoritative these
  // lookups would return our own records instead of the customer's originals.
  const preserve = await snapshotExistingRecords(opts.domain)

  const records = buildDefaultRecords({
    domain: opts.domain,
    serverIp: serverIps[0],
    preserve,
  })

  if (preserve.hasComplexDns) {
    console.log(
      `[dns-zone] ${opts.domain}: carried ${preserve.extra.length} existing record(s) across`
    )
  }

  const result = await createZone({ domain: opts.domain, records })
  if (result.ok) {
    await db.websiteDomain
      .update({
        where: { id: opts.domainRowId },
        data: { zoneCreated: true, zoneCreatedAt: new Date() },
      })
      .catch(() => {})
  }
  return { ok: result.ok, detail: result.detail }
}
