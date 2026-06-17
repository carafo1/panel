/**
 * GET /api/invoices/:id
 * Returns a single invoice with full details (for receipt download).
 */
import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db'
import { ok, apiError } from '@/lib/api-response'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await authenticateRequest(request)
  if (!user) return apiError.unauthorized()

  const { id } = await params
  try {
    const invoice = await db.invoice.findUnique({
      where: { id },
      include: {
        domain: { select: { name: true } },
        order: { select: { type: true, duration: true, domainName: true } },
        user: { select: { name: true, email: true } },
        transactions: true,
      },
    })

    if (!invoice) return apiError.notFound('Invoice not found')
    if (invoice.userId !== user.userId && user.role !== 'super_admin') {
      return apiError.forbidden()
    }

    return ok(
      {
        id: invoice.id,
        number: invoice.number,
        status: invoice.status,
        currency: invoice.currency,
        subtotal: invoice.subtotal,
        tax: invoice.tax,
        total: invoice.total,
        items: invoice.items ? JSON.parse(invoice.items) : [],
        paidAt: invoice.paidAt?.toISOString(),
        dueDate: invoice.dueDate?.toISOString(),
        createdAt: invoice.createdAt.toISOString(),
        customer: { name: invoice.user.name, email: invoice.user.email },
        domain: invoice.domain?.name || null,
        order: invoice.order,
        transactions: invoice.transactions.map((t) => ({
          id: t.id,
          gateway: t.gateway,
          amount: t.amount,
          status: t.status,
          reference: t.reference,
          createdAt: t.createdAt.toISOString(),
        })),
      },
      `Invoice ${invoice.number}`
    )
  } catch (error) {
    console.error('[invoices/:id GET] error:', error)
    return apiError.serverError()
  }
}
