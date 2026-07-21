import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { markInvoicePaid } from '@/lib/invoices'

/**
 * Admin invoice management.
 *
 * With offline payments the admin settles invoices by hand, so they need to
 * see who owes what and be able to mark an invoice paid, void it, or add a note.
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

/** GET /api/admin/invoices?status=unpaid */
export async function GET(request: Request) {
  try {
    const auth = requireAdmin(request)
    if (!auth) {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const limit = Math.min(Number(searchParams.get('limit')) || 100, 500)

    const invoices = await db.invoice.findMany({
      where: status && status !== 'all' ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        user: { select: { id: true, name: true, email: true } },
        domain: { select: { name: true } },
        subscription: {
          select: { id: true, status: true, plan: { select: { name: true } } },
        },
      },
    })

    const now = Date.now()
    const items = invoices.map((inv) => {
      let parsed: unknown[] = []
      try {
        parsed = inv.items ? JSON.parse(inv.items) : []
      } catch {
        parsed = []
      }
      const overdue =
        inv.status === 'unpaid' &&
        inv.dueDate != null &&
        new Date(inv.dueDate).getTime() < now
      return {
        id: inv.id,
        number: inv.number,
        status: overdue ? 'overdue' : inv.status,
        rawStatus: inv.status,
        total: inv.total,
        subtotal: inv.subtotal,
        tax: inv.tax,
        currency: inv.currency,
        items: parsed,
        notes: inv.notes,
        createdAt: inv.createdAt,
        dueDate: inv.dueDate,
        paidAt: inv.paidAt,
        periodStart: inv.periodStart,
        periodEnd: inv.periodEnd,
        user: inv.user,
        planName: inv.subscription?.plan?.name || null,
        domainName: inv.domain?.name || null,
        type: inv.subscriptionId ? 'subscription' : inv.domainId ? 'domain' : 'other',
      }
    })

    const outstanding = items
      .filter((i) => i.rawStatus === 'unpaid')
      .reduce((sum, i) => sum + (i.total || 0), 0)

    return NextResponse.json({
      invoices: items,
      counts: {
        unpaid: items.filter((i) => i.rawStatus === 'unpaid').length,
        paid: items.filter((i) => i.rawStatus === 'paid').length,
        overdue: items.filter((i) => i.status === 'overdue').length,
        outstandingTotal: Math.round(outstanding * 100) / 100,
      },
    })
  } catch (error) {
    console.error('[admin/invoices] GET failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * PATCH /api/admin/invoices
 * Body: { id, action: "mark_paid" | "mark_unpaid" | "void" | "note", note? }
 */
export async function PATCH(request: Request) {
  try {
    const auth = requireAdmin(request)
    if (!auth) {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }
    const body = (await request.json().catch(() => ({}))) as {
      id?: string
      action?: string
      note?: string
    }
    const id = body.id
    const action = (body.action || '').toLowerCase()
    if (!id || !action) {
      return NextResponse.json(
        { error: 'id and action are required' },
        { status: 400 }
      )
    }

    const invoice = await db.invoice.findUnique({ where: { id } })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    let message = ''
    if (action === 'mark_paid') {
      await markInvoicePaid(id, {
        gateway: 'manual',
        reference: body.note || 'marked paid by admin',
        userId: invoice.userId,
      })
      message = `Invoice ${invoice.number} marked paid.`
    } else if (action === 'mark_unpaid') {
      await db.invoice.update({
        where: { id },
        data: { status: 'unpaid', paidAt: null },
      })
      message = `Invoice ${invoice.number} reopened as unpaid.`
    } else if (action === 'void') {
      if (invoice.status === 'paid') {
        return NextResponse.json(
          { error: 'A paid invoice cannot be voided — refund it instead.' },
          { status: 400 }
        )
      }
      await db.invoice.update({ where: { id }, data: { status: 'void' } })
      message = `Invoice ${invoice.number} voided.`
    } else if (action === 'note') {
      await db.invoice.update({
        where: { id },
        data: { notes: body.note || null },
      })
      message = 'Note saved.'
    } else {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }

    await logAudit({
      userId: auth.decoded.userId,
      action: `invoice.${action}`,
      resource: 'invoice',
      resourceId: id,
      req: request,
      metadata: { number: invoice.number, note: body.note || null },
    }).catch(() => {})

    return NextResponse.json({ success: true, message })
  } catch (error) {
    console.error('[admin/invoices] PATCH failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
