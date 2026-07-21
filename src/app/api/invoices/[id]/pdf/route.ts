import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { db } from '@/lib/db'
import { renderInvoicePdf } from '@/lib/pdf'
import { FROM_NAME, BRAND_DOMAIN, BILLING_EMAIL } from '@/lib/brand-config'

/**
 * GET /api/invoices/:id/pdf
 *
 * Downloadable PDF for an invoice. A customer may fetch their OWN invoice;
 * admins may fetch any. The token can come from the Authorization header or a
 * `?token=` query param, because a browser navigating to a download URL can't
 * set headers.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { searchParams } = new URL(request.url)
    const headerToken = extractTokenFromHeader(
      request.headers.get('Authorization')
    )
    const token = headerToken || searchParams.get('token')
    const decoded = token ? verifyToken(token) : null
    if (!decoded) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await context.params
    const invoice = await db.invoice.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true } },
        subscription: { select: { plan: { select: { name: true } } } },
      },
    })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const isAdmin =
      decoded.role === 'admin' || decoded.role === 'super_admin'
    if (!isAdmin && invoice.userId !== decoded.userId) {
      // Don't reveal that the invoice exists to someone it doesn't belong to.
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    let items: Array<{
      description: string
      quantity: number
      unitPrice: number
      total: number
    }> = []
    try {
      const parsed = invoice.items ? JSON.parse(invoice.items) : []
      if (Array.isArray(parsed)) {
        items = parsed.map((i) => ({
          description: String(i?.description ?? 'Item'),
          quantity: Number(i?.quantity ?? 1),
          unitPrice: Number(i?.unitPrice ?? 0),
          total: Number(i?.total ?? 0),
        }))
      }
    } catch {
      items = []
    }
    if (items.length === 0) {
      items = [
        {
          description:
            invoice.subscription?.plan?.name || 'Service',
          quantity: 1,
          unitPrice: invoice.subtotal,
          total: invoice.subtotal,
        },
      ]
    }

    const pdf = renderInvoicePdf({
      number: invoice.number,
      status: invoice.status,
      createdAt: invoice.createdAt,
      dueDate: invoice.dueDate,
      paidAt: invoice.paidAt,
      currency: invoice.currency,
      subtotal: invoice.subtotal,
      discount: invoice.discount || 0,
      couponCode: invoice.couponCode,
      tax: invoice.tax || 0,
      taxName: invoice.taxName,
      creditApplied: invoice.creditApplied || 0,
      total: invoice.total,
      amountPaid: invoice.amountPaid || 0,
      amountRefunded: invoice.amountRefunded || 0,
      notes: invoice.notes,
      items,
      customer: { name: invoice.user?.name, email: invoice.user?.email || '' },
      brand: {
        name: FROM_NAME,
        domain: BRAND_DOMAIN,
        email: BILLING_EMAIL,
      },
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      isCreditNote: invoice.type === 'credit_note',
    })

    // `inline` lets the browser preview (and therefore print) it; add
    // ?download=1 to force a save dialog instead.
    const disposition =
      searchParams.get('download') === '1' ? 'attachment' : 'inline'

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${disposition}; filename="${invoice.number}.pdf"`,
        'Content-Length': String(pdf.length),
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    console.error('[invoices/pdf] failed:', error)
    return NextResponse.json(
      { error: 'Could not generate the PDF' },
      { status: 500 }
    )
  }
}
