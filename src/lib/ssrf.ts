/**
 * SSRF guard for server-side fetches of user-supplied URLs.
 *
 * The panel fetches URLs that tenants control — uptime monitors (src/lib/monitor.ts)
 * and outbound webhooks (src/lib/webhook-delivery.ts). Without a guard a tenant
 * could point those at cloud metadata (169.254.169.254), localhost, or internal
 * services and exfiltrate secrets / reach the internal network.
 *
 * `assertPublicUrl(url)` throws unless the URL is http(s) AND every address the
 * host resolves to is publicly routable.
 *
 * Limitation: there is a small TOCTOU window between DNS resolution here and the
 * actual fetch (a hostile resolver could answer differently). This blocks the
 * practical vectors (metadata, RFC1918, loopback, link-local); fully closing the
 * window requires pinning the resolved IP into a custom undici dispatcher.
 */
import { lookup } from 'dns/promises'

/** True if an IPv4 address is loopback/private/link-local/reserved (not publicly routable). */
export function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10))
  if (
    parts.length !== 4 ||
    parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)
  ) {
    return true // not a valid IPv4 → block defensively
  }
  const [a, b] = parts
  if (a === 0) return true // 0.0.0.0/8 "this host"
  if (a === 10) return true // 10.0.0.0/8 private
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  if (a >= 224) return true // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false
}

/** True if an IPv6 address is loopback/private/link-local/reserved. */
export function isBlockedIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0] // drop any zone id
  if (addr === '::1' || addr === '::') return true // loopback / unspecified
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (mapped) return isBlockedIpv4(mapped[1]) // IPv4-mapped
  if (/^fe[89ab]/.test(addr)) return true // fe80::/10 link-local
  if (/^f[cd]/.test(addr)) return true // fc00::/7 unique-local
  if (addr.startsWith('ff')) return true // ff00::/8 multicast
  return false
}

/** True if an IP literal (v4 or v6) is not publicly routable. */
export function isBlockedAddress(ip: string): boolean {
  return ip.includes(':') ? isBlockedIpv6(ip) : isBlockedIpv4(ip)
}

/**
 * Throw unless `rawUrl` is an http(s) URL whose host resolves only to public
 * addresses. Call this immediately before fetching any tenant-supplied URL.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Invalid URL')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Blocked URL scheme: ${url.protocol}`)
  }

  const host = url.hostname.replace(/^\[|\]$/g, '') // strip [] from IPv6 literals

  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    throw new Error(`Cannot resolve host: ${host}`)
  }

  if (addresses.length === 0) {
    throw new Error(`Host did not resolve: ${host}`)
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(`Blocked non-public address for ${host}: ${address}`)
    }
  }
}
