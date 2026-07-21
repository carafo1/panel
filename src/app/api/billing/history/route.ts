import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const payments = await db.payment.findMany({
      where: { userId: decoded.userId },
      include: {
        subscription: {
          include: { plan: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      payments: payments.map((p) => {
        let metadata: Record<string, unknown> | null = null
        try {
          metadata = p.metadata ? JSON.parse(p.metadata) : null
        } catch {
          metadata = null
        }
        return {
          id: p.id,
          amount: p.amount,
          currency: p.currency,
          status: p.status, // pending, completed, failed, refunded
          type: p.type,
          stripePaymentId: p.stripePaymentId,
          stripeInvoiceId: p.stripeInvoiceId,
          metadata,
          createdAt: p.createdAt,
          plan: p.subscription?.plan || null,
        }
      }),
    })
  } catch (error) {
    console.error('Payment history error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
