/**
 * Payment gateway registry — capabilities and readiness.
 *
 * `payment-methods.ts` answers "how do I take a payment with X". This answers
 * the questions it can't: what is X *capable* of, and is it actually usable
 * right now? Without this the admin UI has no honest way to say "PayPal is
 * listed but no credentials are set", and refund/renewal code has no way to
 * know whether a gateway can be driven programmatically.
 *
 * IMPORTANT — this file describes reality, not intent. A gateway marked
 * `implemented: false` has NO working integration: listing it must never
 * imply a customer could pay with it. Activating one requires the merchant
 * account and credentials, which only the operator can supply.
 */
import { isWaafiConfigured } from '@/lib/waafi'
import { isStripeDemoMode } from '@/lib/stripe'

export type GatewayCapability =
  | 'redirect' // hosted checkout page
  | 'recurring' // gateway drives its own renewals
  | 'refund_api' // refunds can be issued programmatically
  | 'webhook' // sends asynchronous status callbacks
  | 'manual_capture' // operator confirms payment by hand

export interface GatewayDescriptor {
  id: string
  label: string
  /** Is there real integration code in this codebase? */
  implemented: boolean
  capabilities: GatewayCapability[]
  /** Currencies the integration is known to handle. Empty = operator-defined. */
  currencies: string[]
  /** Env vars that must be present for the gateway to function. */
  requiredEnv: string[]
  /** Extra note surfaced in the admin UI. */
  note?: string
}

/**
 * Every gateway the panel knows about. The three implemented ones are the
 * only ones that can take money today; the rest are declared so the admin
 * UI can show them as "integration required" instead of pretending.
 */
export const GATEWAYS: GatewayDescriptor[] = [
  {
    id: 'stripe',
    label: 'Credit / Debit Card (Stripe)',
    implemented: true,
    capabilities: ['redirect', 'recurring', 'refund_api', 'webhook'],
    currencies: ['USD', 'EUR', 'GBP'],
    requiredEnv: ['STRIPE_SECRET_KEY'],
    note: 'Stripe drives its own subscription lifecycle via webhooks — the billing sweep deliberately skips Stripe-managed subscriptions.',
  },
  {
    id: 'waafi',
    label: 'Waafi Pay',
    implemented: true,
    capabilities: ['redirect', 'webhook'],
    currencies: ['USD'],
    requiredEnv: [
      'WAAFI_API_URL',
      'WAAFI_MERCHANT_ID',
      'WAAFI_API_KEY',
      'WAAFI_API_USER_ID',
    ],
    note: 'No refund API integration — refunds against Waafi payments are recorded in the panel and must be actioned in the Waafi merchant portal.',
  },
  {
    id: 'manual',
    label: 'Manual / Bank Transfer',
    implemented: true,
    capabilities: ['manual_capture'],
    currencies: [],
    requiredEnv: [],
    note: 'Always available. The admin confirms payment, which is what makes the local billing sweep the source of truth for these subscriptions.',
  },
  {
    id: 'paypal',
    label: 'PayPal',
    implemented: false,
    capabilities: ['redirect', 'recurring', 'refund_api', 'webhook'],
    currencies: ['USD', 'EUR', 'GBP'],
    requiredEnv: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'],
    note: 'Requires a PayPal business account. No integration code exists yet.',
  },
  {
    id: 'razorpay',
    label: 'Razorpay',
    implemented: false,
    capabilities: ['redirect', 'recurring', 'refund_api', 'webhook'],
    currencies: ['INR'],
    requiredEnv: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'],
    note: 'Requires an Indian merchant entity. No integration code exists yet.',
  },
  {
    id: 'flutterwave',
    label: 'Flutterwave',
    implemented: false,
    capabilities: ['redirect', 'refund_api', 'webhook'],
    currencies: ['NGN', 'KES', 'USD'],
    requiredEnv: ['FLUTTERWAVE_SECRET_KEY'],
    note: 'Requires a Flutterwave merchant account. No integration code exists yet.',
  },
  {
    id: 'paystack',
    label: 'Paystack',
    implemented: false,
    capabilities: ['redirect', 'recurring', 'refund_api', 'webhook'],
    currencies: ['NGN', 'GHS', 'ZAR'],
    requiredEnv: ['PAYSTACK_SECRET_KEY'],
    note: 'Requires a Paystack merchant account. No integration code exists yet.',
  },
  {
    id: 'crypto',
    label: 'Cryptocurrency',
    implemented: false,
    capabilities: ['redirect', 'webhook'],
    currencies: ['BTC', 'ETH', 'USDT'],
    requiredEnv: ['CRYPTO_PROVIDER_API_KEY'],
    note: 'Needs a processor (BTCPay, Coinbase Commerce, NOWPayments). Refunds are not reversible on-chain — treat as manual capture.',
  },
]

export interface GatewayStatus extends GatewayDescriptor {
  /** All required env vars present. */
  configured: boolean
  missingEnv: string[]
  /** Implemented AND configured — can actually take money right now. */
  usable: boolean
  /**
   * 'test' when the credentials are sandbox ones. A test key takes no real
   * money, so an operator seeing only "usable" would wrongly believe they
   * were live. 'unknown' where the provider gives us no way to tell.
   */
  mode: 'live' | 'test' | 'unknown' | 'n/a'
}

/**
 * Env presence check that treats placeholder values as unset.
 *
 * Matches anywhere in the value, not just at the start. The placeholder
 * actually shipped is `sk_test_replace_me`, which begins with a legitimate
 * `sk_test_` prefix — an anchored test passed it, so this endpoint reported
 * Stripe as configured and usable while `stripe.ts` (which looks for the same
 * words anywhere) had correctly fallen back to demo mode. The admin panel
 * showed a green, enabled gateway that could not take a payment, which is the
 * exact failure this module exists to prevent.
 */
function envPresent(name: string): boolean {
  const v = process.env[name]?.trim()
  if (!v) return false
  return !/(replace|placeholder|changeme|your[_-]?key|your-|xxx|test-key|dummy|example)/i.test(v)
}

/** Resolve one gateway's live readiness. */
export function getGatewayStatus(id: string): GatewayStatus | null {
  const g = GATEWAYS.find((x) => x.id === id)
  if (!g) return null

  // Where a gateway owns an authoritative readiness check, defer to it rather
  // than re-deriving one here. Two independent opinions about whether Stripe
  // is configured is how this endpoint ended up reporting a usable gateway
  // that stripe.ts had already given up on.
  const configured =
    g.id === 'waafi'
      ? isWaafiConfigured()
      : g.id === 'stripe'
        ? !isStripeDemoMode()
        : g.requiredEnv.length === 0
          ? true
          : g.requiredEnv.every(envPresent)

  const missingEnv = g.requiredEnv.filter((e) => !envPresent(e))

  return {
    ...g,
    configured,
    missingEnv,
    usable: g.implemented && configured,
    mode: detectMode(g.id, configured),
  }
}

/** Sandbox-vs-production detection, where the provider's key format allows it. */
function detectMode(id: string, configured: boolean): GatewayStatus['mode'] {
  if (id === 'manual') return 'n/a' // no credentials, nothing to be test about
  if (!configured) return 'unknown'
  switch (id) {
    case 'stripe': {
      const k = (process.env.STRIPE_SECRET_KEY || '').trim()
      if (k.startsWith('sk_test_') || k.startsWith('rk_test_')) return 'test'
      if (k.startsWith('sk_live_') || k.startsWith('rk_live_')) return 'live'
      return 'unknown'
    }
    case 'waafi':
      return /sandbox|test|staging/i.test(process.env.WAAFI_API_URL || '')
        ? 'test'
        : 'live'
    case 'paystack':
      return (process.env.PAYSTACK_SECRET_KEY || '').startsWith('sk_test')
        ? 'test'
        : 'live'
    case 'flutterwave':
      return (process.env.FLUTTERWAVE_SECRET_KEY || '').includes('TEST')
        ? 'test'
        : 'live'
    case 'razorpay':
      return (process.env.RAZORPAY_KEY_ID || '').startsWith('rzp_test')
        ? 'test'
        : 'live'
    default:
      return 'unknown'
  }
}

/** Readiness for every known gateway. */
export function getAllGatewayStatuses(): GatewayStatus[] {
  return GATEWAYS.map((g) => getGatewayStatus(g.id)!).filter(Boolean)
}

/** Does this gateway support programmatic refunds? */
export function supportsRefundApi(id: string): boolean {
  const g = getGatewayStatus(id)
  return Boolean(g?.usable && g.capabilities.includes('refund_api'))
}

/** Does the gateway drive its own renewals (so our sweep must not)? */
export function drivesOwnRenewals(id: string): boolean {
  const g = GATEWAYS.find((x) => x.id === id)
  return Boolean(g?.implemented && g.capabilities.includes('recurring'))
}
