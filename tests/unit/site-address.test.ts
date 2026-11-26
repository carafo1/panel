/**
 * Websites are served on real domains only. Pure rules:
 *   - which hostname/URL a site has (never the platform subdomain);
 *   - which platform-zone DNS records the cleanup may delete (exact project
 *     subdomains only — never panel, mail, ns1/ns2, www, apex, MX, TXT …).
 */
import { describe, it, expect } from 'bun:test'
import { siteHostname, siteUrl, isPlatformHostname, publicUrlOrNull, siteAddressLabel, NO_DOMAIN_LABEL } from '@/lib/site-address'
import { selectRetiredSiteRecords, protectedPlatformNames } from '@/lib/site-dns-cleanup'

const BRAND = 'apsamo.com'

describe('site address', () => {
  it('uses the custom domain, then a verified primary domain, and never the platform', () => {
    expect(siteHostname({ customDomain: 'Shop.Example.com' }, BRAND)).toBe('shop.example.com')
    expect(
      siteHostname(
        {
          customDomain: null,
          websiteDomains: [
            { domain: 'pending.example.com', isPrimary: true, verified: false },
            { domain: 'b.example.com', isPrimary: false, verified: true },
            { domain: 'a.example.com', isPrimary: true, verified: true },
          ],
        },
        BRAND
      )
    ).toBe('a.example.com')
    // Old data carrying a platform name is ignored.
    expect(siteHostname({ customDomain: 'shop-1a2b.apsamo.com' }, BRAND)).toBeNull()
    expect(siteHostname({ customDomain: null, websiteDomains: [{ domain: 'x.apsamo.com', verified: true }] }, BRAND)).toBeNull()
    // Unverified only → no address yet.
    expect(siteUrl({ customDomain: null, websiteDomains: [{ domain: 'p.example.com', isPrimary: true, verified: false }] }, BRAND)).toBeNull()
    expect(siteUrl({ customDomain: 'example.org' }, BRAND)).toBe('https://example.org')
    expect(siteAddressLabel({ customDomain: null }, BRAND)).toBe(NO_DOMAIN_LABEL)
  })

  it('recognises platform hostnames without over-matching', () => {
    expect(isPlatformHostname('apsamo.com', BRAND)).toBe(true)
    expect(isPlatformHostname('shop.apsamo.com.', BRAND)).toBe(true)
    expect(isPlatformHostname('myapsamo.com', BRAND)).toBe(false)
    expect(isPlatformHostname('apsamo.com.evil.net', BRAND)).toBe(false)
  })

  it('hides stored URLs that point at a retired platform address', () => {
    expect(publicUrlOrNull('https://shop-1a2b.apsamo.com', BRAND)).toBeNull()
    expect(publicUrlOrNull('https://example.org/path', BRAND)).toBe('https://example.org/path')
    expect(publicUrlOrNull(null, BRAND)).toBeNull()
  })
})

describe('retired site DNS records', () => {
  const env = { APP_URL: 'https://panel.apsamo.com' }
  const protectedNames = protectedPlatformNames(BRAND, env)
  const zone = [
    // platform records that must survive
    { name: 'apsamo.com', type: 'A' },
    { name: 'apsamo.com', type: 'MX' },
    { name: 'apsamo.com', type: 'TXT' },
    { name: 'www.apsamo.com', type: 'CNAME' },
    { name: 'panel.apsamo.com', type: 'A' },
    { name: 'mail.apsamo.com', type: 'A' },
    { name: 'ns1.apsamo.com', type: 'A' },
    { name: 'ns2.apsamo.com', type: 'A' },
    { name: 'autodiscover.apsamo.com', type: 'CNAME' },
    { name: 'autoconfig.apsamo.com', type: 'CNAME' },
    { name: '_dmarc.apsamo.com', type: 'TXT' },
    { name: 'dkim._domainkey.apsamo.com', type: 'TXT' },
    { name: 'connect.apsamo.com', type: 'A' },
    { name: '*.apsamo.com', type: 'A' },
    // retired site addresses
    { name: 'sunrise-bakery-1a2b.apsamo.com.', type: 'A' },
    { name: 'sunrise-bakery-1a2b.apsamo.com', type: 'AAAA' },
    { name: 'www.sunrise-bakery-1a2b.apsamo.com', type: 'CNAME' },
    // a TXT on a site name is not an address record: kept
    { name: 'sunrise-bakery-1a2b.apsamo.com', type: 'TXT' },
    // a name that only resembles a project subdomain: kept
    { name: 'sunrise-bakery-1a2b-old.apsamo.com', type: 'A' },
    // another tenant's custom domain: never in the platform zone, but kept anyway
    { name: 'shop.example.com', type: 'A' },
  ]

  it('deletes only exact project-subdomain address records', () => {
    const removed = selectRetiredSiteRecords({
      records: zone,
      projectSubdomains: [
        'sunrise-bakery-1a2b.apsamo.com',
        // internal values that must never cause a platform record to go
        'panel.apsamo.com',
        'mail.apsamo.com',
        'ns1.apsamo.com',
        'www.apsamo.com',
        'apsamo.com',
        'connect.apsamo.com',
        '_dmarc.apsamo.com',
        '*.apsamo.com',
        'deep.label.apsamo.com',
        'shop.example.com',
        null,
      ],
      brand: BRAND,
      protectedNames,
    })
    expect(removed.map((r) => `${r.type} ${r.name}`).sort()).toEqual([
      'A sunrise-bakery-1a2b.apsamo.com',
      'AAAA sunrise-bakery-1a2b.apsamo.com',
      'CNAME www.sunrise-bakery-1a2b.apsamo.com',
    ])
    expect(removed.every((r) => r.projectSubdomain === 'sunrise-bakery-1a2b.apsamo.com')).toBe(true)
  })

  it('deletes nothing when no project subdomain matches', () => {
    expect(selectRetiredSiteRecords({ records: zone, projectSubdomains: [], brand: BRAND, protectedNames })).toEqual([])
    expect(selectRetiredSiteRecords({ records: zone, projectSubdomains: ['x.apsamo.com'], brand: '', protectedNames })).toEqual([])
  })

  it('protects the panel host from APP_URL even under a custom label', () => {
    const names = protectedPlatformNames(BRAND, { APP_URL: 'https://cp.apsamo.com' })
    expect(names.has('cp.apsamo.com')).toBe(true)
    const removed = selectRetiredSiteRecords({
      records: [{ name: 'cp.apsamo.com', type: 'A' }],
      projectSubdomains: ['cp.apsamo.com'],
      brand: BRAND,
      protectedNames: names,
    })
    expect(removed).toEqual([])
  })
})
