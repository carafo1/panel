/**
 * GET /api/domains/orders
 *
 * The signed-in customer's own domain orders, newest first. Orders exist long
 * before a Domain row does (awaiting payment, registering, held for review,
 * transfer in progress, failed), so this is the only place a customer can see
 * them.
 *
 * Query:
 *   limit   1–50 (default 20)
 *   cursor  id of the last order from the previous page
 *
 * Response: { orders: DomainOrderView[], nextCursor: string | null }
 *
 * Always scoped to the caller's userId, admins included: support views of
 * other customers' orders live under /api/admin.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { withRateLimit } from '@/lib/rate-limit'
import { toOrderView, orderPaymentId, type PaymentRow } from './order-view'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

function parseLimit(raw: string | null): number {
  const n = raw === null ? DEFAULT_LIMIT : Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}

async function getHandler(request: Request) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const userId = decoded.userId

    const { searchParams } = new URL(request.url)
    const limit = parseLimit(searchParams.get('limit'))
    const cursor = searchParams.get('cursor')?.trim() || null

    // A cursor must be one of the caller's own orders. Prisma positions a
    // cursor by the referenced row even when the where clause excludes it, so
    // accepting a foreign id would let a caller probe another account.
    if (cursor) {
      const owned = await db.domainOrder.findFirst({
        where: { id: cursor, userId },
        select: { id: true },
      })
      if (!owned) {
        return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
      }
    }

    const rows = await db.domainOrder.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        domainName: true,
        type: true,
        duration: true,
        status: true,
        totalAmount: true,
        currency: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
        domain: { select: { id: true, status: true, userId: true } },
        invoices: {
          where: { userId },
          select: {
            id: true,
            number: true,
            status: true,
            type: true,
            total: true,
            amountPaid: true,
            createdAt: true,
          },
        },
      },
    })

    const page = rows.slice(0, limit)
    const nextCursor = rows.length > limit ? page[page.length - 1]?.id ?? null : null

    // Payment rows only matter for orders still awaiting payment: they carry
    // the gateway link or the bank-transfer reference.
    const paymentIds = page
      .filter((o) => o.status === 'pending_payment')
      .map((o) => orderPaymentId(o))
      .filter((id): id is string => Boolean(id))
    const payments: PaymentRow[] = paymentIds.length
      ? await db.payment.findMany({
          where: { id: { in: paymentIds }, userId },
          select: { id: true, method: true, status: true, createdAt: true, metadata: true },
        })
      : []
    const paymentsById = new Map(payments.map((p) => [p.id, p]))

    const now = Date.now()
    return NextResponse.json({
      orders: page.map((o) => toOrderView(o, userId, paymentsById, now)),
      nextCursor,
    })
  } catch (error) {
    console.error('List domain orders error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export const GET = withRateLimit(getHandler, { limit: 60, windowMs: 60_000 })
