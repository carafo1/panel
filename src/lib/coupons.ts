/**
 * Coupon validation and redemption.
 *
 * A coupon is only ever applied through `validateCoupon()` so every rule
 * (window, limits, scope, minimum spend) is enforced in one place — the API,
 * checkout and the admin panel can't drift apart.
 */
import { db } from '@/lib/db'

export interface CouponCheckResult {
  valid: boolean
  reason?: string
  couponId?: string
  code?: string
  /** Discount in currency units for the supplied subtotal. */
  discount?: number
  type?: string
  value?: number
  recurring?: boolean
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

/**
 * Check a coupon for a given customer/subtotal without consuming it.
 * Returns the discount it *would* give.
 */
export async function validateCoupon(opts: {
  code: string
  userId: string
  subtotal: number
  planId?: string | null
}): Promise<CouponCheckResult> {
  const code = (opts.code || '').trim().toUpperCase()
  if (!code) return { valid: false, reason: 'No coupon code supplied' }

  const coupon = await db.coupon.findUnique({ where: { code } })
  if (!coupon) return { valid: false, reason: 'Coupon not found' }
  if (!coupon.active) return { valid: false, reason: 'This coupon is no longer active' }

  const now = new Date()
  if (coupon.startsAt && now < new Date(coupon.startsAt)) {
    return { valid: false, reason: 'This coupon is not active yet' }
  }
  if (coupon.expiresAt && now > new Date(coupon.expiresAt)) {
    return { valid: false, reason: 'This coupon has expired' }
  }

  // Scope
  if (coupon.userId && coupon.userId !== opts.userId) {
    return { valid: false, reason: 'This coupon is not valid for your account' }
  }
  if (coupon.planId && opts.planId && coupon.planId !== opts.planId) {
    return { valid: false, reason: 'This coupon does not apply to the selected plan' }
  }

  // Spend threshold
  if (coupon.minSubtotal && opts.subtotal < coupon.minSubtotal) {
    return {
      valid: false,
      reason: `Requires a minimum of ${coupon.minSubtotal.toFixed(2)}`,
    }
  }

  // Global + per-customer usage limits
  if (coupon.maxRedemptions != null && coupon.redemptions >= coupon.maxRedemptions) {
    return { valid: false, reason: 'This coupon has reached its usage limit' }
  }
  if (coupon.maxPerCustomer != null) {
    const mine = await db.couponRedemption.count({
      where: { couponId: coupon.id, userId: opts.userId },
    })
    if (mine >= coupon.maxPerCustomer) {
      return { valid: false, reason: 'You have already used this coupon' }
    }
  }

  // First-purchase-only
  if (coupon.firstPurchaseOnly) {
    const priorPaid = await db.invoice.count({
      where: { userId: opts.userId, status: 'paid' },
    })
    if (priorPaid > 0) {
      return { valid: false, reason: 'This coupon is for first purchases only' }
    }
  }

  // Discount never exceeds the subtotal.
  const raw =
    coupon.type === 'fixed'
      ? coupon.value
      : (opts.subtotal * coupon.value) / 100
  const discount = round2(Math.min(Math.max(raw, 0), opts.subtotal))

  return {
    valid: true,
    couponId: coupon.id,
    code: coupon.code,
    discount,
    type: coupon.type,
    value: coupon.value,
    recurring: coupon.recurring,
  }
}

/**
 * Record that a coupon was used. Called once the invoice exists so the
 * redemption can be traced back to it.
 */
export async function redeemCoupon(opts: {
  couponId: string
  userId: string
  invoiceId?: string | null
  amount: number
}): Promise<void> {
  await db.$transaction([
    db.couponRedemption.create({
      data: {
        couponId: opts.couponId,
        userId: opts.userId,
        invoiceId: opts.invoiceId || null,
        amount: opts.amount,
      },
    }),
    db.coupon.update({
      where: { id: opts.couponId },
      data: { redemptions: { increment: 1 } },
    }),
  ])
}
