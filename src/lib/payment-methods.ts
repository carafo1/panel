/**
 * Unified payment-method manager.
 *
 * Used by:
 *  - #18 Multi-Payment Billing (Stripe / Waafi / Manual)
 *
 * Responsibilities:
 *  - Manage PaymentMethodSetting rows (active/inactive, config, display).
 *  - Seed default payment methods on first use.
 *  - Provide a single `processPayment()` entry point that dispatches to
 *    the correct provider (Stripe, Waafi Pay, or Manual) based on the
 *    requested method.
 *
 * The dispatch table is the single source of truth for "how do I pay
 * with X". API routes /checkout and /billing/methods consume it.
 */
import { db } from '@/lib/db'
import { createCheckoutSession, isStripeDemoMode } from '@/lib/stripe'
import { demoPaymentsAllowed } from '@/lib/demo-mode'
import { createPayment as createWaafiPayment, isWaafiConfigured } from '@/lib/waafi'
import { BILLING_EMAIL } from '@/lib/brand-config'

export interface PaymentMethod {
  method: string // "stripe", "waafi", "manual"
  displayName: string
  active: boolean
  icon: string | null
  sortOrder: number
  config: any | null
}

export interface ProcessPaymentOptions {
  method: string // "stripe", "waafi", "manual"
  planId: string
  amount: number // currency units (NOT cents) - matches plan.price / domain fee
  currency: string
  userId: string
  email: string
  successUrl: string
  cancelUrl: string
  // Optional metadata used by downstream automation & matching
  planName?: string
  purchaseType?: string // hosting | domain | both
  domainName?: string | null
  projectName?: string | null
  framework?: string | null
  subscriptionId?: string | null
  /**
   * Extra keys merged into the Payment metadata. Used to carry the
   * domainOrderId so fulfilment can find the order once the money lands,
   * whichever gateway confirms it.
   */
  extraMetadata?: Record<string, unknown>
}

export interface ProcessPaymentResult {
  success: boolean
  redirectUrl?: string // for Stripe/Waafi (redirect to payment page)
  transactionId?: string
  sessionId?: string // Stripe checkout session id
  paymentId?: string // internal Payment row id
  status: string // "pending" | "completed" | "redirect_required"
  error?: string
}

const DEFAULT_METHODS: Array<{
  method: string
  displayName: string
  active: boolean
  icon: string
  sortOrder: number
  config: Record<string, unknown>
}> = [
  {
    method: 'stripe',
    displayName: 'Credit / Debit Card (Stripe)',
    active: true,
    icon: 'credit-card',
    sortOrder: 10,
    config: {},
  },
  {
    method: 'waafi',
    displayName: 'Waafi Pay',
    active: false, // off by default - super admin toggles on once configured
    icon: 'wallet',
    sortOrder: 20,
    config: {},
  },
  {
    method: 'manual',
    displayName: 'Manual / Bank Transfer',
    active: false, // off by default
    icon: 'banknote',
    sortOrder: 30,
    config: {
      instructions:
        `Transfer the amount to the bank account below and email proof of payment to ${BILLING_EMAIL}. Your subscription will be activated once the payment is verified.`,
      bankName: 'Bank of Example',
      accountName: 'Apsamo Technology Inc.',
      accountNumber: '0000-0000-0000',
      iban: '',
      swift: '',
      referencePrefix: 'DH-',
    },
  },
]

function safeParseConfig(raw: string | null): any | null {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function rowToMethod(row: {
  method: string
  displayName: string
  active: boolean
  icon: string | null
  sortOrder: number
  config: string | null
}): PaymentMethod {
  return {
    method: row.method,
    displayName: row.displayName,
    active: row.active,
    icon: row.icon,
    sortOrder: row.sortOrder,
    config: safeParseConfig(row.config),
  }
}

/**
 * Seed the default payment methods into the database if they don't exist.
 * Idempotent - safe to call on every request.
 */
export async function ensurePaymentMethodsSeeded(): Promise<void> {
  for (const def of DEFAULT_METHODS) {
    try {
      const existing = await db.paymentMethodSetting.findUnique({
        where: { method: def.method },
      })
      if (existing) continue
      await db.paymentMethodSetting.create({
        data: {
          method: def.method,
          displayName: def.displayName,
          active: def.active,
          icon: def.icon,
          sortOrder: def.sortOrder,
          config: JSON.stringify(def.config),
        },
      })
    } catch (error) {
      // Don't let a single failure (e.g. race condition) bubble up -
      // the worst case is the method stays unseeded and a follow-up
      // request will retry.
      console.error(
        `[payment-methods] ensurePaymentMethodsSeeded failed for ${def.method}:`,
        error instanceof Error ? error.message : error
      )
    }
  }
}

/**
 * Get all ACTIVE payment methods, sorted by sortOrder ascending.
 * Used by the public /api/billing/methods endpoint and the checkout UI.
 */
export async function getActivePaymentMethods(): Promise<PaymentMethod[]> {
  await ensurePaymentMethodsSeeded()
  const rows = await db.paymentMethodSetting.findMany({
    where: { active: true },
    orderBy: { sortOrder: 'asc' },
  })
  return rows.map(rowToMethod).filter((m) => gatewayUsable(m.method))
}

/**
 * A card or Waafi gateway without real credentials can only simulate a
 * payment. That is fine while developing; in production it handed out paid
 * plans for nothing, so there the method is treated as unavailable.
 */
function gatewayUsable(method: string): boolean {
  if (demoPaymentsAllowed()) return true
  if (method === 'stripe') return !isStripeDemoMode()
  if (method === 'waafi') return isWaafiConfigured()
  return true
}

/**
 * Get ALL payment methods (active and inactive), sorted by sortOrder.
 * Used by the super admin /api/admin/payment-methods endpoint.
 */
export async function getAllPaymentMethods(): Promise<PaymentMethod[]> {
  await ensurePaymentMethodsSeeded()
  const rows = await db.paymentMethodSetting.findMany({
    orderBy: { sortOrder: 'asc' },
  })
  return rows.map(rowToMethod)
}

/**
 * Return a single payment method by its key, or null when not seeded yet.
 */
export async function getPaymentMethod(
  method: string
): Promise<PaymentMethod | null> {
  await ensurePaymentMethodsSeeded()
  const row = await db.paymentMethodSetting.findUnique({
    where: { method },
  })
  return row ? rowToMethod(row) : null
}

/**
 * Toggle a payment method active/inactive. Super admin only.
 */
export async function togglePaymentMethod(
  method: string,
  active: boolean
): Promise<{ success: boolean }> {
  await ensurePaymentMethodsSeeded()
  try {
    await db.paymentMethodSetting.update({
      where: { method },
      data: { active },
    })
    return { success: true }
  } catch (error) {
    console.error(
      `[payment-methods] togglePaymentMethod failed for ${method}:`,
      error instanceof Error ? error.message : error
    )
    return { success: false }
  }
}

/**
 * Update a payment method's config (and optionally its display name/icon).
 * Super admin only. `config` is JSON-serialisable.
 */
export async function updatePaymentMethodConfig(
  method: string,
  config: any,
  extra?: { displayName?: string; icon?: string; sortOrder?: number }
): Promise<{ success: boolean }> {
  await ensurePaymentMethodsSeeded()
  try {
    await db.paymentMethodSetting.update({
      where: { method },
      data: {
        config: config != null ? JSON.stringify(config) : undefined,
        ...(extra?.displayName !== undefined
          ? { displayName: extra.displayName }
          : {}),
        ...(extra?.icon !== undefined ? { icon: extra.icon } : {}),
        ...(extra?.sortOrder !== undefined
          ? { sortOrder: extra.sortOrder }
          : {}),
      },
    })
    return { success: true }
  } catch (error) {
    console.error(
      `[payment-methods] updatePaymentMethodConfig failed for ${method}:`,
      error instanceof Error ? error.message : error
    )
    return { success: false }
  }
}

/**
 * Validate that the user requested a real, active payment method.
 * Returns the resolved PaymentMethod or null when not allowed.
 */
export async function resolveActiveMethod(
  method: string
): Promise<PaymentMethod | null> {
  if (!method || typeof method !== 'string') return null
  const m = await getPaymentMethod(method)
  if (!m || !m.active) return null
  if (!gatewayUsable(m.method)) {
    console.error(
      `[payment-methods] "${m.method}" is enabled but has no real credentials — refusing to simulate a payment in production`
    )
    return null
  }
  return m
}

/**
 * Single entry point for processing a payment.
 *
 * Dispatches to the correct provider based on `method`:
 *  - "stripe": create a Stripe Checkout Session, return the redirect URL.
 *  - "waafi":  create a Waafi payment request, return the redirect URL.
 *  - "manual": create a pending Payment row + return transactionId; an
 *              admin manually confirms the payment later.
 *
 * All providers create a Payment row so we have a unified audit trail.
 */
export async function processPayment(
  opts: ProcessPaymentOptions
): Promise<ProcessPaymentResult> {
  const method = (opts.method || 'stripe').toLowerCase()

  // Validate the method is active.
  const activeMethod = await resolveActiveMethod(method)
  if (!activeMethod) {
    return {
      success: false,
      status: 'failed',
      error: `Payment method "${method}" is not available. Please choose another method.`,
    }
  }

  const metadata: Record<string, unknown> = {
    planId: opts.planId,
    planName: opts.planName || null,
    purchaseType: opts.purchaseType || 'hosting',
    domainName: opts.domainName || null,
    projectName: opts.projectName || null,
    framework: opts.framework || null,
    method,
    subscriptionId: opts.subscriptionId || null,
    ...(opts.extraMetadata || {}),
  }

  // ── STRIPE ─────────────────────────────────────────────────────
  if (method === 'stripe') {
    try {
      const session = await createCheckoutSession({
        planId: opts.planId,
        planName: opts.planName || 'Apsamo Technology Purchase',
        amount: Math.round(opts.amount * 100), // Stripe wants cents
        currency: opts.currency,
        successUrl: opts.successUrl,
        cancelUrl: opts.cancelUrl,
        userId: opts.userId,
        email: opts.email,
      })

      const payment = await db.payment.create({
        data: {
          userId: opts.userId,
          subscriptionId: opts.subscriptionId || null,
          amount: opts.amount,
          currency: opts.currency,
          status: 'pending',
          type: opts.purchaseType || 'hosting',
          method: 'stripe',
          transactionId: session.sessionId,
          stripePaymentId: session.sessionId, // matched by /api/billing/success
          metadata: JSON.stringify({
            ...metadata,
            checkoutSessionId: session.sessionId,
            redirectUrl: session.url,
          }),
        },
      })

      return {
        success: true,
        status: 'redirect_required',
        redirectUrl: session.url,
        sessionId: session.sessionId,
        transactionId: session.sessionId,
        paymentId: payment.id,
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Stripe checkout failed'
      console.error('[payment-methods] stripe processPayment failed:', message)
      return {
        success: false,
        status: 'failed',
        error: message,
      }
    }
  }

  // ── WAAFI ──────────────────────────────────────────────────────
  if (method === 'waafi') {
    const reference = `DH-${opts.planId}-${Date.now()}`
    const callbackUrl = `${
      process.env.NEXT_PUBLIC_APP_URL || ''
    }/api/billing/waafi/callback`
    const returnUrl = `${
      process.env.NEXT_PUBLIC_APP_URL || ''
    }/?tab=billing&payment=waafi-pending`

    try {
      const waafiResult = await createWaafiPayment({
        amount: opts.amount,
        currency: opts.currency.toUpperCase() === 'USD' ? 'USD' : opts.currency,
        description: `${opts.planName || 'Apsamo Technology'} - ${opts.purchaseType || 'subscription'}`,
        callbackUrl,
        returnUrl,
        reference,
      })

      if (!waafiResult.success || !waafiResult.transactionId) {
        return {
          success: false,
          status: 'failed',
          error: waafiResult.error || 'Waafi payment could not be initiated.',
        }
      }

      const payment = await db.payment.create({
        data: {
          userId: opts.userId,
          subscriptionId: opts.subscriptionId || null,
          amount: opts.amount,
          currency: opts.currency,
          status: 'pending',
          type: opts.purchaseType || 'hosting',
          method: 'waafi',
          transactionId: waafiResult.transactionId,
          stripePaymentId: null,
          metadata: JSON.stringify({
            ...metadata,
            waafiTransactionId: waafiResult.transactionId,
            waafiReference: reference,
            waafiDemoMode: !isWaafiConfigured(),
            redirectUrl: waafiResult.paymentUrl,
          }),
        },
      })

      return {
        success: true,
        status: 'redirect_required',
        redirectUrl: waafiResult.paymentUrl,
        transactionId: waafiResult.transactionId,
        paymentId: payment.id,
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Waafi checkout failed'
      console.error('[payment-methods] waafi processPayment failed:', message)
      return {
        success: false,
        status: 'failed',
        error: message,
      }
    }
  }

  // ── MANUAL ─────────────────────────────────────────────────────
  if (method === 'manual') {
    try {
      const reference = `MAN-${opts.planId.slice(-6).toUpperCase()}-${Date.now()
        .toString(36)
        .toUpperCase()}`
      const methodConfig = activeMethod.config || {}

      const payment = await db.payment.create({
        data: {
          userId: opts.userId,
          subscriptionId: opts.subscriptionId || null,
          amount: opts.amount,
          currency: opts.currency,
          status: 'pending',
          type: opts.purchaseType || 'hosting',
          method: 'manual',
          transactionId: reference,
          metadata: JSON.stringify({
            ...metadata,
            manualReference: reference,
            instructions: methodConfig.instructions || null,
            bankDetails: {
              bankName: methodConfig.bankName || null,
              accountName: methodConfig.accountName || null,
              accountNumber: methodConfig.accountNumber || null,
              iban: methodConfig.iban || null,
              swift: methodConfig.swift || null,
            },
            // Admin will set confirmed: true + confirmedBy + confirmedAt
            // when manually approving the payment.
            adminConfirmed: false,
          }),
        },
      })

      return {
        success: true,
        status: 'pending',
        transactionId: reference,
        paymentId: payment.id,
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Manual payment setup failed'
      console.error('[payment-methods] manual processPayment failed:', message)
      return {
        success: false,
        status: 'failed',
        error: message,
      }
    }
  }

  // Unknown method.
  return {
    success: false,
    status: 'failed',
    error: `Unsupported payment method: ${method}`,
  }
}
