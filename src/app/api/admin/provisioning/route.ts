/**
 * GET  /api/admin/provisioning  — paid orders whose provisioning needs a human
 *                                 (failed / manual_review / retry_pending),
 *                                 plus the reconcile report and the last
 *                                 container / certificate / registrar check.
 * POST /api/admin/provisioning  — run the reconcile now (sweep + report) and
 *                                 return its summary. Same work the worker
 *                                 does hourly; idempotent.
 *
 * Admin only (admin / super_admin, role re-read from the database).
 */
import { NextResponse } from 'next/server'
import { requireAdminRole } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { reconcileReport, runReconcile } from '@/lib/reconcile'
import { lastInfraReport } from '@/lib/infra-reconcile'

function denied(request: Request) {
  const hasCredentials =
    !!request.headers.get('Authorization') || !!request.headers.get('x-api-key')
  return hasCredentials
    ? NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    : NextResponse.json({ error: 'Authorization token required' }, { status: 401 })
}

export async function GET(request: Request) {
  const auth = await requireAdminRole(request)
  if (!auth) return denied(request)
  try {
    const [report, infra] = await Promise.all([reconcileReport(), lastInfraReport()])
    return NextResponse.json({ ...report, infra })
  } catch (err) {
    console.error('[admin/provisioning] report failed:', err)
    return NextResponse.json({ error: 'Could not build the provisioning report' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const auth = await requireAdminRole(request)
  if (!auth) return denied(request)
  try {
    const summary = await runReconcile()
    await logAudit({
      userId: auth.userId,
      action: 'provisioning.reconcile',
      resource: 'payment',
      req: request,
      metadata: {
        swept: summary.sweep.examined,
        needingAttention: summary.payments.length,
        domainOrders: summary.domainOrders.length,
        containersMissing: summary.infra.containers.missing.length,
        certsNotServed: summary.infra.certificates.notServed.length,
      },
    })
    return NextResponse.json(summary)
  } catch (err) {
    console.error('[admin/provisioning] reconcile failed:', err)
    return NextResponse.json({ error: 'Reconcile failed' }, { status: 500 })
  }
}
