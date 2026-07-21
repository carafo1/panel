/**
 * tests/unit/regressions.test.ts
 * ════════════════════════════════════════════════════════════════════════════
 * One test per bug that actually reached production.
 *
 * Every case below shipped, ran silently, and was found by hand rather than by
 * anything automated. Each test is named after the failure it prevents, so a
 * regression tells you what broke rather than just that something did.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'

process.env.JWT_SECRET = 'test-secret-not-for-production-use-32chars-min'
process.env.ENCRYPTION_KEY =
  '0000000000000000000000000000000000000000000000000000000000000000'

import {
  getSubscriptionPeriod,
  getInvoiceSubscriptionId,
  getInvoiceChargeId,
} from '../../src/lib/stripe'
import { renderInvoicePdf } from '../../src/lib/pdf'

/* ────────────────────────────────────────────────────────────────────
 * Stripe moved fields between API versions
 *
 * BUG: `subscription.current_period_end` and `invoice.subscription` were read
 * directly. Newer Stripe versions moved them onto the subscription ITEM and
 * under `invoice.parent`, so both silently read `undefined` — subscriptions
 * would be stored with no period, and invoice webhooks would attach to no
 * subscription at all.
 * ──────────────────────────────────────────────────────────────────── */
describe('stripe cross-version field access', () => {
  const START = 1_700_000_000
  const END = 1_702_592_000

  it('reads the period from the subscription item (current API shape)', () => {
    const sub = {
      items: { data: [{ current_period_start: START, current_period_end: END }] },
    }
    const { start, end } = getSubscriptionPeriod(sub as never)
    expect(start?.getTime()).toBe(START * 1000)
    expect(end?.getTime()).toBe(END * 1000)
  })

  it('falls back to the legacy top-level period fields', () => {
    const sub = { current_period_start: START, current_period_end: END }
    const { start, end } = getSubscriptionPeriod(sub as never)
    expect(start?.getTime()).toBe(START * 1000)
    expect(end?.getTime()).toBe(END * 1000)
  })

  it('returns undefined rather than an Invalid Date when absent', () => {
    const { start, end } = getSubscriptionPeriod({} as never)
    expect(start).toBeUndefined()
    expect(end).toBeUndefined()
  })

  it('prefers the item over a stale legacy value', () => {
    const sub = {
      current_period_start: 1,
      current_period_end: 2,
      items: { data: [{ current_period_start: START, current_period_end: END }] },
    }
    expect(getSubscriptionPeriod(sub as never).end?.getTime()).toBe(END * 1000)
  })

  it('finds the subscription id under invoice.parent (current shape)', () => {
    const invoice = {
      parent: { subscription_details: { subscription: 'sub_123' } },
    }
    expect(getInvoiceSubscriptionId(invoice as never)).toBe('sub_123')
  })

  it('falls back to the legacy invoice.subscription field', () => {
    expect(getInvoiceSubscriptionId({ subscription: 'sub_legacy' } as never)).toBe(
      'sub_legacy'
    )
  })

  it('unwraps an expanded subscription object', () => {
    const invoice = { subscription: { id: 'sub_expanded' } }
    expect(getInvoiceSubscriptionId(invoice as never)).toBe('sub_expanded')
  })

  it('returns null (not undefined) when there is no subscription', () => {
    expect(getInvoiceSubscriptionId({} as never)).toBeNull()
    expect(getInvoiceChargeId({} as never)).toBeNull()
  })
})

/* ────────────────────────────────────────────────────────────────────
 * Placeholder credentials counted as "configured"
 *
 * BUG: isWaafiConfigured() only checked that the env vars were non-empty. The
 * shipped .env contains `replace-with-your-merchant-id`, so the gateway
 * reported itself configured, skipped demo mode, and would fire live API
 * calls using the placeholder as a merchant id.
 * ──────────────────────────────────────────────────────────────────── */
describe('gateway credential validation', () => {
  const saved: Record<string, string | undefined> = {}
  const KEYS = [
    'WAAFI_API_URL',
    'WAAFI_MERCHANT_ID',
    'WAAFI_API_KEY',
    'WAAFI_API_USER_ID',
    'STRIPE_SECRET_KEY',
  ]

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k]
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('treats replace-with-* placeholders as NOT configured', async () => {
    process.env.WAAFI_API_URL = 'https://api.waafipay.net'
    process.env.WAAFI_MERCHANT_ID = 'replace-with-your-merchant-id'
    process.env.WAAFI_API_KEY = 'replace-with-your-api-key'
    process.env.WAAFI_API_USER_ID = 'replace-with-your-user-id'
    const { isWaafiConfigured } = await import('../../src/lib/waafi')
    expect(isWaafiConfigured()).toBe(false)
  })

  it('accepts genuine credentials', async () => {
    process.env.WAAFI_API_URL = 'https://api.waafipay.net'
    process.env.WAAFI_MERCHANT_ID = 'M0910291'
    process.env.WAAFI_API_KEY = 'API-1901290410AHX'
    process.env.WAAFI_API_USER_ID = '1000416'
    const { isWaafiConfigured } = await import('../../src/lib/waafi')
    expect(isWaafiConfigured()).toBe(true)
  })

  it('flags a Stripe TEST key as test mode, not live', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123456789'
    const { getGatewayStatus } = await import('../../src/lib/gateways')
    const g = getGatewayStatus('stripe')
    expect(g?.configured).toBe(true)
    // Usable, but must never be mistaken for able to take real money.
    expect(g?.mode).toBe('test')
  })

  it('reports a live Stripe key as live', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc123456789'
    const { getGatewayStatus } = await import('../../src/lib/gateways')
    expect(getGatewayStatus('stripe')?.mode).toBe('live')
  })

  it('never marks an unimplemented gateway usable', async () => {
    const { getAllGatewayStatuses } = await import('../../src/lib/gateways')
    for (const g of getAllGatewayStatuses()) {
      if (!g.implemented) expect(g.usable).toBe(false)
    }
  })
})

/* ────────────────────────────────────────────────────────────────────
 * Hand-built PDF byte offsets
 *
 * The invoice PDF is written without a library, so a malformed xref table
 * would produce a file that looks fine (right size, right header) but fails
 * to open — and nobody would notice until a customer downloaded one.
 * ──────────────────────────────────────────────────────────────────── */
describe('invoice PDF structure', () => {
  const invoice = {
    number: 'INV-2026-0001',
    status: 'paid',
    createdAt: new Date('2026-07-21T00:00:00Z'),
    dueDate: new Date('2026-07-28T00:00:00Z'),
    paidAt: new Date('2026-07-21T00:00:00Z'),
    currency: 'USD',
    subtotal: 79,
    discount: 0,
    tax: 0,
    creditApplied: 0,
    total: 79,
    amountPaid: 79,
    amountRefunded: 0,
    items: [
      { description: 'Business plan', quantity: 1, unitPrice: 79, total: 79 },
    ],
    customer: { name: 'Test Customer', email: 'test@example.com' },
    brand: { name: 'Apsamo', domain: 'apsamo.com', email: 'billing@apsamo.com' },
  }

  it('produces a parseable PDF whose xref offsets all resolve', () => {
    const bytes = renderInvoicePdf(invoice)
    const text = bytes.toString('latin1')

    expect(text.startsWith('%PDF-')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)

    // startxref must point at the real "xref" keyword.
    const m = text.match(/startxref\s+(\d+)/)
    expect(m).not.toBeNull()
    const startxref = Number(m![1])
    expect(text.slice(startxref, startxref + 4)).toBe('xref')

    // Every 10-digit offset in the table must land on an object header.
    const table = text.slice(startxref)
    const offsets = [...table.matchAll(/^(\d{10}) \d{5} n/gm)].map((x) =>
      Number(x[1])
    )
    expect(offsets.length).toBeGreaterThan(0)
    for (const off of offsets) {
      expect(text.slice(off).match(/^\d+ \d+ obj/)).not.toBeNull()
    }
  })

  it('escapes characters that would otherwise corrupt the content stream', () => {
    const tricky = {
      ...invoice,
      items: [
        {
          description: 'Plan (Pro) \\ "quoted" — 50% off',
          quantity: 1,
          unitPrice: 79,
          total: 79,
        },
      ],
    }
    const text = renderInvoicePdf(tricky).toString('latin1')
    expect(text.startsWith('%PDF-')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
  })
})
