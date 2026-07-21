import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { db } from '@/lib/db'
import { getCreditHistory } from '@/lib/credit'

/**
 * Everything billing-related for one customer, in one call: subscriptions,
 * invoices, payments, wallet balance + history, lifetime value and what they
 * currently owe.
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

function round2(n: number) {
  return Math.round(n * 100) / 100
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = requireAdmin(request)
    if (!auth) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }
    const { id } = await context.params

    const user = await db.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        creditBalance: true,
        taxExempt: true,
        taxCountry: true,
      },
    })
    if (!user) {
      return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
    }

    const [subscriptions, invoices, payments, creditHistory] = await Promise.all([
      db.subscription.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        include: { plan: { select: { name: true, price: true, billingCycle: true } } },
      }),
      db.invoice.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      db.payment.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      getCreditHistory(id, 50),
    ])

    const paid = invoices.filter((i) => i.status === 'paid')
    const unpaid = invoices.filter((i) => i.status === 'unpaid')
    const lifetimeValue = round2(paid.reduce((s, i) => s + (i.total || 0), 0))
    const outstanding = round2(unpaid.reduce((s, i) => s + (i.total || 0), 0))

    return NextResponse.json({
      customer: user,
      summary: {
        lifetimeValue,
        outstanding,
        creditBalance: round2(user.creditBalance || 0),
        invoiceCount: invoices.length,
        paidCount: paid.length,
        unpaidCount: unpaid.length,
        activeSubscriptions: subscriptions.filter((s) => s.status === 'active').length,
      },
      subscriptions: subscriptions.map((s) => ({
        id: s.id,
        status: s.status,
        planName: s.plan?.name || null,
        price: s.plan?.price ?? null,
        billingCycle: (s.plan as { billingCycle?: string })?.billingCycle || null,
        currentPeriodEnd: s.currentPeriodEnd,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      })),
      invoices: invoices.map((i) => ({
        id: i.id,
        number: i.number,
        status: i.status,
        total: i.total,
        discount: i.discount,
        tax: i.tax,
        creditApplied: i.creditApplied,
        currency: i.currency,
        dueDate: i.dueDate,
        paidAt: i.paidAt,
        createdAt: i.createdAt,
      })),
      payments: payments.map((p) => ({
        id: p.id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        method: p.method,
        transactionId: p.transactionId,
        createdAt: p.createdAt,
      })),
      creditHistory,
    })
  } catch (error) {
    console.error('[admin/customers/billing] GET failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
