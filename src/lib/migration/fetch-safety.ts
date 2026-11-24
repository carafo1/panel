/**
 * Fetching a customer-supplied URL from the server, safely
 * ========================================================
 *
 * "Import from URL" and "import from git" make the VPS (as root) download a
 * URL the customer typed. The API route checks the URL resolves only to
 * public addresses (lib/ssrf assertPublicUrl), but the download used to run
 * `curl -fsSL <url>` minutes later:
 *
 *   - `-L` followed redirects, so a public URL could 302 to
 *     http://169.254.169.254/ (cloud metadata) or http://127.0.0.1:…;
 *   - curl resolved the hostname again itself, so a DNS-rebinding name could
 *     pass the check and then point at a private address.
 *
 * Both are closed here: the address is re-checked right before the download,
 * curl is pinned to exactly that checked address (`--resolve`) and never
 * follows a redirect, and git gets the equivalent options. The command
 * builders are pure and unit-tested (tests/unit/fetch-safety.test.ts).
 */
import { promises as dns } from 'dns'
import net from 'net'
import { isBlockedAddress } from '@/lib/ssrf'
import { shellQuoteArg } from '@/lib/vps/deploy-safety'

export interface PinnedTarget {
  /** Hostname as curl/git will see it in the URL (no IPv6 brackets). */
  host: string
  port: number
  /** The public address that passed the check; the only one we connect to. */
  address: string
  /** The URL's host is already an IP literal (nothing to pin). */
  isIpLiteral: boolean
}

type LookupFn = (host: string) => Promise<Array<{ address: string }>>

const defaultLookup: LookupFn = (host) => dns.lookup(host, { all: true })

/**
 * Parse an http(s) URL, resolve its host NOW and return the address to pin
 * the download to. Throws (customer-safe message) unless every resolved
 * address is public. Prefers IPv4 when both families resolve.
 */
export async function resolvePinnedTarget(
  rawUrl: string,
  lookup: LookupFn = defaultLookup
): Promise<PinnedTarget> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Invalid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Blocked URL scheme: ${url.protocol}`)
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new Error('Invalid URL')
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80

  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error(`Blocked non-public address: ${host}`)
    return { host, port, address: host, isIpLiteral: true }
  }

  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host)
  } catch {
    throw new Error(`Cannot resolve host: ${host}`)
  }
  if (!addresses.length) throw new Error(`Host did not resolve: ${host}`)
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(`Blocked non-public address for ${host}: ${address}`)
    }
  }
  const v4 = addresses.find((a) => net.isIPv4(a.address))
  return { host, port, address: (v4 ?? addresses[0]).address, isIpLiteral: false }
}

/** `host:port:addr` for curl `--resolve` / git `http.curloptResolve`; null for IP-literal URLs. */
export function resolveEntry(t: PinnedTarget): string | null {
  if (t.isIpLiteral) return null
  const addr = net.isIPv6(t.address) ? `[${t.address}]` : t.address
  return `${t.host}:${t.port}:${addr}`
}

/** Marks curl's `--write-out` line in the command output. */
export const CURL_STATUS_MARKER = '__APSAMO_HTTP__'

/**
 * Shell command downloading `url` to `dest` on the server:
 *   --proto =https,http   no file://, gopher://, … even via the URL itself
 *   --max-redirs 0, no -L a redirect is reported, never followed
 *   --resolve             connect only to the address that passed the check
 * `-f` is not used: the HTTP status is printed instead (parseDownloadStatus)
 * so a 3xx is reported as a redirect rather than saved as the "archive".
 */
export function buildSafeDownloadCommand(url: string, dest: string, target: PinnedTarget): string {
  const resolve = resolveEntry(target)
  return [
    'curl -sS --proto =https,http --max-redirs 0 --max-time 3600',
    resolve ? `--resolve ${shellQuoteArg(resolve)}` : '',
    `-o ${shellQuoteArg(dest)}`,
    `-w ${shellQuoteArg(`${CURL_STATUS_MARKER}%{http_code} %{redirect_url}`)}`,
    `--url ${shellQuoteArg(url)}`,
    '2>&1',
  ]
    .filter(Boolean)
    .join(' ')
}

/** HTTP status and redirect target from the output of buildSafeDownloadCommand. */
export function parseDownloadStatus(output: string): { status: number; redirect: string | null } {
  const at = output.lastIndexOf(CURL_STATUS_MARKER)
  if (at < 0) return { status: 0, redirect: null }
  const rest = output.slice(at + CURL_STATUS_MARKER.length).trim()
  const [code, ...redirect] = rest.split(/\s+/)
  const status = Number.parseInt(code, 10) || 0
  return { status, redirect: redirect.join(' ').trim() || null }
}

/**
 * `git -c …` options for cloning a customer URL: never follow an HTTP
 * redirect, only http(s) transports, and pin the host to the checked address
 * (`http.curloptResolve`, git 2.37+; older git ignores the unknown key, so
 * the redirect and protocol rules still apply there).
 */
export function safeGitCloneConfig(target: PinnedTarget): string {
  const resolve = resolveEntry(target)
  return [
    '-c http.followRedirects=false',
    '-c protocol.allow=never -c protocol.https.allow=always -c protocol.http.allow=always',
    resolve ? `-c ${shellQuoteArg(`http.curloptResolve=${resolve}`)}` : '',
  ]
    .filter(Boolean)
    .join(' ')
}
