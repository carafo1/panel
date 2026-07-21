import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader, requireAdminRole } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { adjustCredit, applyCreditToInvoice, getCreditHistory } from '@/lib/credit'

/** Admin wallet / credit-balance management. */
async function requireAdmin(request: Request): Promise<{
  decoded: { userId: string; email: string; role: string }
} | null> {
  // SECURITY: role comes from the database, not the 7-day token — see
  // verifyTokenFresh. Also rejects suspended/closed accounts.
  const decoded = await requireAdminRole(request)
  return decoded ? { decoded } : null
}

/**
 * GET /api/admin/credit            → customers with a balance
 * GET /api/admin/credit?userId=... → that customer's balance + history
 */
export async function GET(request: Request) {
  try {
    const auth = await requireAdmin(request)
    if (!auth) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }
    const { searchParams } = new URL(request.url)
    const userId = searchParams.get('userId')

    if (userId) {
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true, creditBalance: true },
      })
      if (!user) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 })
      }
      const history = await getCreditHistory(userId, 100)
      return NextResponse.json({ user, history })
    }

    const users = await db.user.findMany({
      where: { creditBalance: { not: 0 } },
      select: { id: true, name: true, email: true, creditBalance: true },
      orderBy: { creditBalance: 'desc' },
      take: 200,
    })
    const totalOutstandingCredit = users.reduce(
      (s, u) => s + (u.creditBalance || 0),
      0
    )
    return NextResponse.json({
      users,
      totalOutstandingCredit: Math.round(totalOutstandingCredit * 100) / 100,
    })
  } catch (error) {
    console.error('[admin/credit] GET failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/admin/credit
 * Body: { userId, amount, description? }          → add/remove credit
 *   or: { invoiceId, action: "apply" }            → spend balance on an invoice
 *
 * A negative `amount` removes credit; the ledger refuses to overdraw.
 */
export async function POST(request: Request) {
  try {
    const auth = await requireAdmin(request)
    if (!auth) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }
    const body = (await request.json().catch(() => ({}))) as {
      userId?: string
      amount?: number
      description?: string
      invoiceId?: string
      action?: string
    }

    // Apply existing balance to an invoice
    if (body.action === 'apply' && body.invoiceId) {
      const result = await applyCreditToInvoice({
        invoiceId: body.invoiceId,
        adminUserId: auth.decoded.userId,
      })
      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 400 })
      }
      await logAudit({
        userId: auth.decoded.userId,
        action: 'credit.apply',
        resource: 'invoice',
        resourceId: body.invoiceId,
        req: request,
        metadata: { applied: result.applied },
      }).catch(() => {})
      return NextResponse.json({
        success: true,
        applied: result.applied,
        balance: result.balance,
        message: result.applied
          ? `Applied ${result.applied.toFixed(2)} from the customer's balance.`
          : 'Customer has no balance to apply.',
      })
    }

    // Add / remove credit
    if (!body.userId || body.amount === undefined) {
      return NextResponse.json(
        { error: 'userId and amount are required' },
        { status: 400 }
      )
    }
    const amount = Number(body.amount)
    const result = await adjustCredit({
      userId: body.userId,
      amount,
      type: amount > 0 ? 'topup' : 'adjustment',
      description: body.description || (amount > 0 ? 'Admin credit' : 'Admin deduction'),
      adminUserId: auth.decoded.userId,
    })
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    await logAudit({
      userId: auth.decoded.userId,
      action: amount > 0 ? 'credit.add' : 'credit.remove',
      resource: 'user',
      resourceId: body.userId,
      req: request,
      metadata: { amount, balance: result.balance, note: body.description || null },
    }).catch(() => {})

    return NextResponse.json({
      success: true,
      balance: result.balance,
      message: `Balance is now ${(result.balance ?? 0).toFixed(2)}.`,
    })
  } catch (error) {
    console.error('[admin/credit] POST failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
