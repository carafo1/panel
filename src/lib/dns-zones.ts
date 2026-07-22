/**
 * Authoritative DNS zone management (PowerDNS).
 *
 * This is what makes ns1/ns2.apsamo.com a real answer to "how do I connect my
 * domain". Until PowerDNS was installed those hostnames resolved but nothing
 * listened on port 53, so delegating to them would have taken a customer's
 * domain offline entirely.
 *
 * Once a customer points their registrar at our nameservers we own their zone,
 * which means we are responsible for every record in it — not just the website.
 * Losing their MX would silently kill their email, so `buildDefaultRecords`
 * carries mail and verification records across rather than publishing a
 * website-only zone.
 */
import { getDnsRecords } from '@/lib/dns'
import { NS1_HOSTNAME, NS2_HOSTNAME, MAIL_SERVER_HOSTNAME } from '@/lib/brand-config'

const API_URL = process.env.PDNS_API_URL || ''
const API_KEY = process.env.PDNS_API_KEY || ''

export function isDnsHostingConfigured(): boolean {
  return Boolean(API_URL && API_KEY)
}

/** Our nameservers, as a customer must enter them at their registrar. */
export const APSAMO_NAMESERVERS = [NS1_HOSTNAME, NS2_HOSTNAME]

export interface ZoneRecord {
  name: string
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS'
  content: string
  ttl?: number
}

interface PdnsRRSet {
  name: string
  type: string
  ttl: number
  changetype?: string
  records: Array<{ content: string; disabled: boolean }>
}

async function pdns(
  path: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; body: unknown }> {
  if (!isDnsHostingConfigured()) {
    return { ok: false, status: 0, body: { error: 'DNS hosting is not configured' } }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        'X-API-Key': API_KEY,
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
      signal: controller.signal,
    })
    const text = await res.text()
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    return { ok: res.ok, status: res.status, body }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: { error: err instanceof Error ? err.message : String(err) },
    }
  } finally {
    clearTimeout(timer)
  }
}

/** PowerDNS wants fully-qualified names with a trailing dot. */
function fqdn(name: string): string {
  return name.endsWith('.') ? name : `${name}.`
}

/**
 * Has the customer actually delegated to us?
 *
 * Read from the PARENT delegation, which is what the internet uses — not from
 * whatever our own zone claims. Checking our own NS records would be circular
 * and would report success before the registrar change had propagated.
 */
export async function checkNameserverDelegation(
  domain: string
): Promise<{ delegated: boolean; current: string[]; detail: string }> {
  const ns = (await getDnsRecords(domain, 'NS')).map((n) =>
    n.replace(/\.$/, '').toLowerCase()
  )
  if (ns.length === 0) {
    return {
      delegated: false,
      current: [],
      detail:
        'No nameservers found for this domain yet. If you just updated them at your registrar, this can take up to 24 hours to propagate (usually much less).',
    }
  }

  const ours = APSAMO_NAMESERVERS.map((n) => n.toLowerCase())
  // Every delegated nameserver must be ours. A partial change (one of two)
  // means the registrar update is incomplete and answers would be
  // inconsistent depending on which server a resolver picks.
  const matched = ns.filter((n) => ours.includes(n))
  if (matched.length >= ours.length) {
    return {
      delegated: true,
      current: ns,
      detail: `Delegated to ${matched.join(', ')}.`,
    }
  }
  if (matched.length > 0) {
    return {
      delegated: false,
      current: ns,
      detail: `Only ${matched.join(', ')} is set. Add the remaining nameserver so all of them point here: ${ours.join(', ')}.`,
    }
  }
  return {
    delegated: false,
    current: ns,
    detail: `Currently using ${ns.slice(0, 3).join(', ')}. Change these at your registrar to ${ours.join(', ')}.`,
  }
}

/**
 * The records a newly-hosted zone should contain.
 *
 * `preserve` carries over records read from the customer's CURRENT DNS before
 * the switch. Taking over a zone and publishing only web records would delete
 * their MX and break their email — the most damaging thing this feature could
 * do, and entirely invisible until someone tried to email them.
 */
export function buildDefaultRecords(opts: {
  domain: string
  serverIp: string
  serverIpV6?: string | null
  preserve?: { mx?: string[]; txt?: string[]; extra?: ZoneRecord[] }
}): ZoneRecord[] {
  const { domain, serverIp, serverIpV6, preserve } = opts
  const records: ZoneRecord[] = [
    { name: domain, type: 'A', content: serverIp },
    { name: `www.${domain}`, type: 'CNAME', content: fqdn(domain) },
  ]

  if (serverIpV6) {
    records.push({ name: domain, type: 'AAAA', content: serverIpV6 })
  }

  // Mail: keep whatever they already had, or fall back to our mail server.
  if (preserve?.mx?.length) {
    for (const mx of preserve.mx) records.push({ name: domain, type: 'MX', content: mx })
  } else {
    records.push({ name: domain, type: 'MX', content: `10 ${fqdn(MAIL_SERVER_HOSTNAME)}` })
  }

  // Preserve verification/SPF TXT records — losing an SPF record silently
  // degrades their mail deliverability.
  if (preserve?.txt?.length) {
    for (const txt of preserve.txt) {
      records.push({ name: domain, type: 'TXT', content: `"${txt.replace(/^"|"$/g, '')}"` })
    }
  } else {
    records.push({ name: domain, type: 'TXT', content: `"v=spf1 mx a:${domain} ~all"` })
  }

  // Everything discovered at non-apex names: subdomains, DKIM selectors,
  // SaaS CNAMEs. Skip `www`, which is recreated above pointing at us.
  for (const r of preserve?.extra ?? []) {
    if (r.name === `www.${domain}`) continue
    records.push(r)
  }

  return records
}

/**
 * Names worth probing before we take a zone over.
 *
 * DNS has no "list every record" operation — AXFR is refused essentially
 * everywhere — so a complete copy of someone's zone is impossible from the
 * outside. The best available approach is to ask for the names that are
 * actually common and keep whatever answers.
 *
 * DKIM selectors matter most: losing one doesn't break anything visibly, it
 * just makes the customer's mail start failing DMARC and landing in spam,
 * which nobody connects to a DNS change made days earlier.
 */
const COMMON_SUBDOMAINS = [
  'www', 'mail', 'webmail', 'smtp', 'imap', 'pop', 'ftp',
  'blog', 'shop', 'store', 'api', 'app', 'admin', 'portal',
  'dev', 'staging', 'test', 'cdn', 'static', 'assets', 'm',
  'autodiscover', 'autoconfig', 'remote', 'vpn', 'git', 'docs',
]

/** Selector names used by the major mail providers and ESPs. */
const DKIM_SELECTORS = [
  'default', 'google', 'selector1', 'selector2', 'k1', 'k2',
  's1', 's2', 'mail', 'dkim', 'zoho', 'mandrill', 'sendgrid',
  'mailjet', 'mailgun', 'postmark', 'sm', 'smtp', 'protonmail',
]

/** TXT names that carry policy rather than content. */
const POLICY_TXT = ['_dmarc', '_domainkey', '_mta-sts', '_smtp._tls']

export interface ZoneSnapshot {
  mx: string[]
  txt: string[]
  /** Records found at names other than the apex. */
  extra: ZoneRecord[]
  /** True if anything beyond the apex was found — used to warn the customer. */
  hasComplexDns: boolean
}

/**
 * Read as much of the customer's existing zone as DNS allows.
 *
 * Runs BEFORE delegation flips, because once we are authoritative these
 * lookups return our own records instead of the customer's originals.
 */
export async function snapshotExistingRecords(domain: string): Promise<ZoneSnapshot> {
  const [mx, txt] = await Promise.all([
    getDnsRecords(domain, 'MX').catch(() => []),
    getDnsRecords(domain, 'TXT').catch(() => []),
  ])

  const extra: ZoneRecord[] = []

  // Probe in parallel but in bounded batches — a few dozen lookups at once
  // is fine, a few hundred would look like abuse to a resolver.
  const probe = async (name: string) => {
    const fqName = `${name}.${domain}`
    const [a, cname] = await Promise.all([
      getDnsRecords(fqName, 'A').catch(() => []),
      getDnsRecords(fqName, 'CNAME').catch(() => []),
    ])
    // A CNAME and an A cannot coexist; prefer the CNAME as the more
    // meaningful record (it usually points at a SaaS provider).
    if (cname.length > 0) {
      extra.push({ name: fqName, type: 'CNAME', content: cname[0] })
    } else if (a.length > 0) {
      for (const ip of a) extra.push({ name: fqName, type: 'A', content: ip })
    }
  }

  const probeTxt = async (name: string) => {
    const fqName = `${name}.${domain}`
    const t = await getDnsRecords(fqName, 'TXT').catch(() => [])
    for (const v of t) {
      extra.push({ name: fqName, type: 'TXT', content: `"${v.replace(/^"|"$/g, '')}"` })
    }
  }

  const batch = async <T>(items: T[], fn: (t: T) => Promise<void>, size = 12) => {
    for (let i = 0; i < items.length; i += size) {
      await Promise.all(items.slice(i, i + size).map(fn))
    }
  }

  await batch(COMMON_SUBDOMAINS, probe)
  await batch(
    [...POLICY_TXT, ...DKIM_SELECTORS.map((sel) => `${sel}._domainkey`)],
    probeTxt
  )

  return {
    mx,
    txt,
    extra,
    // `www` alone isn't "complex" — we recreate that ourselves.
    hasComplexDns: extra.some((r) => !r.name.startsWith(`www.`)),
  }
}

/** Does the zone already exist on our nameservers? */
export async function zoneExists(domain: string): Promise<boolean> {
  const res = await pdns(`/zones/${fqdn(domain)}`)
  return res.ok
}

/**
 * Create (or update) the zone and publish its records.
 * Idempotent: an existing zone has its records replaced rather than erroring.
 */
export async function createZone(opts: {
  domain: string
  records: ZoneRecord[]
}): Promise<{ ok: boolean; created: boolean; detail: string }> {
  const { domain, records } = opts
  if (!isDnsHostingConfigured()) {
    return { ok: false, created: false, detail: 'DNS hosting is not configured on this server.' }
  }

  const exists = await zoneExists(domain)

  if (!exists) {
    const res = await pdns('/zones', {
      method: 'POST',
      body: JSON.stringify({
        name: fqdn(domain),
        kind: 'Native',
        nameservers: APSAMO_NAMESERVERS.map(fqdn),
      }),
    })
    if (!res.ok) {
      return {
        ok: false,
        created: false,
        detail: `Could not create the DNS zone: ${JSON.stringify(res.body).slice(0, 180)}`,
      }
    }
  }

  // Group records by (name, type) — PowerDNS replaces a whole RRset at once.
  const grouped = new Map<string, PdnsRRSet>()
  for (const r of records) {
    const key = `${fqdn(r.name)}|${r.type}`
    const existing = grouped.get(key)
    if (existing) {
      existing.records.push({ content: r.content, disabled: false })
    } else {
      grouped.set(key, {
        name: fqdn(r.name),
        type: r.type,
        ttl: r.ttl ?? 3600,
        changetype: 'REPLACE',
        records: [{ content: r.content, disabled: false }],
      })
    }
  }

  const patch = await pdns(`/zones/${fqdn(domain)}`, {
    method: 'PATCH',
    body: JSON.stringify({ rrsets: [...grouped.values()] }),
  })
  if (!patch.ok) {
    return {
      ok: false,
      created: !exists,
      detail: `Zone exists but records could not be written: ${JSON.stringify(patch.body).slice(0, 180)}`,
    }
  }

  return {
    ok: true,
    created: !exists,
    detail: `${exists ? 'Updated' : 'Created'} zone with ${records.length} record(s).`,
  }
}

/** Remove a zone — used when a domain is detached from a project. */
export async function deleteZone(domain: string): Promise<boolean> {
  const res = await pdns(`/zones/${fqdn(domain)}`, { method: 'DELETE' })
  return res.ok
}

/** Read back what we are actually publishing, for display and verification. */
export async function getZoneRecords(domain: string): Promise<ZoneRecord[]> {
  const res = await pdns(`/zones/${fqdn(domain)}`)
  if (!res.ok) return []
  const body = res.body as { rrsets?: PdnsRRSet[] } | null
  const out: ZoneRecord[] = []
  for (const rr of body?.rrsets || []) {
    if (rr.type === 'SOA') continue
    for (const rec of rr.records) {
      out.push({
        name: rr.name.replace(/\.$/, ''),
        type: rr.type as ZoneRecord['type'],
        content: rec.content,
        ttl: rr.ttl,
      })
    }
  }
  return out
}
