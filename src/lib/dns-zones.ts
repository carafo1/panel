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
  preserve?: { mx?: string[]; txt?: string[] }
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

  return records
}

/**
 * Read the customer's existing MX/TXT before we take the zone over, so they
 * can be carried into the new zone.
 */
export async function snapshotExistingRecords(
  domain: string
): Promise<{ mx: string[]; txt: string[] }> {
  const [mx, txt] = await Promise.all([
    getDnsRecords(domain, 'MX').catch(() => []),
    getDnsRecords(domain, 'TXT').catch(() => []),
  ])
  return { mx, txt }
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
