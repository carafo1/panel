import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyPayment as verifyWaafiPayment } from '@/lib/waafi'
import { provisionForPayment } from '@/lib/provision-on-payment'
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
 *   4. Activate the user's pending Subscription.
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

    // ── Re-verify with Waafi (defence-in-depth) ──────────────────
    const verification = await verifyWaafiPayment(transactionId)
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
      await db.payment.update({
        where: { id: payment.id },
        data: { status: 'pending' },
      })
      return NextResponse.json({
        success: true,
        status: 'pending',
        message: 'Payment still pending - awaiting confirmation',
      })
    }

    // If verification says failed, mark the Payment as failed.
    if (verification.status === 'failed') {
      await db.payment.update({
        where: { id: payment.id },
        data: { status: 'failed' },
      })
      await createNotification({
        userId: payment.userId,
        title: 'Payment Failed',
        message: `Your Waafi Pay payment of ${payment.currency.toUpperCase()} ${payment.amount.toFixed(2)} could not be confirmed. Please try again or choose another payment method.`,
        type: 'error',
        link: '/?tab=billing',
      })
      return NextResponse.json({
        success: true,
        status: 'failed',
        message: 'Payment marked as failed',
      })
    }

    // ── Completed: update Payment + drive automation ─────────────
    let metadata: Record<string, unknown> = {}
    try {
      metadata = payment.metadata ? JSON.parse(payment.metadata) : {}
    } catch {
      metadata = {}
    }

    const updatedPayment = await db.payment.update({
      where: { id: payment.id },
      data: {
        status: 'completed',
        amount:
          typeof verification.amount === 'number' && verification.amount > 0
            ? verification.amount
            : payment.amount,
        currency: verification.currency || payment.currency,
        metadata: JSON.stringify({
          ...metadata,
          waafiCallbackStatus: rawStatus || verification.status,
          waafiReference: reference || metadata.waafiReference || null,
          waafiAmount: amount ?? null,
          waafiCurrency: currency ?? null,
          completedAt: new Date().toISOString(),
        }),
      },
    })

    // Activate the user's pending subscription if one exists.
    let subscriptionId: string | null = null
    if (payment.subscriptionId) {
      const subscription = await db.subscription.findUnique({
        where: { id: payment.subscriptionId },
      })
      if (subscription && subscription.status === 'pending') {
        await db.subscription.update({
          where: { id: subscription.id },
          data: { status: 'active' },
        })
        subscriptionId = subscription.id
      } else if (subscription) {
        subscriptionId = subscription.id
      }
    } else {
      const pendingSub = await db.subscription.findFirst({
        where: { userId: payment.userId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
      })
      if (pendingSub) {
        await db.subscription.update({
          where: { id: pendingSub.id },
          data: { status: 'active' },
        })
        subscriptionId = pendingSub.id
      }
    }

    // REAL provisioning — creates the container / registers the domain.
    //
    // Previously this called processEvent('payment_success'), whose actions
    // are simulated (create_user_workspace only sends a notification and
    // returns an invented id). A Waafi customer would be told their resources
    // were provisioned while nothing existed. provisionForPayment is
    // idempotent, so a replayed callback can't double-provision.
    const provisionResult = await provisionForPayment(updatedPayment.id).catch(
      (err: unknown) => {
        console.error('[waafi-callback] provisioning failed:', err)
        return { provisioned: false, detail: 'provisioning error' }
      }
    )
    console.log(
      `[waafi-callback] provisioning for ${updatedPayment.id}: ${provisionResult.detail}`
    )

    await createNotification({
      userId: payment.userId,
      title: 'Payment Successful',
      message: `Your Waafi Pay payment of ${updatedPayment.currency.toUpperCase()} ${updatedPayment.amount.toFixed(2)} has been confirmed. Your resources are being provisioned.`,
      type: 'success',
      link: '/?tab=billing',
    })

    return NextResponse.json({
      success: true,
      status: 'completed',
      paymentId: updatedPayment.id,
      provisioning: provisionResult,
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
    const verification = await verifyWaafiPayment(transactionId)
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
