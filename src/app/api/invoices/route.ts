/**
 * GET /api/invoices
 * Lists invoices for the authenticated user (or all invoices for admin).
 * Query: ?status=paid&limit=50
 */
import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db'
import { ok, apiError } from '@/lib/api-response'

export async function GET(request: Request) {
  const user = await authenticateRequest(request)
  if (!user) return apiError.unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200)

    const where: Record<string, unknown> = {}
    if (status) where.status = status
    if (user.role !== 'super_admin') where.userId = user.userId

    const invoices = await db.invoice.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { domain: { select: { name: true } } },
    })

    return ok(
      invoices.map((inv) => ({
        id: inv.id,
        number: inv.number,
        domainName: inv.domain?.name || null,
        items: inv.items ? JSON.parse(inv.items) : [],
        subtotal: inv.subtotal,
        tax: inv.tax,
        total: inv.total,
        currency: inv.currency,
        status: inv.status,
        paidAt: inv.paidAt?.toISOString(),
        createdAt: inv.createdAt.toISOString(),
        dueDate: inv.dueDate?.toISOString(),
      })),
      `Retrieved ${invoices.length} invoices`
    )
  } catch (error) {
    console.error('[invoices GET] error:', error)
    return apiError.serverError()
  }
}
