/**
 * tests/unit/registrar-safety.test.ts
 *
 * Registrar calls spend real money, so these pin the rules that keep them
 * honest. Every Dynadot answer here is a fake `fetch`; nothing touches the
 * network.
 *
 *   - production with no key: every call fails with "not configured"; search
 *     never invents availability and register/renew/transfer never "succeed"
 *   - purchase commands are never retried; an ambiguous failure (network,
 *     timeout, 5xx, unparsable body) is an UNKNOWN outcome, not a failure
 *   - purchase answers are parsed from RegisterResponse/RenewResponse/
 *     TransferResponse OR Response; an unrecognised shape is unknown
 *   - search maps every domain to available/unavailable/premium/unknown
 *   - epoch-millisecond expiries parse to real dates
 */
import { describe, it, expect, spyOn, afterEach, beforeEach } from 'bun:test'
import {
  parsePurchaseResponse,
  parseRegistrarDate,
  isPurchaseCommand,
  RegistrarNotConfiguredError,
  RegistrarUnknownOutcomeError,
  registerDomain,
  renewDomain,
} from '@/lib/dynadot'
import { dynadotService } from '@/lib/dynadot-service'

const KEY = 'UnitTestDynadotKey0123456789'

type Reply = Response | Error | (() => Response | Promise<Response>)

/** Replace fetch with a scripted sequence of replies; records every call. */
function fakeFetch(...replies: Reply[]) {
  const calls: URL[] = []
  let i = 0
  const spy = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    calls.push(new URL(String(input)))
    const r = replies[Math.min(i++, replies.length - 1)]
    if (r instanceof Error) throw r
    return typeof r === 'function' ? r() : r.clone()
  }) as typeof fetch)
  return { calls, restore: () => spy.mockRestore() }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const savedEnv = { NODE_ENV: process.env.NODE_ENV, KEY: process.env.DYNADOT_API_KEY }
let restoreFetch: (() => void) | null = null

function setEnv(nodeEnv: string, key: string | undefined) {
  ;(process.env as Record<string, string | undefined>).NODE_ENV = nodeEnv
  if (key === undefined) delete process.env.DYNADOT_API_KEY
  else process.env.DYNADOT_API_KEY = key
}

beforeEach(() => setEnv('test', KEY))
afterEach(() => {
  restoreFetch?.()
  restoreFetch = null
  ;(process.env as Record<string, string | undefined>).NODE_ENV = savedEnv.NODE_ENV
  if (savedEnv.KEY === undefined) delete process.env.DYNADOT_API_KEY
  else process.env.DYNADOT_API_KEY = savedEnv.KEY
})

// ─── F1: production guard ────────────────────────────────────────────────────

describe('production with no registrar key', () => {
  beforeEach(() => setEnv('production', undefined))

  it('is not demo mode', () => {
    expect(dynadotService.demoMode).toBe(false)
    expect(dynadotService.configured).toBe(false)
  })

  it('search throws "not configured" and never reports a domain available', async () => {
    const f = fakeFetch(json({}))
    restoreFetch = f.restore
    await expect(dynadotService.search('anything-free.com')).rejects.toBeInstanceOf(RegistrarNotConfiguredError)
    await expect(dynadotService.bulkSearch(['a.com', 'b.net'])).rejects.toBeInstanceOf(RegistrarNotConfiguredError)
    expect(f.calls.length).toBe(0)
  })

  it('register / renew / transfer throw instead of faking success', async () => {
    const f = fakeFetch(json({}))
    restoreFetch = f.restore
    await expect(dynadotService.register('x.com', 1)).rejects.toBeInstanceOf(RegistrarNotConfiguredError)
    await expect(dynadotService.renew('x.com', 1)).rejects.toBeInstanceOf(RegistrarNotConfiguredError)
    await expect(dynadotService.transfer('x.com', 'EPP')).rejects.toBeInstanceOf(RegistrarNotConfiguredError)
    await expect(dynadotService.getDomainInfo('x.com')).rejects.toBeInstanceOf(RegistrarNotConfiguredError)
    await expect(registerDomain('x.com', 1)).rejects.toBeInstanceOf(RegistrarNotConfiguredError)
    expect(f.calls.length).toBe(0)
  })

  it('outside production with no key, demo data is still allowed', async () => {
    setEnv('development', undefined)
    expect(dynadotService.demoMode).toBe(true)
    const r = await dynadotService.search('taken-example.com')
    expect(r.status).toBe('unavailable')
  })
})

// ─── F3: no retries for purchases, unknown outcome on ambiguity ──────────────

describe('purchase commands are never retried', () => {
  it('classifies the money-spending commands', () => {
    for (const c of ['register', 'renew', 'transfer', 'bulk_register', 'restore']) {
      expect(isPurchaseCommand(c)).toBe(true)
    }
    for (const c of ['search', 'domain_info', 'set_ns', 'get_dns', undefined]) {
      expect(isPurchaseCommand(c)).toBe(false)
    }
  })

  it('network error / timeout on register → unknown outcome, one request only', async () => {
    const f = fakeFetch(new TypeError('fetch failed'), json({ RegisterResponse: { Status: 'success' } }))
    restoreFetch = f.restore
    await expect(dynadotService.register('buy-once.com', 1)).rejects.toBeInstanceOf(RegistrarUnknownOutcomeError)
    expect(f.calls.length).toBe(1)
  })

  it('timeout (AbortError) on renew → unknown outcome, one request only', async () => {
    const f = fakeFetch(() => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    })
    restoreFetch = f.restore
    await expect(dynadotService.renew('buy-once.com', 1)).rejects.toBeInstanceOf(RegistrarUnknownOutcomeError)
    expect(f.calls.length).toBe(1)
  })

  it('HTTP 5xx on transfer → unknown outcome, one request only', async () => {
    const f = fakeFetch(new Response('upstream down', { status: 502 }))
    restoreFetch = f.restore
    await expect(dynadotService.transfer('buy-once.com', 'EPP')).rejects.toBeInstanceOf(RegistrarUnknownOutcomeError)
    expect(f.calls.length).toBe(1)
  })

  it('unparsable body on register → unknown outcome, one request only', async () => {
    const f = fakeFetch(new Response('<html>oops</html>', { status: 200 }))
    restoreFetch = f.restore
    await expect(dynadotService.register('buy-once.com', 1)).rejects.toBeInstanceOf(RegistrarUnknownOutcomeError)
    expect(f.calls.length).toBe(1)
  })

  it('429 on register is a definite refusal (not bought), still not retried', async () => {
    const f = fakeFetch(new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }))
    restoreFetch = f.restore
    const r = await dynadotService.register('buy-once.com', 1)
    expect(r.success).toBe(false)
    expect(f.calls.length).toBe(1)
  })

  it('the legacy lib/dynadot client also reports unknown outcome and does not retry', async () => {
    const f = fakeFetch(new Response('bad gateway', { status: 503 }))
    restoreFetch = f.restore
    await expect(renewDomain('buy-once.com', 1)).rejects.toBeInstanceOf(RegistrarUnknownOutcomeError)
    expect(f.calls.length).toBe(1)
  })

  it('read-only commands are still retried on 5xx', async () => {
    const f = fakeFetch(
      new Response('busy', { status: 503 }),
      json({ SearchResponse: { ResponseCode: 0, SearchResults: [{ DomainName: 'r.com', Available: 'no' }] } })
    )
    restoreFetch = f.restore
    const r = await dynadotService.search('r.com')
    expect(r.status).toBe('unavailable')
    expect(f.calls.length).toBe(2)
  })
})

// ─── F4: purchase response parsing ───────────────────────────────────────────

describe('parsePurchaseResponse', () => {
  it('accepts the command-specific wrapper', () => {
    expect(parsePurchaseResponse('register', { RegisterResponse: { ResponseCode: 0, Status: 'success', DomainName: 'a.com' } }).outcome).toBe('success')
    expect(parsePurchaseResponse('renew', { RenewResponse: { ResponseCode: '0', Status: 'success', Expiration: 1767225600000 } })).toEqual({
      outcome: 'success',
      orderId: undefined,
      price: undefined,
      expiration: new Date(1767225600000).toISOString(),
    })
    expect(parsePurchaseResponse('transfer', { TransferResponse: { ResponseCode: 0, Status: 'order created', OrderId: 77 } })).toMatchObject({
      outcome: 'success',
      orderId: '77',
    })
  })

  it('accepts the generic Response wrapper', () => {
    expect(parsePurchaseResponse('register', { Response: { Status: 'register success', OrderId: 'o1' } })).toMatchObject({ outcome: 'success', orderId: 'o1' })
  })

  it('detects errors in either wrapper', () => {
    expect(parsePurchaseResponse('register', { RegisterResponse: { ResponseCode: -1, Status: 'error', Error: 'not available' } })).toEqual({ outcome: 'failed', error: 'not available' })
    expect(parsePurchaseResponse('renew', { Response: { ResponseCode: '-1', Error: 'insufficient funds' } })).toEqual({ outcome: 'failed', error: 'insufficient funds' })
    expect(parsePurchaseResponse('transfer', { TransferResponse: { Status: 'failed', Error: 'bad auth code' } })).toEqual({ outcome: 'failed', error: 'bad auth code' })
    expect(parsePurchaseResponse('register', { RegisterResponse: { Status: 'success', Error: 'partial failure' } }).outcome).toBe('failed')
  })

  it('treats an unrecognised shape as unknown — never success, never failure', () => {
    expect(parsePurchaseResponse('register', {}).outcome).toBe('unknown')
    expect(parsePurchaseResponse('register', { SomethingElse: { Status: 'success' } }).outcome).toBe('unknown')
    expect(parsePurchaseResponse('renew', { RenewResponse: { ResponseCode: 0 } }).outcome).toBe('unknown')
    expect(parsePurchaseResponse('transfer', { TransferResponse: { Status: 'queued?' } }).outcome).toBe('unknown')
    expect(parsePurchaseResponse('register', null).outcome).toBe('unknown')
  })

  it('register() maps the three outcomes end to end', async () => {
    let f = fakeFetch(json({ RegisterResponse: { ResponseCode: 0, Status: 'success', OrderId: 'R1' } }))
    restoreFetch = f.restore
    expect(await dynadotService.register('ok.com', 1)).toMatchObject({ success: true, orderId: 'R1' })
    f.restore()

    f = fakeFetch(json({ RegisterResponse: { ResponseCode: -1, Status: 'error', Error: 'taken' } }))
    restoreFetch = f.restore
    expect(await dynadotService.register('no.com', 1)).toMatchObject({ success: false })
    expect(f.calls.length).toBe(1)
    f.restore()

    f = fakeFetch(json({ Weird: true }))
    restoreFetch = f.restore
    await expect(dynadotService.register('huh.com', 1)).rejects.toBeInstanceOf(RegistrarUnknownOutcomeError)
  })
})

// ─── F5: search status mapping ───────────────────────────────────────────────

describe('search status', () => {
  it('maps available / unavailable / premium and treats a missing domain as unknown', async () => {
    const f = fakeFetch(json({
      SearchResponse: {
        ResponseCode: 0,
        SearchResults: [
          { DomainName: 'free.com', Available: 'yes', Price: 'Registration Price: 10.88 in USD and Renewal price: 10.88 in USD and Domain is not a Premium Domain' },
          { DomainName: 'gold.com', Available: 'yes', Price: 'Registration Price: 2500.00 in USD and Renewal price: 10.88 in USD and Domain is a Premium Domain' },
          { DomainName: 'taken.com', Available: 'no' },
          { DomainName: 'weird.com', Status: 'error', Error: 'lookup failed' },
        ],
      },
    }))
    restoreFetch = f.restore
    const r = await dynadotService.bulkSearch(['free.com', 'gold.com', 'taken.com', 'weird.com', 'missing.com'])
    expect(r.map((x) => [x.domain, x.status])).toEqual([
      ['free.com', 'available'],
      ['gold.com', 'premium'],
      ['taken.com', 'unavailable'],
      ['weird.com', 'unknown'],
      ['missing.com', 'unknown'],
    ])
    expect(r.find((x) => x.domain === 'missing.com')!.available).toBe(false)
  })

  it('a registrar error rejects (callers map it to unknown) — never "available"', async () => {
    const f = fakeFetch(json({ SearchResponse: { ResponseCode: -1, Status: 'error', Error: 'invalid characters in domain' } }))
    restoreFetch = f.restore
    await expect(dynadotService.search('bad.com')).rejects.toThrow()
  })
})

// ─── F9: registrar dates ─────────────────────────────────────────────────────

describe('parseRegistrarDate', () => {
  it('parses epoch milliseconds given as a string (new Date("…") would be Invalid Date)', () => {
    expect(parseRegistrarDate('1767225600000')?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(parseRegistrarDate(1767225600000)?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(parseRegistrarDate('1767225600')?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(parseRegistrarDate('2027-03-04T00:00:00.000Z')?.toISOString()).toBe('2027-03-04T00:00:00.000Z')
  })

  it('returns null for missing or garbage values', () => {
    expect(parseRegistrarDate(undefined)).toBeNull()
    expect(parseRegistrarDate('')).toBeNull()
    expect(parseRegistrarDate('not a date')).toBeNull()
  })

  it('getDomainInfo reads the epoch expiry', async () => {
    const f = fakeFetch(() => json({ DomainInfoResponse: { ResponseCode: 0, DomainInfo: { Expiration: '1767225600000', Status: 'active' } } }))
    restoreFetch = f.restore
    const info = await dynadotService.getDomainInfo('e.com')
    expect(info.expiry).toBe('2026-01-01T00:00:00.000Z')
  })
})
