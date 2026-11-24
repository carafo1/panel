/**
 * Cloudflare protection for a website's custom domains.
 *
 * Turning it on adds the domain to our Cloudflare account as a full-setup zone
 * (Cloudflare imports the existing DNS records, so email keeps working),
 * proxies the website's hostnames through Cloudflare and sets SSL to "Full".
 * The customer then changes their nameservers to the two Cloudflare gives;
 * until they do, nothing changes for visitors.
 *
 * What the customer gets on every Cloudflare zone: CDN caching, the free
 * managed WAF ruleset, and unmetered DDoS mitigation. "I'm under attack" mode
 * is offered only on plans with a DDoS tier set.
 *
 * Deliberately NOT turned on: Cloudflare's "Always Use HTTPS". Caddy already
 * redirects to HTTPS and needs plain-HTTP ACME challenges to renew certificates.
 */
import crypto from 'crypto'
import { db } from '@/lib/db'
import { isAdmin } from '@/lib/security'
import { tldFromDomain } from '@/lib/pricing'
import { isCustomDomainBacked } from '@/lib/mailcow-tenant'
import { cf, cloudflareConfig, cloudflareMode, accountIdFor, CloudflareError } from '@/lib/cloudflare'

export class CdnError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
  }
}

export const SECURITY_LEVELS = ['essentially_off', 'low', 'medium', 'high', 'under_attack'] as const

/** example.com for shop.example.com / www.example.co.uk → example.co.uk */
export function zoneNameFor(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '')
  const tld = tldFromDomain(h)
  const rest = h.slice(0, -tld.length).split('.').filter(Boolean)
  return `${rest[rest.length - 1]}${tld}`
}

async function planFeatures(ownerId: string, role?: string) {
  if (role && isAdmin(role)) return { cdn: true, underAttack: true, planName: null as string | null }
  const sub = await db.subscription.findFirst({
    where: { userId: ownerId, status: { in: ['active', 'trialing', 'past_due'] } },
    orderBy: { createdAt: 'desc' },
    include: { plan: { select: { name: true, cdnIntegration: true, ddosLevel: true } } },
  })
  if (!sub?.plan) return { cdn: true, underAttack: true, planName: null }
  return { cdn: sub.plan.cdnIntegration, underAttack: !!sub.plan.ddosLevel, planName: sub.plan.name }
}

async function siteHosts(projectId: string) {
  const p = await db.project.findUnique({
    where: { id: projectId },
    include: { server: { select: { ip: true } }, websiteDomains: { select: { domain: true, verified: true } } },
  })
  if (!p) throw new CdnError('Website not found.', 404)
  const hosts = new Set<string>()
  // Only a proven customDomain (verified WebsiteDomain, or a domain the owner
  // holds with us). An unverified one would put someone else's domain into
  // the platform's Cloudflare account.
  if (p.customDomain && (await isCustomDomainBacked(p, p.websiteDomains))) {
    hosts.add(p.customDomain.toLowerCase())
  }
  for (const d of p.websiteDomains) if (d.verified) hosts.add(d.domain.toLowerCase())
  return { project: p, hosts: [...hosts] }
}

function view(z: { id: string; domain: string; status: string; nameservers: string; securityLevel: string; developmentMode: boolean; lastError: string | null; activatedAt: Date | null }) {
  let ns: string[] = []
  try {
    ns = JSON.parse(z.nameservers)
  } catch {}
  return { id: z.id, domain: z.domain, status: z.status, nameservers: ns, securityLevel: z.securityLevel, developmentMode: z.developmentMode, lastError: z.lastError, activatedAt: z.activatedAt }
}

export async function cdnInfo(projectId: string, viewer: { role?: string }) {
  const { project, hosts } = await siteHosts(projectId)
  const [mode, plan, zones] = await Promise.all([
    cloudflareMode(),
    planFeatures(project.userId, viewer.role),
    db.cdnZone.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
  ])
  const zoneNames = [...new Set(hosts.map(zoneNameFor))]
  return {
    mode,
    planAllows: plan.cdn,
    underAttackAllowed: plan.underAttack,
    planName: plan.planName,
    candidates: zoneNames.filter((z) => !zones.some((x) => x.domain === z)),
    zones: zones.map(view),
  }
}

async function liveConfig() {
  const config = await cloudflareConfig()
  if (!config) throw new CdnError('Cloudflare is not connected yet. An administrator needs to add a Cloudflare API token.', 503)
  return config
}

export async function enableCdn(projectId: string, actor: { role?: string }, input: { domain?: unknown }) {
  const { project, hosts } = await siteHosts(projectId)
  const mode = await cloudflareMode()
  if (mode === 'off') throw new CdnError('Cloudflare protection is not available yet.', 503)
  const plan = await planFeatures(project.userId, actor.role)
  if (!plan.cdn) throw new CdnError(`CDN & Cloudflare protection is not included in the ${plan.planName} plan.`, 403)
  const zoneName = typeof input.domain === 'string' ? input.domain.toLowerCase().trim() : ''
  const siteHostsInZone = hosts.filter((h) => zoneNameFor(h) === zoneName)
  if (!zoneName || siteHostsInZone.length === 0) throw new CdnError('Connect that domain to this website first.', 404)
  if (await db.cdnZone.findUnique({ where: { domain: zoneName } })) throw new CdnError('That domain is already on Cloudflare.', 409)
  if (!project.server?.ip && mode === 'live') throw new CdnError('The website has no server address yet.', 409)

  if (mode === 'demo') {
    return view(
      await db.cdnZone.create({
        data: { projectId, domain: zoneName, zoneId: `demo-${crypto.randomBytes(8).toString('hex')}`, nameservers: JSON.stringify(['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com']) },
      })
    )
  }

  const config = await liveConfig()
  const accountId = await accountIdFor(config)
  let zone: { id: string; name_servers: string[]; status: string }
  try {
    zone = await cf(config, '/zones', { method: 'POST', body: { name: zoneName, account: { id: accountId }, type: 'full', jump_start: true } })
  } catch (e) {
    if (e instanceof CloudflareError && e.code === 1061) throw new CdnError('That domain already exists on Cloudflare in another account. Remove it there first.', 409)
    throw e
  }
  const row = await db.cdnZone.create({
    data: { projectId, domain: zoneName, zoneId: zone.id, status: zone.status === 'active' ? 'active' : 'pending', nameservers: JSON.stringify(zone.name_servers || []) },
  })
  try {
    await proxyHosts(config, zone.id, siteHostsInZone, project.server!.ip)
    await Promise.all([
      cf(config, `/zones/${zone.id}/settings/ssl`, { method: 'PATCH', body: { value: 'full' } }),
      cf(config, `/zones/${zone.id}/settings/min_tls_version`, { method: 'PATCH', body: { value: '1.2' } }),
      cf(config, `/zones/${zone.id}/settings/brotli`, { method: 'PATCH', body: { value: 'on' } }).catch(() => {}),
    ])
  } catch (e) {
    await db.cdnZone.update({ where: { id: row.id }, data: { lastError: e instanceof Error ? e.message : String(e) } })
    throw e
  }
  return view(row)
}

/** Point each of the site's hostnames at our server, proxied through Cloudflare. */
async function proxyHosts(config: { token: string }, zoneId: string, hosts: string[], ip: string) {
  for (const host of hosts) {
    const existing = await cf<Array<{ id: string; type: string; content: string }>>(config, `/zones/${zoneId}/dns_records?name=${encodeURIComponent(host)}&per_page=50`)
    const web = existing.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type))
    // Replace whatever the import found for this hostname with one proxied A record.
    for (const r of web) await cf(config, `/zones/${zoneId}/dns_records/${r.id}`, { method: 'DELETE' })
    await cf(config, `/zones/${zoneId}/dns_records`, { method: 'POST', body: { type: 'A', name: host, content: ip, proxied: true, ttl: 1, comment: 'Managed by Apsamo Panel' } })
  }
}

async function zoneFor(projectId: string, zoneRowId: string) {
  const z = await db.cdnZone.findFirst({ where: { id: zoneRowId, projectId } })
  if (!z) throw new CdnError('Not found.', 404)
  return z
}

/** Ask Cloudflare whether the nameservers have been switched. */
export async function refreshCdn(projectId: string, zoneRowId: string) {
  const z = await zoneFor(projectId, zoneRowId)
  if ((await cloudflareMode()) === 'demo' || z.zoneId.startsWith('demo-')) {
    return view(await db.cdnZone.update({ where: { id: z.id }, data: { status: 'active', activatedAt: z.activatedAt ?? new Date(), lastError: null } }))
  }
  const config = await liveConfig()
  const zone = await cf<{ status: string; name_servers: string[] }>(config, `/zones/${z.zoneId}`)
  const active = zone.status === 'active'
  return view(
    await db.cdnZone.update({
      where: { id: z.id },
      data: { status: active ? 'active' : zone.status === 'moved' || zone.status === 'deleted' ? 'error' : 'pending', nameservers: JSON.stringify(zone.name_servers || []), activatedAt: active ? (z.activatedAt ?? new Date()) : z.activatedAt, lastError: null },
    })
  )
}

export async function updateCdn(projectId: string, zoneRowId: string, actor: { role?: string }, input: { securityLevel?: unknown; developmentMode?: unknown }) {
  const z = await zoneFor(projectId, zoneRowId)
  const project = await db.project.findUnique({ where: { id: projectId }, select: { userId: true } })
  const plan = await planFeatures(project!.userId, actor.role)
  const data: { securityLevel?: string; developmentMode?: boolean } = {}
  if (input.securityLevel !== undefined) {
    if (!SECURITY_LEVELS.includes(input.securityLevel as never)) throw new CdnError('Unknown security level.')
    if (input.securityLevel === 'under_attack' && !plan.underAttack) throw new CdnError(`"I'm under attack" mode is not included in the ${plan.planName} plan.`, 403)
    data.securityLevel = input.securityLevel as string
  }
  if (input.developmentMode !== undefined) data.developmentMode = input.developmentMode === true
  if (!Object.keys(data).length) throw new CdnError('Nothing to change.')

  if (!z.zoneId.startsWith('demo-')) {
    const config = await liveConfig()
    if (data.securityLevel) await cf(config, `/zones/${z.zoneId}/settings/security_level`, { method: 'PATCH', body: { value: data.securityLevel } })
    if (data.developmentMode !== undefined) await cf(config, `/zones/${z.zoneId}/settings/development_mode`, { method: 'PATCH', body: { value: data.developmentMode ? 'on' : 'off' } })
  }
  return view(await db.cdnZone.update({ where: { id: z.id }, data }))
}

export async function purgeCdn(projectId: string, zoneRowId: string) {
  const z = await zoneFor(projectId, zoneRowId)
  if (!z.zoneId.startsWith('demo-')) {
    await cf(await liveConfig(), `/zones/${z.zoneId}/purge_cache`, { method: 'POST', body: { purge_everything: true } })
  }
  return { ok: true }
}

export async function disableCdn(projectId: string, zoneRowId: string) {
  const z = await zoneFor(projectId, zoneRowId)
  if (!z.zoneId.startsWith('demo-')) {
    try {
      await cf(await liveConfig(), `/zones/${z.zoneId}`, { method: 'DELETE' })
    } catch (e) {
      // Already gone on Cloudflare's side is fine.
      if (!(e instanceof CloudflareError && (e.code === 1001 || e.code === 7003))) throw e
    }
  }
  await db.cdnZone.delete({ where: { id: z.id } })
  return { ok: true }
}

/** For the public pricing page: only advertise protection we can provide. */
export async function cdnAdvertisable() {
  return (await cloudflareMode()) !== 'off'
}
