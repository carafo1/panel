/**
 * Stripe payments API client wrapper.
 *
 * Used by:
 *  - #1 Real Stripe Payments
 *
 * When STRIPE_SECRET_KEY is not set, runs in DEMO MODE - returns simulated
 * data so the billing UI can be exercised without a real Stripe account.
 *
 * Docs: https://stripe.com/docs/api
 */
import Stripe from 'stripe'

function getSecretKey(): string | null {
  return process.env.STRIPE_SECRET_KEY || null
}

export function isStripeDemoMode(): boolean {
  return !getSecretKey()
}

let client: Stripe | null = null
function getClient(): Stripe | null {
  const key = getSecretKey()
  if (!key) return null
  if (!client) {
    client = new Stripe(key, {
      apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion,
    })
  }
  return client
}

interface CheckoutOptions {
  planId: string
  planName: string
  amount: number // in cents (USD)
  currency: string
  successUrl: string
  cancelUrl: string
  userId: string
  email: string
}

interface CheckoutResult {
  sessionId: string
  url: string
}

/**
 * Create a Stripe Checkout Session for a one-off or subscription payment.
 */
export async function createCheckoutSession(
  opts: CheckoutOptions
): Promise<CheckoutResult> {
  if (isStripeDemoMode()) {
    // Demo mode - return a fake session
     
    console.log('[stripe] DEMO MODE: createCheckoutSession', opts)
    const sessionId = `cs_demo_${Date.now()}`
    return {
      sessionId,
      url: `${process.env.NEXT_PUBLIC_APP_URL || ''}/billing/demo-checkout?session=${sessionId}`,
    }
  }

  const stripe = getClient()!
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: opts.email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: opts.currency,
          product_data: {
            name: opts.planName,
            metadata: { planId: opts.planId },
          },
          unit_amount: opts.amount,
        },
      },
    ],
    metadata: {
      planId: opts.planId,
      userId: opts.userId,
    },
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
  })

  return { sessionId: session.id, url: session.url || '' }
}

/**
 * Retrieve a Checkout Session by ID (used to verify post-payment status).
 */
export async function retrieveSession(sessionId: string): Promise<Stripe.Checkout.Session> {
  if (isStripeDemoMode()) {
     
    console.log('[stripe] DEMO MODE: retrieveSession', sessionId)
    return {
      id: sessionId,
      object: 'checkout.session',
      payment_status: 'paid',
      amount_total: 990,
      currency: 'usd',
      customer_details: { email: 'demo@deployhub.local' },
      metadata: { planId: 'demo-plan', userId: 'demo-user' },
    } as unknown as Stripe.Checkout.Session
  }
  const stripe = getClient()!
  return stripe.checkout.sessions.retrieve(sessionId)
}

interface CreateSubscriptionOptions {
  customerId: string
  priceId: string
}

/**
 * Create a new Stripe subscription.
 */
export async function createSubscription(
  opts: CreateSubscriptionOptions
): Promise<Stripe.Subscription> {
  if (isStripeDemoMode()) {
     
    console.log('[stripe] DEMO MODE: createSubscription', opts)
    return {
      id: `sub_demo_${Date.now()}`,
      object: 'subscription',
      status: 'active',
      current_period_start: Math.floor(Date.now() / 1000),
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      customer: opts.customerId,
    } as unknown as Stripe.Subscription
  }
  const stripe = getClient()!
  return stripe.subscriptions.create({
    customer: opts.customerId,
    items: [{ price: opts.priceId }],
  })
}

/**
 * Cancel a Stripe subscription at the end of the current period.
 */
export async function cancelSubscription(
  subscriptionId: string
): Promise<Stripe.Subscription> {
  if (isStripeDemoMode()) {
     
    console.log('[stripe] DEMO MODE: cancelSubscription', subscriptionId)
    return {
      id: subscriptionId,
      object: 'subscription',
      status: 'canceled',
      cancel_at_period_end: true,
    } as unknown as Stripe.Subscription
  }
  const stripe = getClient()!
  return stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  })
}

/**
 * Construct a Stripe webhook event from the raw body + signature.
 * Use this in /api/webhooks/stripe to verify webhook authenticity.
 */
export async function constructWebhookEvent(
  payload: string,
  signature: string
): Promise<Stripe.Event> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (isStripeDemoMode() || !secret) {
    // Demo mode - parse the payload as JSON without verification
     
    console.warn(
      '[stripe] DEMO MODE: constructWebhookEvent - signature not verified'
    )
    return JSON.parse(payload) as Stripe.Event
  }
  const stripe = getClient()!
  return stripe.webhooks.constructEvent(payload, signature, secret)
}

interface CreateCustomerResult {
  customerId: string
}

/**
 * Create a Stripe customer for a user.
 */
export async function createCustomer(
  email: string,
  name: string
): Promise<CreateCustomerResult> {
  if (isStripeDemoMode()) {
     
    console.log('[stripe] DEMO MODE: createCustomer', email)
    return { customerId: `cus_demo_${Date.now()}` }
  }
  const stripe = getClient()!
  const customer = await stripe.customers.create({
    email,
    name,
  })
  return { customerId: customer.id }
}

/**
 * Retrieve a customer by ID.
 */
export async function retrieveCustomer(customerId: string): Promise<Stripe.Customer | Stripe.DeletedCustomer> {
  if (isStripeDemoMode()) {
    return {
      id: customerId,
      object: 'customer',
      email: 'demo@deployhub.local',
      deleted: false,
    } as unknown as Stripe.Customer
  }
  const stripe = getClient()!
  return stripe.customers.retrieve(customerId)
}
