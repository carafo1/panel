import { NextResponse } from 'next/server'
import { getActivePaymentMethods } from '@/lib/payment-methods'

/**
 * GET /api/billing/methods
 *
 * Public endpoint that returns all ACTIVE payment methods, sorted by
 * `sortOrder` ascending. Used by the checkout UI to render the list of
 * available payment options.
 *
 * No auth required - the user needs to see which methods are available
 * before they can choose how to pay. The response only ever includes
 * methods the super admin has explicitly enabled; sensitive config
 * (e.g. Waafi API keys) is stripped.
 */
export async function GET() {
  try {
    const methods = await getActivePaymentMethods()

    return NextResponse.json({
      methods: methods.map((m) => ({
        method: m.method,
        displayName: m.displayName,
        icon: m.icon,
        sortOrder: m.sortOrder,
        // Manual payments expose their instructions + bank details so the
        // checkout UI can render them. Stripe/Waafi never expose any
        // sensitive config here.
        config:
          m.method === 'manual'
            ? m.config
            : m.config
              ? {} // shape only - never leak secrets
              : null,
      })),
    })
  } catch (error) {
    console.error('Get payment methods error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
