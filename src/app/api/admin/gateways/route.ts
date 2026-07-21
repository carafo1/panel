import { NextResponse } from 'next/server'
import { requireAdminRole } from '@/lib/auth'
import { db } from '@/lib/db'
import { getAllGatewayStatuses } from '@/lib/gateways'
import { getAllPaymentMethods } from '@/lib/payment-methods'

/**
 * Gateway readiness for the admin UI.
 *
 * Answers the question the payment-methods endpoint can't: is this gateway
 * actually able to take money right now, and if not, why not? The honest
 * distinction is between "no integration exists" and "integration exists but
 * credentials are missing" — collapsing those two would let an operator
 * enable a gateway that silently cannot work.
 */
// SECURITY: role comes from the database, not the 7-day token.
const requireAdmin = requireAdminRole

export async function GET(request: Request) {
  try {
    if (!(await requireAdmin(request))) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const statuses = getAllGatewayStatuses()
    const methods = await getAllPaymentMethods().catch(() => [])

    // Real transaction volume per gateway, so the admin can see which
    // configured gateways are actually being used.
    const payments = await db.payment
      .findMany({ select: { method: true, status: true, amount: true } })
      .catch(() => [] as Array<{ method: string; status: string; amount: number }>)

    const volume: Record<string, { count: number; completed: number; amount: number }> = {}
    for (const p of payments) {
      const k = p.method || 'unknown'
      volume[k] ||= { count: 0, completed: 0, amount: 0 }
      volume[k].count++
      if (p.status === 'completed') {
        volume[k].completed++
        volume[k].amount = Math.round((volume[k].amount + (p.amount || 0)) * 100) / 100
      }
    }

    const gateways = statuses.map((g) => {
      const setting = methods.find((m) => m.method === g.id)
      const v = volume[g.id] || { count: 0, completed: 0, amount: 0 }
      return {
        ...g,
        // Whether the operator has switched it on (independent of whether
        // it *can* work — an enabled-but-unusable gateway is the bug this
        // endpoint exists to surface).
        enabled: setting?.active ?? false,
        seeded: Boolean(setting),
        displayName: setting?.displayName || g.label,
        transactions: v.count,
        completedTransactions: v.completed,
        volume: v.amount,
        blocker: !g.implemented
          ? 'No integration code exists for this gateway yet.'
          : !g.configured
            ? `Missing configuration: ${g.missingEnv.join(', ')}`
            : null,
        // Not a blocker — it works — but it takes no real money, which an
        // operator must know before pointing customers at it.
        warning:
          g.mode === 'test'
            ? 'Configured with TEST/sandbox credentials — payments will not be real.'
            : null,
      }
    })

    const misconfigured = gateways.filter((g) => g.enabled && !g.usable)
    const testMode = gateways.filter((g) => g.enabled && g.mode === 'test')

    return NextResponse.json({
      gateways,
      summary: {
        total: gateways.length,
        implemented: gateways.filter((g) => g.implemented).length,
        usable: gateways.filter((g) => g.usable).length,
        enabled: gateways.filter((g) => g.enabled).length,
        // Enabled but not actually able to take money — customers would hit
        // an error at checkout. Worth surfacing loudly in the UI.
        misconfiguredCount: misconfigured.length,
        misconfigured: misconfigured.map((g) => ({ id: g.id, blocker: g.blocker })),
        // Enabled gateways running on sandbox credentials.
        testModeCount: testMode.length,
        testMode: testMode.map((g) => g.id),
        // The one number that answers "can this panel take real money today?"
        liveReady: gateways.some(
          (g) => g.enabled && g.usable && (g.mode === 'live' || g.mode === 'n/a')
        ),
      },
    })
  } catch (error) {
    console.error('[admin/gateways] GET failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
