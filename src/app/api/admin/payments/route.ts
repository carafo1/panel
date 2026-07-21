import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader, requireAdminRole } from '@/lib/auth'
import { db } from '@/lib/db'

/**
 * Admin payments list.
 *
 * Needed because offline/bank-transfer payments require a human to verify
 * the money arrived. Without this the admin has no view of who has paid.
 */
async function requireAdmin(request: Request): Promise<{
  decoded: { userId: string; email: string; role: string }
} | null> {
  // SECURITY: role comes from the database, not the 7-day token — see
  // verifyTokenFresh. Also rejects suspended/closed accounts.
  const decoded = await requireAdminRole(request)
  return decoded ? { decoded } : null
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * GET /api/admin/payments?status=pending&method=manual&limit=100
 *
 * Returns payments newest-first with the customer and plan attached so the
 * admin can match a bank transfer to an account.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireAdmin(request)
    if (!auth) {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const method = searchParams.get('method')
    const limit = Math.min(Number(searchParams.get('limit')) || 100, 500)

    const payments = await db.payment.findMany({
      where: {
        ...(status && status !== 'all' ? { status } : {}),
        ...(method && method !== 'all' ? { method } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        user: { select: { id: true, name: true, email: true } },
        subscription: {
          select: {
            id: true,
            status: true,
            currentPeriodEnd: true,
            plan: { select: { id: true, name: true } },
          },
        },
      },
    })

    const items = payments.map((p) => {
      const meta = parseMeta(p.metadata)
      return {
        id: p.id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        type: p.type,
        method: p.method,
        transactionId: p.transactionId,
        createdAt: p.createdAt,
        user: p.user,
        subscription: p.subscription,
        // Surfaced so the admin can verify against their bank statement.
        reference: (meta.manualReference as string) || p.transactionId || null,
        planName: (meta.planName as string) || p.subscription?.plan?.name || null,
        purchaseType: (meta.purchaseType as string) || p.type,
        domainName: (meta.domainName as string) || null,
        adminConfirmed: Boolean(meta.adminConfirmed),
        confirmedByEmail: (meta.confirmedByEmail as string) || null,
        confirmedAt: (meta.confirmedAt as string) || null,
        confirmationNote: (meta.confirmationNote as string) || null,
        rejectionReason: (meta.rejectionReason as string) || null,
      }
    })

    const counts = {
      pending: items.filter((i) => i.status === 'pending').length,
      completed: items.filter((i) => i.status === 'completed').length,
      failed: items.filter((i) => i.status === 'failed').length,
    }

    return NextResponse.json({ payments: items, counts })
  } catch (error) {
    console.error('[admin/payments] GET failed:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
