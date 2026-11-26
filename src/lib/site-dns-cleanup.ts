/**
 * Retire old `<slug>.<platform domain>` site addresses.
 * =====================================================
 *
 * Websites are served on real domains only. Before that rule every site had a
 * public `<project.subdomain>` address; this module removes what is left of
 * those addresses on the platform side:
 *
 *   1. DNS — when the platform zone is hosted on our PowerDNS, delete the
 *      A / AAAA / CNAME record sets whose name is EXACTLY a project's internal
 *      `subdomain` (or `www.` + it). Nothing else in the zone is touched.
 *   2. Proxy — regenerate each server's Caddyfile once after the upgrade, so
 *      the old subdomain routes disappear without waiting for a deploy.
 *
 * `selectRetiredSiteRecords` is pure and holds every safety rule, so it is
 * unit-tested on its own. If the platform zone lives at the registrar
 * (Dynadot) instead, the panel is not allowed to write it
 * (isProtectedDnsDomain) and the cleanup reports "skipped".
 */
import { db } from '@/lib/db'
import {
  BRAND_DOMAIN,
  NS1_HOSTNAME,
  NS2_HOSTNAME,
  MAIL_SERVER_HOSTNAME,
  CONNECT_HOSTNAME,
} from '@/lib/brand-config'
import { isReservedLabel } from '@/lib/custom-domains'

export interface ZoneRecordLike {
  name: string
  type: string
}

export interface RetiredRecord {
  name: string
  type: 'A' | 'AAAA' | 'CNAME'
  projectSubdomain: string
}

const ADDRESS_TYPES = new Set(['A', 'AAAA', 'CNAME'])

function norm(h: string | null | undefined): string {
  return (h || '').trim().toLowerCase().replace(/\.$/, '')
}

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return norm(new URL(url.includes('://') ? url : `https://${url}`).hostname)
  } catch {
    return ''
  }
}

/**
 * Names in the platform zone that must never be deleted, whatever the project
 * table says: the apex, www, the panel host, mail / autodiscover /
 * autoconfig / webmail, the nameservers, and the connect host.
 */
export function protectedPlatformNames(
  brand: string,
  env: Record<string, string | undefined> = process.env
): Set<string> {
  const b = norm(brand)
  const names = [
    b,
    `www.${b}`,
    `panel.${b}`,
    `mail.${b}`,
    `webmail.${b}`,
    `autodiscover.${b}`,
    `autoconfig.${b}`,
    `ns1.${b}`,
    `ns2.${b}`,
    `pma.${b}`,
    `pgadmin.${b}`,
    `connect.${b}`,
    norm(NS1_HOSTNAME),
    norm(NS2_HOSTNAME),
    norm(MAIL_SERVER_HOSTNAME),
    norm(CONNECT_HOSTNAME),
    hostOf(env.APP_URL),
    hostOf(env.NEXT_PUBLIC_APP_URL),
    hostOf(env.PANEL_DOMAIN),
  ]
  return new Set(names.filter(Boolean))
}

/**
 * Which records of the platform zone are retired site addresses.
 *
 * A record qualifies only when ALL hold:
 *   - type is A, AAAA or CNAME (never MX, TXT, NS, SOA, SRV, CAA …);
 *   - its name is exactly `<project.subdomain>` or `www.<project.subdomain>`;
 *   - that subdomain is a single label directly under the platform domain
 *     (`<label>.<brand>`), the label is not a reserved platform label
 *     (panel, mail, ns1, www, autodiscover, _dmarc, …) and not a wildcard;
 *   - the name is not in protectedPlatformNames.
 */
export function selectRetiredSiteRecords(opts: {
  records: ZoneRecordLike[]
  projectSubdomains: Array<string | null | undefined>
  brand: string
  protectedNames?: Set<string>
}): RetiredRecord[] {
  const brand = norm(opts.brand)
  if (!brand) return []
  const protectedNames = opts.protectedNames ?? protectedPlatformNames(brand)

  // name → the project subdomain it belongs to
  const candidates = new Map<string, string>()
  for (const raw of opts.projectSubdomains) {
    const sub = norm(raw)
    if (!sub.endsWith(`.${brand}`)) continue
    const label = sub.slice(0, -(brand.length + 1))
    // Exactly one label: `a.b.apsamo.com` is not a site address we created.
    if (!label || label.includes('.') || label.includes('*')) continue
    if (isReservedLabel(label)) continue
    if (protectedNames.has(sub)) continue
    candidates.set(sub, sub)
    const www = `www.${sub}`
    if (!protectedNames.has(www)) candidates.set(www, sub)
  }

  const out: RetiredRecord[] = []
  const seen = new Set<string>()
  for (const r of opts.records) {
    const type = (r.type || '').toUpperCase()
    if (!ADDRESS_TYPES.has(type)) continue
    const name = norm(r.name)
    const owner = candidates.get(name)
    if (!owner) continue
    const key = `${name}|${type}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name, type: type as RetiredRecord['type'], projectSubdomain: owner })
  }
  return out
}

export interface SiteDnsCleanupResult {
  skipped?: string
  removed: RetiredRecord[]
  error?: string
}

export interface SiteDnsCleanupDeps {
  brand?: string
  isConfigured?: () => boolean
  zoneExists?: (zone: string) => Promise<boolean>
  getZoneRecords?: (zone: string) => Promise<ZoneRecordLike[]>
  deleteRecordSets?: (zone: string, rrsets: Array<{ name: string; type: string }>) => Promise<{ ok: boolean; detail: string }>
  listProjectSubdomains?: () => Promise<string[]>
}

/** Delete retired site records from the platform zone (PowerDNS only). */
export async function cleanupPlatformSiteRecords(deps: SiteDnsCleanupDeps = {}): Promise<SiteDnsCleanupResult> {
  const zones = await import('@/lib/dns-zones')
  const brand = norm(deps.brand ?? (process.env.BRAND_DOMAIN || BRAND_DOMAIN))
  const isConfigured = deps.isConfigured ?? zones.isDnsHostingConfigured
  if (!isConfigured()) return { skipped: 'DNS hosting (PowerDNS) is not configured', removed: [] }
  const exists = await (deps.zoneExists ?? zones.zoneExists)(brand)
  if (!exists) return { skipped: `platform zone ${brand} is not hosted on our nameservers`, removed: [] }

  const records = await (deps.getZoneRecords ?? zones.getZoneRecords)(brand)
  const subs = await (deps.listProjectSubdomains ??
    (async () => (await db.project.findMany({ select: { subdomain: true } })).map((p) => p.subdomain)))()
  const retired = selectRetiredSiteRecords({ records, projectSubdomains: subs, brand })
  if (retired.length === 0) return { removed: [] }

  const del = await (deps.deleteRecordSets ?? zones.deleteRecordSets)(
    brand,
    retired.map((r) => ({ name: r.name, type: r.type }))
  )
  if (!del.ok) {
    console.error(`[site-dns-cleanup] could not remove ${retired.length} retired site record(s): ${del.detail}`)
    return { removed: [], error: del.detail }
  }
  for (const r of retired) {
    console.log(`[site-dns-cleanup] removed ${r.type} ${r.name} (retired site address of ${r.projectSubdomain})`)
  }
  return { removed: retired }
}

/** AppSetting flag: the one-off proxy regeneration has run. */
export const PROXY_SUBDOMAIN_PURGE_KEY = 'proxy.platformSubdomainRoutesRemoved'

/**
 * Regenerate every server's Caddyfile once, so routes for the retired
 * subdomains vanish right after the upgrade. Each configureProjectProxy call
 * rewrites the WHOLE Caddyfile of its server, so one running project per
 * server is enough. The flag is set only when every server succeeded.
 */
export async function purgeSubdomainRoutesOnce(): Promise<{ ran: boolean; servers: number; failed: number }> {
  const done = await db.appSetting.findUnique({ where: { key: PROXY_SUBDOMAIN_PURGE_KEY } }).catch(() => null)
  if (done) return { ran: false, servers: 0, failed: 0 }
  const { configureProjectProxy } = await import('@/lib/vps/proxy')
  const running = await db.project.findMany({
    where: { status: 'running', containerName: { not: null }, serverId: { not: null } },
    select: { id: true, serverId: true },
    orderBy: { createdAt: 'asc' },
  })
  const perServer = new Map<string, string>()
  for (const p of running) if (!perServer.has(p.serverId!)) perServer.set(p.serverId!, p.id)
  let failed = 0
  for (const [serverId, projectId] of perServer) {
    const r = await configureProjectProxy(projectId).catch((err: unknown) => ({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    }))
    if (!r.ok) {
      failed++
      console.error(`[site-dns-cleanup] proxy regeneration failed on server ${serverId}: ${r.message}`)
    }
  }
  if (failed === 0) {
    await db.appSetting
      .upsert({
        where: { key: PROXY_SUBDOMAIN_PURGE_KEY },
        create: { key: PROXY_SUBDOMAIN_PURGE_KEY, value: new Date().toISOString(), updatedBy: 'reconcile' },
        update: { value: new Date().toISOString(), updatedBy: 'reconcile' },
      })
      .catch(() => {})
    console.log(`[site-dns-cleanup] regenerated the proxy on ${perServer.size} server(s); platform subdomain routes removed`)
  }
  return { ran: true, servers: perServer.size, failed }
}
