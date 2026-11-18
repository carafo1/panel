import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  verifyPayment as verifyWaafiPayment,
  waafiAmountMismatch,
} from '@/lib/waafi'
import { activatePayment } from '@/lib/payment-activation'
import { createNotification } from '@/lib/notifications'

/**
 * POST /api/billing/waafi/callback
 *
 * Waafi Pay calls this endpoint (server-to-server) after a payment is
 * processed. We:
 *   1. Locate the matching Payment record by `transactionId`.
 *   2. Verify the payment status with Waafi (defence-in-depth against
 *      forged callbacks).
 *   3. Update the Payment record to 'completed'.
 *   4. Activate the subscription linked to THIS payment (never a guess).
 *   5. Drive the automation pipeline (create project / domain / deployment).
 *   6. Notify the user.
 *
 * Body shape (best-effort - Waafi may send additional fields):
 *   {
 *     transactionId: string,
 *     status: string,        // "success" | "completed" | "failed" ...
 *     amount?: number,
 *     currency?: string,
 *     reference?: string,
 *     ...
 *   }
 *
 * The endpoint is public (Waafi can't authenticate against our JWT system)
 * but a successful flow always re-verifies the transaction with Waafi's
 * API before granting access, so a forged callback cannot complete a
 * payment on its own.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const {
      transactionId,
      status: rawStatus,
      amount,
      currency,
      reference,
    } = body as {
      transactionId?: string
      status?: string
      amount?: number
      currency?: string
      reference?: string
    }

    if (!transactionId) {
      console.warn('[waafi/callback] missing transactionId in body')
      return NextResponse.json(
        { success: false, error: 'transactionId is required' },
        { status: 400 }
      )
    }

    console.log(
      `[waafi/callback] received callback for tx ${transactionId} status=${rawStatus ?? 'n/a'}`
    )

    // Find the pending Payment row.
    const payment = await db.payment.findFirst({
      where: {
        method: 'waafi',
        transactionId,
      },
    })

    if (!payment) {
      console.warn(
        `[waafi/callback] no payment record found for tx ${transactionId}`
      )
      return NextResponse.json(
        { success: false, error: 'Payment not found' },
        { status: 404 }
      )
    }

    // Already completed - idempotent response.
    if (payment.status === 'completed') {
      return NextResponse.json({
        success: true,
        status: 'completed',
        message: 'Payment already processed',
      })
    }
    // Failed / refunded payments are final: a late or replayed callback must
    // not resurrect them.
    if (payment.status !== 'pending') {
      return NextResponse.json({
        success: true,
        status: payment.status,
        message: `Payment is ${payment.status}; nothing to do`,
      })
    }

    const expected = { amount: payment.amount, currency: payment.currency }

    // ── Re-verify with Waafi (defence-in-depth) ──────────────────
    // The body of this public endpoint is never trusted: status, amount and
    // currency all come from Waafi's own TransactionStatus answer.
    const verification = await verifyWaafiPayment(transactionId, expected)
    if (!verification.success) {
      console.error(
        `[waafi/callback] verification failed for tx ${transactionId}:`,
        verification.error
      )
      // Don't mark as failed outright - the callback itself may be a
      // retry. Leave it pending and let Waafi retry.
      return NextResponse.json(
        {
          success: false,
          error: 'Verification failed - payment left pending',
        },
        { status: 502 }
      )
    }

    // If verification says pending, leave the row pending and let Waafi
    // call back again later.
    if (verification.status === 'pending') {
      return NextResponse.json({
        success: true,
        status: 'pending',
        message: 'Payment still pending - awaiting confirmation',
      })
    }

    // If verification says failed, mark the Payment as failed (only if it is
    // still pending — never overwrite a completion that raced us).
    if (verification.status === 'failed') {
      const failed = await db.payment.updateMany({
        where: { id: payment.id, status: 'pending' },
        data: { status: 'failed' },
      })
      if (failed.count === 1) {
        await createNotification({
          userId: payment.userId,
          title: 'Payment Failed',
          message: `Your Waafi Pay payment of ${payment.currency.toUpperCase()} ${payment.amount.toFixed(2)} could not be confirmed. Please try again or choose another payment method.`,
          type: 'error',
          link: '/?tab=billing',
        })
      }
      return NextResponse.json({
        success: true,
        status: 'failed',
        message: 'Payment marked as failed',
      })
    }

    // ── Completed: the verified money must cover what we charged ──
    // The old code accepted any reported amount and overwrote payment.amount
    // with it, so a 0.01 payment activated a full plan. The expected amount
    // is never changed; a shortfall or currency mismatch leaves the payment
    // pending for an admin to look at.
    const mismatch = waafiAmountMismatch(expected, verification)
    if (mismatch) {
      console.error(`[waafi/callback] tx ${transactionId} NOT activated: ${mismatch}`)
      let meta: Record<string, unknown> = {}
      try {
        meta = payment.metadata ? JSON.parse(payment.metadata) : {}
      } catch {
        meta = {}
      }
      await db.payment
        .updateMany({
          where: { id: payment.id, status: 'pending' },
          data: {
            metadata: JSON.stringify({
              ...meta,
              waafiVerificationMismatch: mismatch,
              waafiVerifiedAmount: verification.amount ?? null,
              waafiVerifiedCurrency: verification.currency ?? null,
              waafiMismatchAt: new Date().toISOString(),
            }),
          },
        })
        .catch(() => {})
      return NextResponse.json(
        {
          success: false,
          status: 'pending',
          error: 'Paid amount does not match the order - payment held for review',
        },
        { status: 409 }
      )
    }

    // Same activation path as every other gateway: atomically completes the
    // payment, activates ITS subscription (no "latest pending" guess),
    // settles ITS invoice and provisions once.
    const result = await activatePayment({
      paymentId: payment.id,
      method: 'waafi',
      extraMetadata: {
        waafiCallbackStatus: rawStatus || verification.status,
        waafiReference: reference || null,
        waafiReportedAmount: amount ?? null,
        waafiReportedCurrency: currency ?? null,
        waafiVerifiedAmount: verification.amount ?? null,
        waafiVerifiedCurrency: verification.currency ?? null,
      },
      notifyTitle: 'Payment Successful',
      notifyMessage: `Your Waafi Pay payment of ${payment.currency.toUpperCase()} ${payment.amount.toFixed(2)} has been confirmed. Your resources are being provisioned.`,
    })

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error || 'Payment could not be confirmed' },
        { status: 409 }
      )
    }

    return NextResponse.json({
      success: true,
      status: 'completed',
      paymentId: payment.id,
      alreadyCompleted: Boolean(result.alreadyCompleted),
      provisioning: result.automation ?? null,
    })
  } catch (error) {
    console.error('Waafi callback error:', error)
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * GET /api/billing/waafi/callback
 *
 * Some payment providers redirect the user's browser back to the
 * callback URL in addition to (or instead of) sending a server-to-server
 * POST. We accept GET too and treat it as a "user landed here after
 * Waafi checkout" event - we re-verify the transaction and redirect
 * the user to the dashboard.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const transactionId =
      searchParams.get('transactionId') ||
      searchParams.get('transaction_id') ||
      searchParams.get('tx') ||
      searchParams.get('txId')
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''

    if (!transactionId) {
      return NextResponse.redirect(
        new URL(`${appUrl}/?tab=billing&payment=error`, request.url)
      )
    }

    // Look up the payment row.
    const payment = await db.payment.findFirst({
      where: { method: 'waafi', transactionId },
    })

    if (!payment) {
      return NextResponse.redirect(
        new URL(`${appUrl}/?tab=billing&payment=error`, request.url)
      )
    }

    // If already completed, just redirect.
    if (payment.status === 'completed') {
      return NextResponse.redirect(
        new URL(`${appUrl}/?tab=billing&payment=success`, request.url)
      )
    }

    // Re-verify with Waafi before granting success.
    const verification = await verifyWaafiPayment(transactionId, {
      amount: payment.amount,
      currency: payment.currency,
    })
    const finalStatus =
      verification.success && verification.status === 'completed'
        ? 'success'
        : verification.status === 'failed'
          ? 'failed'
          : 'pending'

    if (verification.success && verification.status === 'completed') {
      // Reuse the POST handler logic by re-sending as a synthetic POST.
      // Cheaper to just do the same minimal steps inline.
      const syntheticRequest = new Request(request.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transactionId,
          status: 'completed',
          amount: verification.amount,
          currency: verification.currency,
        }),
      })
      await POST(syntheticRequest)
    }

    return NextResponse.redirect(
      new URL(
        `${appUrl}/?tab=billing&payment=${finalStatus}`,
        request.url
      )
    )
  } catch (error) {
    console.error('Waafi callback GET error:', error)
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
    return NextResponse.redirect(
      new URL(`${appUrl}/?tab=billing&payment=error`, request.url)
    )
  }
}
