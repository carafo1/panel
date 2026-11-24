/**
 * SSRF guard for server-side fetches of user-supplied URLs.
 *
 * The panel fetches URLs that tenants control — uptime monitors (src/lib/monitor.ts)
 * and outbound webhooks (src/lib/webhook-delivery.ts). Without a guard a tenant
 * could point those at cloud metadata (169.254.169.254), localhost, or internal
 * services and exfiltrate secrets / reach the internal network.
 *
 * `assertPublicUrl(url)` throws unless the URL is http(s) AND every address the
 * host resolves to is publicly routable. It returns the checked target.
 *
 * `fetchPublicTarget(target, init)` then fetches it safely:
 *   - redirects are never followed (`redirect: 'manual'`): a 3xx is the final
 *     answer, so a public URL cannot bounce the request to 127.0.0.1 or
 *     169.254.169.254;
 *   - under Bun (production runtime) the connection is pinned to the exact
 *     address that passed the check — the URL's host is replaced by that IP,
 *     with the original name sent as `Host` and as the TLS server name (SNI and
 *     certificate verification) — so a DNS-rebinding name cannot resolve to a
 *     private address between the check and the connect;
 *   - under Node (local `next dev` only) there is no way to pin without a new
 *     dependency, so the small re-resolution window remains there.
 *
 * `safeFetch(url, init)` is the two combined.
 */
import { lookup } from 'dns/promises'
import net from 'net'

/** True if an IPv4 address is loopback/private/link-local/reserved (not publicly routable). */
export function isBlockedIpv4(ip: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return true // not a dotted quad → block defensively
  const parts = ip.split('.').map((p) => parseInt(p, 10))
  if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true
  const [a, b, c] = parts
  if (a === 0) return true // 0.0.0.0/8 "this host"
  if (a === 10) return true // 10.0.0.0/8 private
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return true // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 benchmarking
  if (a >= 224) return true // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false
}

/**
 * Expand an IPv6 literal into its eight 16-bit groups. Handles `::`
 * compression and a trailing dotted IPv4 part. Returns null when the text is
 * not a valid IPv6 address.
 */
export function parseIpv6(ip: string): number[] | null {
  let addr = ip.toLowerCase().split('%')[0] // drop any zone id
  if (!net.isIPv6(addr)) return null
  // Trailing embedded IPv4 (e.g. ::ffff:127.0.0.1) → two hex groups.
  const v4 = addr.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [o1, o2, o3, o4] = v4.slice(1).map((n) => parseInt(n, 10))
    const hi = ((o1 << 8) | o2).toString(16)
    const lo = ((o3 << 8) | o4).toString(16)
    addr = addr.slice(0, v4.index) + `${hi}:${lo}`
  }
  const halves = addr.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 && missing !== 0) return null
  if (halves.length === 2 && missing < 1) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) =>
    parseInt(g, 16)
  )
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null
  return groups
}

function embeddedIpv4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
}

/** True if an IPv6 address is loopback/private/link-local/reserved. */
export function isBlockedIpv6(ip: string): boolean {
  const g = parseIpv6(ip)
  if (!g) return true // unparseable → block defensively
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g

  // ::ffff:0:0/96 — IPv4-mapped: judge the embedded IPv4 address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isBlockedIpv4(embeddedIpv4(g6, g7))
  }
  // ::/96 — unspecified, loopback and the deprecated IPv4-compatible range.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true
  // ::ffff:0:0:0/96 (SIIT) and anything else in 0::/16 that is not handled above.
  if (g0 === 0) return true
  // 64:ff9b::/96 and 64:ff9b:1::/48 — NAT64; the gateway would reach any IPv4.
  if (g0 === 0x64 && g1 === 0xff9b) return true
  // 100::/64 — discard-only.
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true
  // 2001::/32 Teredo (embeds an IPv4) and 2001:db8::/32 documentation.
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true
  // 2002::/16 — 6to4; relays reach the embedded IPv4.
  if (g0 === 0x2002) return true
  // fc00::/7 unique-local.
  if ((g0 & 0xfe00) === 0xfc00) return true
  // fe80::/10 link-local and fec0::/10 (deprecated site-local).
  if ((g0 & 0xff80) === 0xfe80) return true
  // ff00::/8 multicast.
  if ((g0 & 0xff00) === 0xff00) return true
  return false
}

/** True if an IP literal (v4 or v6) is not publicly routable. */
export function isBlockedAddress(ip: string): boolean {
  return ip.includes(':') ? isBlockedIpv6(ip) : isBlockedIpv4(ip)
}

/** A URL whose host resolved only to public addresses, and the one to connect to. */
export interface PublicTarget {
  url: URL
  /** Hostname without IPv6 brackets. */
  host: string
  /** The checked public address the request will be pinned to. */
  address: string
  family: 4 | 6
  isIpLiteral: boolean
}

/**
 * Cheap, offline check for a URL a tenant is about to SAVE (no DNS): http(s)
 * only, no credentials, and an IP-literal host must be public. Returns an
 * error message, or null when acceptable. The full check still runs at fetch
 * time.
 */
export function checkPublicUrlSyntax(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return 'Invalid URL'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'URL must use http:// or https://'
  if (url.username || url.password) return 'URL must not contain credentials'
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host) return 'Invalid URL'
  if (host === 'localhost' || host.endsWith('.localhost')) return 'URL must point to a public address'
  if (net.isIP(host) && isBlockedAddress(host)) return 'URL must point to a public address'
  return null
}

/**
 * Throw unless `rawUrl` is an http(s) URL whose host resolves only to public
 * addresses. Call this immediately before fetching any tenant-supplied URL,
 * and fetch through `fetchPublicTarget` with the returned target.
 */
export async function assertPublicUrl(rawUrl: string): Promise<PublicTarget> {
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

  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error(`Blocked non-public address: ${host}`)
    return { url, host, address: host, family: net.isIPv6(host) ? 6 : 4, isIpLiteral: true }
  }

  let addresses: Array<{ address: string; family: number }>
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
  const pick = addresses.find((a) => net.isIPv4(a.address)) ?? addresses[0]
  return {
    url,
    host,
    address: pick.address,
    family: net.isIPv6(pick.address) ? 6 : 4,
    isIpLiteral: false,
  }
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'

/**
 * The URL and fetch options that connect to `target.address` only, while the
 * server still sees the original host name (Host header, SNI, certificate
 * check). Exported for tests; Bun-specific options are typed loosely.
 */
export function pinnedRequest(
  target: PublicTarget,
  init: RequestInit = {}
): { url: string; init: RequestInit & Record<string, unknown> } {
  const headers = new Headers(init.headers)
  const base: RequestInit & Record<string, unknown> = { ...init, headers, redirect: 'manual' }
  if (target.isIpLiteral) {
    return { url: target.url.toString(), init: base }
  }
  const pinned = new URL(target.url.toString())
  pinned.hostname = target.family === 6 ? `[${target.address}]` : target.address
  headers.set('Host', target.url.host) // includes a non-default port
  base.proxy = false // an env proxy would resolve the name itself
  if (target.url.protocol === 'https:') {
    base.tls = { serverName: target.host }
  }
  return { url: pinned.toString(), init: base }
}

/**
 * Fetch a target returned by `assertPublicUrl`. Never follows redirects.
 *
 * `target` may be missing only when a test has replaced `assertPublicUrl`
 * (it then resolves to undefined); the request still refuses redirects.
 */
export async function fetchPublicTarget(
  target: PublicTarget | void,
  rawUrl: string,
  init: RequestInit = {}
): Promise<Response> {
  if (!target) {
    return fetch(rawUrl, { ...init, redirect: 'manual' })
  }
  if (!isBun) {
    // Node has no pinning without a dispatcher dependency (dev only).
    return fetch(target.url.toString(), { ...init, redirect: 'manual' })
  }
  const req = pinnedRequest(target, init)
  return fetch(req.url, req.init as RequestInit)
}

/** assertPublicUrl + fetchPublicTarget. */
export async function safeFetch(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  const target = await assertPublicUrl(rawUrl)
  return fetchPublicTarget(target, rawUrl, init)
}

/**
 * Read at most `maxBytes` of a response body as text, then cancel the rest,
 * so a hostile receiver cannot make the panel buffer an unbounded body.
 */
export async function readTextCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const room = maxBytes - total
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room))
        total += room
        truncated = true
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
    if (!truncated && total >= maxBytes) {
      const next = await reader.read()
      truncated = !next.done
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), truncated }
}
