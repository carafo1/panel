/**
 * DNS resolution utilities using Node.js dns module.
 *
 * Used by:
 *  - #14 DNS Verification - verify domain ownership before SSL/DNS setup
 *
 * For propagation checks we query multiple public DNS resolvers to see whether
 * a record is consistently visible across the internet.
 */
import dns from 'dns'
import { promisify } from 'util'

const resolveTxt = promisify(dns.resolveTxt)
const resolveAny = promisify(dns.resolve as unknown as (
  domain: string,
  rrtype: string,
  callback: (err: NodeJS.ErrnoException | null, addresses: unknown[]) => void
) => void)

// Public DNS resolvers used for propagation checks
export const PUBLIC_DNS_SERVERS: Record<string, string> = {
  'Google (8.8.8.8)': '8.8.8.8',
  'Google (8.8.4.4)': '8.8.4.4',
  'Cloudflare (1.1.1.1)': '1.1.1.1',
  'Cloudflare (1.0.0.1)': '1.0.0.1',
  'Quad9 (9.9.9.9)': '9.9.9.9',
  'OpenDNS (208.67.222.222)': '208.67.222.222',
}

/**
 * Verify that a TXT record exists on the domain containing the expected value.
 * Used for domain-ownership verification (e.g. _deployhub-verify.example.com).
 */
export async function verifyTxtRecord(
  domain: string,
  expectedValue: string
): Promise<boolean> {
  try {
    const records = await resolveTxt(domain)
    // resolveTxt returns string[][] - flatten and compare
    for (const r of records) {
      const joined = Array.isArray(r) ? r.join('') : String(r)
      if (joined.includes(expectedValue)) return true
    }
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTFOUND') return false
    if ((error as NodeJS.ErrnoException).code === 'ENODATA') return false
     
    console.error('[dns] verifyTxtRecord error:', error)
    return false
  }
}

/**
 * Get DNS records of a given type for a domain.
 */
export async function getDnsRecords(
  domain: string,
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS'
): Promise<string[]> {
  try {
    if (type === 'TXT') {
      const records = await resolveTxt(domain)
      return records.map((r) => (Array.isArray(r) ? r.join('') : String(r)))
    }
    if (type === 'MX') {
      const records = (await resolveAny(domain, 'MX')) as dns.MxRecord[]
      return records.map((r) => `${r.priority} ${r.exchange}`)
    }
    const records = (await resolveAny(domain, type)) as string[] | string[][]
    if (Array.isArray(records) && records.length > 0 && Array.isArray(records[0])) {
      return (records as unknown[][]).map((r) => r.join(''))
    }
    return (records as string[]) || []
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOTFOUND' || code === 'ENODATA') return []
     
    console.error('[dns] getDnsRecords error:', error)
    return []
  }
}

interface PropagationResult {
  location: string
  matches: boolean
  value: string
}

/**
 * Check DNS propagation across multiple public DNS servers.
 * Returns the resolved value at each location and whether it matches the expected value.
 *
 * Implementation note: Node's dns module uses the system resolver by default.
 * To target a specific upstream server we set the resolver via `setServers`.
 */
export async function checkDomainPropagation(
  domain: string,
  type: string,
  expectedValue: string,
  locations?: string[]
): Promise<PropagationResult[]> {
  const serverList = locations ?? Object.entries(PUBLIC_DNS_SERVERS)
  const results: PropagationResult[] = []

  for (const [name, ip] of serverList) {
    try {
      // Use a fresh Resolver so we don't mutate the global dns state
      const resolver = new dns.Resolver()
      resolver.setServers([ip])

      const resolveFn = (rrtype: string) =>
        new Promise<string[]>((resolve, reject) => {
          resolver.resolve(domain, rrtype, (err, addresses) => {
            if (err) return reject(err)
            const flattened: string[] = []
            for (const a of addresses as unknown[]) {
              if (Array.isArray(a)) flattened.push(a.join(' '))
              else flattened.push(String(a))
            }
            resolve(flattened)
          })
        })

      const records = await resolveFn(type.toLowerCase())
      const value = records.join(', ')
      const matches = records.some((r) => r.includes(expectedValue))
      results.push({ location: name, matches, value })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOTFOUND' || code === 'ENODATA') {
        results.push({ location: name, matches: false, value: '' })
      } else {
        results.push({
          location: name,
          matches: false,
          value: `error: ${(error as Error).message}`,
        })
      }
    }
  }

  return results
}

/**
 * Convenience helper: check if a domain's A record points to a given IP
 * across all public resolvers. Returns true if any resolver matches.
 */
export async function isDomainPropagated(
  domain: string,
  expectedIp: string
): Promise<boolean> {
  const results = await checkDomainPropagation(domain, 'A', expectedIp)
  return results.some((r) => r.matches)
}
