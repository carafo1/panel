/**
 * POST /api/admin/provisioning/:paymentId/retry
 *
 * Re-run provisioning for a confirmed payment that is 'failed',
 * 'manual_review' or 'retry_pending' (or was never started). The payment is
 * put back to 'retry_pending' with a fresh attempt budget and provisioned
 * immediately through the normal atomic claim.
 *
 * Refused (409 REGISTRAR_RECONCILIATION_REQUIRED) while the payment's domain
 * order shows a registrar call with no confirmed outcome — retrying could buy
 * the domain twice — unless the body says { "confirmRegistrarReconciled": true },
 * meaning the admin has checked the registrar account and nothing was
 * registered. An order still marked 'processing' must be resolved on the
 * domain-order side first; this route never changes domain orders.
 *
 * Admin only (admin / super_admin, role re-read from the database).
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdminRole } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { provisionForPayment } from '@/lib/provision-on-payment'

const RETRYABLE = ['failed', 'manual_review', 'retry_pending']

export async function POST(
  request: Request,
  ctx: { params: Promise<{ paymentId: string }> }
) {
  const auth = await requireAdminRole(request)
  if (!auth) {
    const hasCredentials =
      !!request.headers.get('Authorization') || !!request.headers.get('x-api-key')
    return hasCredentials
      ? NextResponse.json({ error: 'Admin access required' }, { status: 403 })
      : NextResponse.json({ error: 'Authorization token required' }, { status: 401 })
  }

  const { paymentId } = await ctx.params
  if (typeof paymentId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(paymentId)) {
    return NextResponse.json({ error: 'Invalid payment id' }, { status: 400 })
  }

  let body: Record<string, unknown> = {}
  try {
    const text = await request.text()
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {}
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (
    body.confirmRegistrarReconciled !== undefined &&
    typeof body.confirmRegistrarReconciled !== 'boolean'
  ) {
    return NextResponse.json(
      { error: 'confirmRegistrarReconciled must be a boolean' },
      { status: 400 }
    )
  }
  const confirmed = body.confirmRegistrarReconciled === true

  const payment = await db.payment.findUnique({ where: { id: paymentId } })
  if (!payment) return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
  if (payment.status !== 'completed') {
    return NextResponse.json(
      { error: `Payment is ${payment.status}; only a confirmed payment is provisioned` },
      { status: 409 }
    )
  }

  const neverStarted = payment.provisionStatus === 'none' && !payment.provisionClaimedAt
  if (!neverStarted && !RETRYABLE.includes(payment.provisionStatus)) {
    return NextResponse.json(
      {
        error: `Provisioning is ${payment.provisionStatus}; nothing to retry`,
        code: 'NOT_RETRYABLE',
      },
      { status: 409 }
    )
  }

  let meta: Record<string, unknown> = {}
  try {
    meta = payment.metadata ? JSON.parse(payment.metadata) : {}
  } catch {
    meta = {}
  }
  const domainOrderId =
    typeof meta.domainOrderId === 'string' && meta.domainOrderId ? meta.domainOrderId : null
  if (domainOrderId) {
    const order = await db.domainOrder.findUnique({
      where: { id: domainOrderId },
      select: { status: true, registrarCalledAt: true, registrarConfirmedAt: true },
    })
    if (order?.status === 'processing') {
      return NextResponse.json(
        {
          error:
            'The domain order is still marked processing. Reconcile it with the registrar on the domain-order side first.',
          code: 'DOMAIN_ORDER_PROCESSING',
        },
        { status: 409 }
      )
    }
    if (order && order.registrarCalledAt && !order.registrarConfirmedAt && !confirmed) {
      return NextResponse.json(
        {
          error:
            'The registrar was called for this order and its outcome was never confirmed. Check the registrar account; retry only with confirmRegistrarReconciled=true once you are sure nothing was registered.',
          code: 'REGISTRAR_RECONCILIATION_REQUIRED',
        },
        { status: 409 }
      )
    }
  }

  if (!neverStarted) {
    // Conditional, so a concurrent sweep / second click cannot both reset it.
    const reset = await db.payment.updateMany({
      where: { id: payment.id, provisionStatus: payment.provisionStatus },
      data: { provisionStatus: 'retry_pending', provisionAttempts: 0, provisionLeaseUntil: null },
    })
    if (reset.count !== 1) {
      return NextResponse.json(
        { error: 'Provisioning state changed meanwhile; reload and try again' },
        { status: 409 }
      )
    }
  }

  await logAudit({
    userId: auth.userId,
    action: 'provisioning.retry',
    resource: 'payment',
    resourceId: payment.id,
    req: request,
    metadata: {
      from: payment.provisionStatus,
      registrarReconciledConfirmed: confirmed,
      domainOrderId,
    },
  })

  const result = await provisionForPayment(payment.id, { registrarReconciled: confirmed })
  return NextResponse.json({
    paymentId: payment.id,
    provisioned: result.provisioned,
    status: result.status ?? null,
    detail: result.detail,
    projectId: result.projectId ?? null,
  })
}
