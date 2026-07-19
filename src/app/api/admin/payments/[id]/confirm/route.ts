import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { activatePayment, rejectPayment } from '@/lib/payment-activation'

/**
 * Admin confirmation of an offline payment.
 *
 * This is the step that turns a bank transfer into a live service: it runs
 * the exact same activation path as the Stripe webhook and the Waafi
 * callback (complete payment → activate subscription → provision).
 */
function requireAdmin(request: Request): {
  decoded: { userId: string; email: string; role: string }
} | null {
  const token = extractTokenFromHeader(request.headers.get('Authorization'))
  if (!token) return null
  const decoded = verifyToken(token)
  if (!decoded) return null
  if (decoded.role !== 'super_admin' && decoded.role !== 'admin') return null
  return { decoded }
}

/**
 * POST /api/admin/payments/:id/confirm
 * Body: { action?: "confirm" | "reject", note?: string }
 *
 * Confirming is idempotent — a double-click cannot provision twice.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = requireAdmin(request)
    if (!auth) {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }

    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as {
      action?: string
      note?: string
    }
    const action = (body.action || 'confirm').toLowerCase()
    const note = typeof body.note === 'string' ? body.note.trim() : null

    const payment = await db.payment.findUnique({ where: { id } })
    if (!payment) {
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
    }

    // ── Reject ────────────────────────────────────────────────────
    if (action === 'reject') {
      const result = await rejectPayment({
        paymentId: id,
        reason: note,
        rejectedByUserId: auth.decoded.userId,
      })
      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 400 })
      }
      await logAudit({
        userId: auth.decoded.userId,
        action: 'payment.reject',
        resource: 'payment',
        resourceId: id,
        req: request,
        metadata: { reason: note, amount: payment.amount },
      }).catch(() => {})
      return NextResponse.json({
        success: true,
        status: 'failed',
        message: 'Payment rejected.',
      })
    }

    // ── Confirm ───────────────────────────────────────────────────
    const result = await activatePayment({
      paymentId: id,
      method: payment.method || 'manual',
      confirmedByUserId: auth.decoded.userId,
      confirmedByEmail: auth.decoded.email,
      note,
      notifyTitle: 'Payment Confirmed',
      notifyMessage: `Your payment of ${payment.currency.toUpperCase()} ${payment.amount.toFixed(
        2
      )} has been confirmed. Your service is being activated.`,
    })

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || 'Could not confirm payment' },
        { status: 400 }
      )
    }

    await logAudit({
      userId: auth.decoded.userId,
      action: 'payment.confirm',
      resource: 'payment',
      resourceId: id,
      req: request,
      metadata: {
        amount: payment.amount,
        currency: payment.currency,
        method: payment.method,
        note,
        alreadyCompleted: Boolean(result.alreadyCompleted),
      },
    }).catch(() => {})

    return NextResponse.json({
      success: true,
      status: 'completed',
      alreadyCompleted: Boolean(result.alreadyCompleted),
      subscriptionId: result.subscriptionId ?? null,
      message: result.alreadyCompleted
        ? 'Payment was already confirmed.'
        : 'Payment confirmed — service is being activated.',
    })
  } catch (error) {
    console.error('[admin/payments/confirm] failed:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
