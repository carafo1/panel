/**
 * tests/unit/dynadot-dns.test.ts
 * ════════════════════════════════════════════════════════════════════════════
 * Dynadot `set_dns2` replaces the WHOLE zone unless add_dns_to_current_setting=1
 * is sent. The old client never sent it, dropped record names, and pushed
 * `A @ 127.0.0.1` when the last record was deleted — wiping customer zones.
 *
 * These tests pin the pure parameter builder / zone merger / refusal rules and
 * drive the add/delete/update flows against a fake Dynadot caller. Nothing here
 * touches the network.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'

import {
  buildSetDns2Params,
  parseGetDnsZone,
  toDynadotRecord,
  normaliseRecordName,
  removeRecordFromZone,
  replaceRecordInZone,
  recordsMissingFromZone,
  isProtectedDnsDomain,
  assertDnsWriteAllowed,
  isSetDnsSuccess,
  addDnsRecordsVia,
  deleteDnsRecordVia,
  updateDnsRecordVia,
  DnsWriteRefusedError,
  dnsRefusalStatus,
  DYNADOT_MAX_MAIN_RECORDS,
  type DynadotDnsRecord,
  type DynadotCall,
} from '../../src/lib/dynadot'

const DOMAIN = 'customer-example.com'

function getDnsJson(
  main: Array<{ RecordType: string; Value: string; Value2?: string }>,
  sub: Array<{ Subhost: string; RecordType: string; Value: string; Value2?: string }>,
  extra: Record<string, unknown> = {}
) {
  return {
    GetDnsResponse: {
      ResponseCode: 0,
      Status: 'success',
      GetDns: {
        NameServerSettings: { Type: 'Dynadot DNS', MainDomains: main, SubDomains: sub, ...extra },
      },
    },
  }
}

/** Fake Dynadot: answers get_dns from `zoneJson`, records every set_dns2. */
function fakeDynadot(zoneJson: Record<string, unknown> | Error, setStatus = 'success') {
  const calls: Array<Record<string, string>> = []
  const call: DynadotCall = async (params) => {
    calls.push(params)
    if (params.command === 'get_dns') {
      if (zoneJson instanceof Error) throw zoneJson
      return zoneJson
    }
    if (params.command === 'set_dns2') {
      return { SetDnsResponse: { ResponseCode: 0, Status: setStatus } }
    }
    throw new Error(`unexpected command ${params.command}`)
  }
  const sets = () => calls.filter((c) => c.command === 'set_dns2')
  return { call, calls, sets }
}

function allValues(params: Record<string, string>): string[] {
  return Object.values(params)
}

const ENV_KEYS = ['BRAND_DOMAIN', 'APP_URL', 'PANEL_DOMAIN', 'NEXT_PUBLIC_APP_URL'] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.BRAND_DOMAIN = 'apsamo.com'
  process.env.APP_URL = 'https://panel.apsamo.com'
  delete process.env.PANEL_DOMAIN
  delete process.env.NEXT_PUBLIC_APP_URL
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe('normaliseRecordName', () => {
  it('maps apex spellings to @ and FQDNs to relative names', () => {
    expect(normaliseRecordName('@', DOMAIN)).toBe('@')
    expect(normaliseRecordName('', DOMAIN)).toBe('@')
    expect(normaliseRecordName(DOMAIN, DOMAIN)).toBe('@')
    expect(normaliseRecordName(`${DOMAIN}.`, DOMAIN)).toBe('@')
    expect(normaliseRecordName('WWW', DOMAIN)).toBe('www')
    expect(normaliseRecordName(`mail._domainkey.${DOMAIN}`, DOMAIN)).toBe('mail._domainkey')
  })
})

describe('buildSetDns2Params', () => {
  it('puts apex records in main_* and subdomain records in sub_* with their names', () => {
    const records = [
      toDynadotRecord({ type: 'A', name: '@', value: '203.0.113.10' }, DOMAIN),
      toDynadotRecord({ type: 'MX', name: '@', value: 'mail.apsamo.com', priority: 10 }, DOMAIN),
      toDynadotRecord({ type: 'A', name: 'www', value: '203.0.113.10' }, DOMAIN),
      toDynadotRecord({ type: 'TXT', name: '_dmarc', value: 'v=DMARC1; p=none' }, DOMAIN),
    ]
    const p = buildSetDns2Params(DOMAIN, records, { append: false })
    expect(p.command).toBe('set_dns2')
    expect(p.domain).toBe(DOMAIN)
    expect(p.main_record_type0).toBe('a')
    expect(p.main_record0).toBe('203.0.113.10')
    expect(p.main_record_type1).toBe('mx')
    expect(p.main_record1).toBe('mail.apsamo.com')
    expect(p.main_recordx1).toBe('10')
    expect(p.subdomain0).toBe('www')
    expect(p.sub_record_type0).toBe('a')
    expect(p.sub_record0).toBe('203.0.113.10')
    expect(p.subdomain1).toBe('_dmarc')
    expect(p.sub_record_type1).toBe('txt')
    expect(p.sub_record1).toBe('v=DMARC1; p=none')
    // Full rewrite: no append flag.
    expect(p.add_dns_to_current_setting).toBeUndefined()
    // The non-existent parameter the old service sent must be gone.
    expect(Object.keys(p).some((k) => k.startsWith('main_record_name'))).toBe(false)
  })

  it('sets add_dns_to_current_setting=1 for appends', () => {
    const p = buildSetDns2Params(
      DOMAIN,
      [toDynadotRecord({ type: 'A', name: 'api', value: '203.0.113.11' }, DOMAIN)],
      { append: true }
    )
    expect(p.add_dns_to_current_setting).toBe('1')
    expect(p.subdomain0).toBe('api')
    expect(p.main_record0).toBeUndefined()
  })

  it('refuses an empty record set instead of inventing a placeholder', () => {
    for (const append of [true, false]) {
      let err: unknown
      try {
        buildSetDns2Params(DOMAIN, [], { append })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(DnsWriteRefusedError)
      expect((err as DnsWriteRefusedError).code).toBe('empty_zone')
    }
  })

  it('refuses more apex records than Dynadot holds rather than truncating', () => {
    const many: DynadotDnsRecord[] = Array.from({ length: DYNADOT_MAX_MAIN_RECORDS + 1 }, (_, i) => ({
      name: '@',
      type: 'txt',
      value: `v=${i}`,
    }))
    expect(() => buildSetDns2Params(DOMAIN, many, { append: false })).toThrow(DnsWriteRefusedError)
  })

  it('rejects types Dynadot cannot store at that position', () => {
    expect(() => toDynadotRecord({ type: 'SRV', name: '@', value: '0 5 5060 sip.example.com' }, DOMAIN)).toThrow(
      DnsWriteRefusedError
    )
    expect(() => toDynadotRecord({ type: 'CAA', name: 'www', value: '0 issue "x"' }, DOMAIN)).toThrow(
      DnsWriteRefusedError
    )
    // SRV is fine on a subdomain.
    expect(toDynadotRecord({ type: 'SRV', name: '_sip._tcp', value: '5 5060 sip.example.com', priority: 0 }, DOMAIN).type).toBe('srv')
  })
})

describe('parseGetDnsZone', () => {
  it('reads apex and subdomain records with their extra values', () => {
    const zone = parseGetDnsZone(
      getDnsJson(
        [
          { RecordType: 'A', Value: '203.0.113.10' },
          { RecordType: 'MX', Value: 'mx.other-provider.net', Value2: '5' },
        ],
        [{ Subhost: 'Blog', RecordType: 'CNAME', Value: 'blogs.example.net' }],
        { TTL: '300' }
      )
    )
    expect(zone.records).toEqual([
      { name: '@', type: 'a', value: '203.0.113.10' },
      { name: '@', type: 'mx', value: 'mx.other-provider.net', valueX: '5' },
      { name: 'blog', type: 'cname', value: 'blogs.example.net' },
    ])
    expect(zone.ttl).toBe('300')
  })

  it('treats a zone with no records as empty, not as an error', () => {
    expect(parseGetDnsZone(getDnsJson([], [])).records).toEqual([])
  })

  it('refuses a response it cannot fully account for', () => {
    expect(() => parseGetDnsZone({})).toThrow(DnsWriteRefusedError)
    expect(() =>
      parseGetDnsZone(getDnsJson([{ RecordType: 'A', Value: '' }], []))
    ).toThrow(DnsWriteRefusedError)
    expect(() =>
      parseGetDnsZone(getDnsJson([], [{ Subhost: '', RecordType: 'A', Value: '1.2.3.4' }]))
    ).toThrow(DnsWriteRefusedError)
  })
})

describe('zone merge helpers', () => {
  const zone: DynadotDnsRecord[] = [
    { name: '@', type: 'a', value: '203.0.113.10' },
    { name: 'www', type: 'cname', value: DOMAIN },
    { name: 'shop', type: 'a', value: '198.51.100.7' }, // not known to the panel
  ]

  it('removes only the targeted record and keeps unrelated ones', () => {
    const { records, removed } = removeRecordFromZone(zone, { name: 'www', type: 'cname', value: `${DOMAIN}.` })
    expect(removed).toBe(1)
    expect(records).toEqual([zone[0], zone[2]])
  })

  it('replaces a record in place', () => {
    const out = replaceRecordInZone(zone, zone[0], { name: '@', type: 'a', value: '203.0.113.99' })
    expect(out).toEqual([{ name: '@', type: 'a', value: '203.0.113.99' }, zone[1], zone[2]])
  })

  it('replace of a missing record is refused', () => {
    expect(() => replaceRecordInZone(zone, { name: 'nope', type: 'a', value: '1.1.1.1' }, zone[0])).toThrow(
      DnsWriteRefusedError
    )
  })

  it('reports only records the zone does not already have', () => {
    const missing = recordsMissingFromZone(zone, [
      { name: '@', type: 'a', value: '203.0.113.10' },
      { name: 'api', type: 'a', value: '203.0.113.11' },
      { name: 'api', type: 'a', value: '203.0.113.11' },
    ])
    expect(missing).toEqual([{ name: 'api', type: 'a', value: '203.0.113.11' }])
  })
})

describe('brand / panel domain refusal', () => {
  it('protects the brand apex, the panel host, and names inside them', () => {
    expect(isProtectedDnsDomain('apsamo.com')).toBe(true)
    expect(isProtectedDnsDomain('APSAMO.COM.')).toBe(true)
    expect(isProtectedDnsDomain('panel.apsamo.com')).toBe(true)
    expect(isProtectedDnsDomain('mail.apsamo.com')).toBe(true)
    expect(isProtectedDnsDomain(DOMAIN)).toBe(false)
    expect(isProtectedDnsDomain('notapsamo.com')).toBe(false)
  })

  it('protects the zone that holds PANEL_DOMAIN / APP_URL even on another brand', () => {
    const env = { BRAND_DOMAIN: 'brand.test', PANEL_DOMAIN: 'cp.hosting-co.net', APP_URL: 'https://admin.other.org/x' }
    expect(isProtectedDnsDomain('hosting-co.net', env)).toBe(true)
    expect(isProtectedDnsDomain('other.org', env)).toBe(true)
    expect(isProtectedDnsDomain('brand.test', env)).toBe(true)
    expect(isProtectedDnsDomain('customer.org', env)).toBe(false)
  })

  it('throws a protected_domain refusal that maps to 403', () => {
    let err: unknown
    try {
      assertDnsWriteAllowed('apsamo.com')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DnsWriteRefusedError)
    expect((err as DnsWriteRefusedError).code).toBe('protected_domain')
    expect(dnsRefusalStatus('protected_domain')).toBe(403)
  })
})

describe('isSetDnsSuccess', () => {
  it('requires Status success in the set_dns2 envelope', () => {
    expect(isSetDnsSuccess({ SetDnsResponse: { ResponseCode: 0, Status: 'success' } })).toBe(true)
    expect(isSetDnsSuccess({ SetDnsResponse: { ResponseCode: -1, Status: 'error' } })).toBe(false)
    expect(isSetDnsSuccess({})).toBe(false)
    expect(isSetDnsSuccess(null)).toBe(false)
  })
})

// ─── Flows against a fake Dynadot ───────────────────────────────────────────

describe('addDnsRecordsVia', () => {
  it('appends only the new records with add_dns_to_current_setting=1', async () => {
    const fake = fakeDynadot(
      getDnsJson([{ RecordType: 'A', Value: '203.0.113.10' }], [{ Subhost: 'shop', RecordType: 'A', Value: '198.51.100.7' }])
    )
    const res = await addDnsRecordsVia(fake.call, DOMAIN, [
      { type: 'A', name: '@', value: '203.0.113.10' }, // already present
      { type: 'CNAME', name: 'www', value: DOMAIN },
    ])
    expect(res.success).toBe(true)
    expect(res.written).toBe(1)
    expect(res.skipped).toBe(1)
    const [set] = fake.sets()
    expect(set.add_dns_to_current_setting).toBe('1')
    expect(set.subdomain0).toBe('www')
    expect(set.sub_record_type0).toBe('cname')
    // Nothing unrelated was sent.
    expect(set.main_record0).toBeUndefined()
    expect(allValues(set)).not.toContain('198.51.100.7')
  })

  it('still appends (never replaces) when the zone cannot be read', async () => {
    const fake = fakeDynadot(new Error('network'))
    const res = await addDnsRecordsVia(fake.call, DOMAIN, [{ type: 'A', name: '@', value: '203.0.113.10' }])
    expect(res.success).toBe(true)
    expect(fake.sets()[0].add_dns_to_current_setting).toBe('1')
  })

  it('writes nothing when every record is already live', async () => {
    const fake = fakeDynadot(getDnsJson([{ RecordType: 'A', Value: '203.0.113.10' }], []))
    const res = await addDnsRecordsVia(fake.call, DOMAIN, [{ type: 'A', name: '@', value: '203.0.113.10' }])
    expect(res).toEqual({ success: true, written: 0, skipped: 1 })
    expect(fake.sets()).toHaveLength(0)
  })

  it('reports failure when Dynadot does not answer success', async () => {
    const fake = fakeDynadot(getDnsJson([], []), 'error')
    const res = await addDnsRecordsVia(fake.call, DOMAIN, [{ type: 'A', name: '@', value: '203.0.113.10' }])
    expect(res.success).toBe(false)
  })

  it('refuses the brand domain without calling Dynadot', async () => {
    const fake = fakeDynadot(getDnsJson([], []))
    await expect(addDnsRecordsVia(fake.call, 'apsamo.com', [{ type: 'A', name: '@', value: '1.2.3.4' }])).rejects.toThrow(
      DnsWriteRefusedError
    )
    expect(fake.calls).toHaveLength(0)
  })
})

describe('deleteDnsRecordVia', () => {
  it('writes back the FULL remaining zone, including records the panel never created', async () => {
    const fake = fakeDynadot(
      getDnsJson(
        [
          { RecordType: 'A', Value: '203.0.113.10' },
          { RecordType: 'MX', Value: 'mx.other-provider.net', Value2: '5' },
        ],
        [
          { Subhost: 'www', RecordType: 'CNAME', Value: DOMAIN },
          { Subhost: 'shop', RecordType: 'A', Value: '198.51.100.7' },
        ],
        { TTL: '300' }
      )
    )
    const res = await deleteDnsRecordVia(fake.call, DOMAIN, { type: 'CNAME', name: 'www', value: DOMAIN })
    expect(res.success).toBe(true)
    expect(res.written).toBe(3)
    const [set] = fake.sets()
    expect(set.add_dns_to_current_setting).toBeUndefined()
    expect(set.main_record_type0).toBe('a')
    expect(set.main_record0).toBe('203.0.113.10')
    expect(set.main_record_type1).toBe('mx')
    expect(set.main_recordx1).toBe('5')
    expect(set.subdomain0).toBe('shop')
    expect(set.sub_record0).toBe('198.51.100.7')
    expect(set.subdomain1).toBeUndefined()
    expect(set.ttl).toBe('300')
    expect(allValues(set)).not.toContain('127.0.0.1')
  })

  it('deleting the last record never sends 127.0.0.1 and never sends an empty set', async () => {
    const fake = fakeDynadot(getDnsJson([{ RecordType: 'A', Value: '203.0.113.10' }], []))
    let err: unknown
    try {
      await deleteDnsRecordVia(fake.call, DOMAIN, { type: 'A', name: '@', value: '203.0.113.10' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DnsWriteRefusedError)
    expect((err as DnsWriteRefusedError).code).toBe('empty_zone')
    expect(fake.sets()).toHaveLength(0)
    for (const c of fake.calls) expect(allValues(c)).not.toContain('127.0.0.1')
  })

  it('a record that is not live is reported, and nothing is written', async () => {
    const fake = fakeDynadot(getDnsJson([{ RecordType: 'A', Value: '203.0.113.10' }], []))
    const res = await deleteDnsRecordVia(fake.call, DOMAIN, { type: 'A', name: 'gone', value: '1.1.1.1' })
    expect(res.notFound).toBe(true)
    expect(fake.sets()).toHaveLength(0)
  })

  it('an unreadable zone stops the delete', async () => {
    const fake = fakeDynadot({ GetDnsResponse: { Status: 'success' } })
    await expect(
      deleteDnsRecordVia(fake.call, DOMAIN, { type: 'A', name: '@', value: '203.0.113.10' })
    ).rejects.toThrow(DnsWriteRefusedError)
    expect(fake.sets()).toHaveLength(0)
  })

  it('refuses the panel zone', async () => {
    const fake = fakeDynadot(getDnsJson([{ RecordType: 'A', Value: '1.2.3.4' }], []))
    await expect(
      deleteDnsRecordVia(fake.call, 'apsamo.com', { type: 'A', name: '@', value: '1.2.3.4' })
    ).rejects.toThrow(DnsWriteRefusedError)
    expect(fake.calls).toHaveLength(0)
  })
})

describe('updateDnsRecordVia', () => {
  it('replaces only the targeted record and keeps the rest', async () => {
    const fake = fakeDynadot(
      getDnsJson(
        [{ RecordType: 'A', Value: '203.0.113.10' }],
        [{ Subhost: 'shop', RecordType: 'A', Value: '198.51.100.7' }]
      )
    )
    const res = await updateDnsRecordVia(
      fake.call,
      DOMAIN,
      { type: 'A', name: '@', value: '203.0.113.10' },
      { type: 'A', name: '@', value: '203.0.113.99' }
    )
    expect(res.success).toBe(true)
    const [set] = fake.sets()
    expect(set.main_record0).toBe('203.0.113.99')
    expect(set.subdomain0).toBe('shop')
    expect(set.add_dns_to_current_setting).toBeUndefined()
  })
})
