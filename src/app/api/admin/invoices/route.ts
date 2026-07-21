import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { markInvoicePaid, nextInvoiceNumber } from '@/lib/invoices'
import { refundInvoice, recordInvoicePayment } from '@/lib/refunds'
import { calculateTax } from '@/lib/tax'
import { createNotification } from '@/lib/notifications'
import { sendEmail } from '@/lib/email'

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
      // A draft isn't owed yet, so it can never be "overdue".
      const overdue =
        (inv.status === 'unpaid' || inv.status === 'partially_paid') &&
        inv.dueDate != null &&
        new Date(inv.dueDate).getTime() < now
      const balanceDue =
        Math.round(
          (inv.total - (inv.creditApplied || 0) - (inv.amountPaid || 0)) * 100
        ) / 100
      return {
        id: inv.id,
        number: inv.number,
        status: overdue ? 'overdue' : inv.status,
        rawStatus: inv.status,
        total: inv.total,
        amountPaid: inv.amountPaid || 0,
        amountRefunded: inv.amountRefunded || 0,
        balanceDue: Math.max(0, balanceDue),
        invoiceType: inv.type || 'standard',
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

    // Outstanding must count the unpaid BALANCE, not the full invoice total —
    // a partially paid invoice only still owes the remainder.
    const outstanding = items
      .filter((i) => i.rawStatus === 'unpaid' || i.rawStatus === 'partially_paid')
      .reduce((sum, i) => sum + (i.balanceDue || 0), 0)
    const refunded = items.reduce((sum, i) => sum + (i.amountRefunded || 0), 0)

    return NextResponse.json({
      invoices: items,
      counts: {
        unpaid: items.filter((i) => i.rawStatus === 'unpaid').length,
        partiallyPaid: items.filter((i) => i.rawStatus === 'partially_paid').length,
        paid: items.filter((i) => i.rawStatus === 'paid').length,
        refunded: items.filter((i) => i.rawStatus === 'refunded').length,
        overdue: items.filter((i) => i.status === 'overdue').length,
        outstandingTotal: Math.round(outstanding * 100) / 100,
        refundedTotal: Math.round(refunded * 100) / 100,
      },
    })
  } catch (error) {
    console.error('[admin/invoices] GET failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/admin/invoices — raise a manual / one-off invoice.
 * Body: { userId, items:[{description,quantity,unitPrice}], currency?,
 *         dueInDays?, notes?, draft? }
 */
export async function POST(request: Request) {
  try {
    const auth = requireAdmin(request)
    if (!auth) {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }
    const body = (await request.json().catch(() => ({}))) as {
      userId?: string
      items?: Array<{ description?: string; quantity?: number; unitPrice?: number }>
      currency?: string
      dueInDays?: number
      notes?: string
      draft?: boolean
    }

    if (!body.userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 })
    }
    const user = await db.user.findUnique({ where: { id: body.userId } })
    if (!user) {
      return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
    }

    const rawItems = Array.isArray(body.items) ? body.items : []
    const items = rawItems
      .map((i) => {
        const quantity = Number(i?.quantity ?? 1) || 1
        const unitPrice = Number(i?.unitPrice ?? 0)
        return {
          description: String(i?.description || 'Item'),
          quantity,
          unitPrice,
          total: Math.round(quantity * unitPrice * 100) / 100,
        }
      })
      .filter((i) => i.total !== 0 || i.description !== 'Item')

    if (items.length === 0) {
      return NextResponse.json(
        { error: 'Add at least one line item' },
        { status: 400 }
      )
    }

    const subtotal =
      Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100
    const taxResult = await calculateTax({ base: subtotal, userId: user.id })
    const total = Math.round((subtotal + taxResult.total) * 100) / 100

    const invoice = await db.invoice.create({
      data: {
        number: await nextInvoiceNumber(),
        userId: user.id,
        type: 'manual',
        items: JSON.stringify(items),
        subtotal,
        tax: taxResult.total,
        taxName: taxResult.label,
        total,
        currency: (body.currency || 'USD').toUpperCase(),
        // A draft is not yet owed by the customer — it stays out of
        // outstanding totals until it's issued.
        status: body.draft ? 'draft' : 'unpaid',
        notes: body.notes || null,
        dueDate: new Date(
          Date.now() + (Number(body.dueInDays) || 7) * 24 * 60 * 60 * 1000
        ),
      },
    })

    if (!body.draft) {
      await createNotification({
        userId: user.id,
        title: 'New invoice',
        message: `Invoice ${invoice.number} for ${invoice.currency} ${invoice.total.toFixed(2)} has been issued.`,
        type: 'info',
        link: '/?tab=billing',
      }).catch(() => {})
    }

    await logAudit({
      userId: auth.decoded.userId,
      action: 'invoice.create',
      resource: 'invoice',
      resourceId: invoice.id,
      req: request,
      metadata: { number: invoice.number, total, draft: body.draft === true },
    }).catch(() => {})

    return NextResponse.json({
      success: true,
      invoice,
      message: `${body.draft ? 'Draft' : 'Invoice'} ${invoice.number} created.`,
    })
  } catch (error) {
    console.error('[admin/invoices] POST failed:', error)
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
      amount?: number
      destination?: 'wallet' | 'gateway'
      gateway?: string
      reference?: string
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

    // ── Refund (full or partial) ─────────────────────────────────────
    if (action === 'refund') {
      const result = await refundInvoice({
        invoiceId: id,
        amount: body.amount,
        destination: body.destination || 'wallet',
        reason: body.note || null,
        adminUserId: auth.decoded.userId,
      })
      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 400 })
      }
      await logAudit({
        userId: auth.decoded.userId,
        action: 'invoice.refund',
        resource: 'invoice',
        resourceId: id,
        req: request,
        metadata: {
          number: invoice.number,
          amount: result.amount,
          destination: result.destination,
          creditNote: result.creditNoteNumber ?? null,
          reason: body.note || null,
        },
      }).catch(() => {})
      return NextResponse.json({
        ...result,
        success: true,
        message:
          result.destination === 'wallet'
            ? `Refunded ${result.amount?.toFixed(2)} to the customer's credit balance${result.creditNoteNumber ? ` (credit note ${result.creditNoteNumber})` : ''}.`
            : `Recorded a ${result.amount?.toFixed(2)} gateway refund${result.creditNoteNumber ? ` (credit note ${result.creditNoteNumber})` : ''}. Issue the actual refund in your payment provider's dashboard.`,
      })
    }

    // ── Record a payment (supports partial) ──────────────────────────
    if (action === 'add_payment') {
      const result = await recordInvoicePayment({
        invoiceId: id,
        amount: Number(body.amount),
        gateway: body.gateway || 'manual',
        reference: body.reference || body.note || null,
        userId: invoice.userId,
        note: body.note || null,
      })
      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 400 })
      }
      await logAudit({
        userId: auth.decoded.userId,
        action: 'invoice.add_payment',
        resource: 'invoice',
        resourceId: id,
        req: request,
        metadata: {
          number: invoice.number,
          amount: body.amount,
          gateway: body.gateway || 'manual',
          fullySettled: result.fullySettled,
        },
      }).catch(() => {})
      return NextResponse.json({
        ...result,
        success: true,
        message: result.fullySettled
          ? `Payment recorded — invoice ${invoice.number} is paid in full.`
          : `Payment recorded — ${result.balanceDue?.toFixed(2)} still due.`,
      })
    }

    // ── Send / resend the invoice by email ───────────────────────────
    if (action === 'send_reminder' || action === 'resend') {
      const customer = await db.user.findUnique({
        where: { id: invoice.userId },
        select: { email: true, name: true },
      })
      if (!customer?.email) {
        return NextResponse.json(
          { error: 'Customer has no email address' },
          { status: 400 }
        )
      }
      const due =
        Math.round(
          (invoice.total - (invoice.creditApplied || 0) - (invoice.amountPaid || 0)) * 100
        ) / 100
      const isReminder = action === 'send_reminder'

      const sent = await sendEmail({
        to: customer.email,
        subject: isReminder
          ? `Reminder: invoice ${invoice.number} is due`
          : `Your invoice ${invoice.number}`,
        html: `<p>Hi ${customer.name || 'there'},</p>
<p>${isReminder ? 'This is a reminder that invoice' : 'Here is your invoice'} <strong>${invoice.number}</strong> for <strong>${invoice.currency} ${invoice.total.toFixed(2)}</strong>${due > 0 ? ` (<strong>${invoice.currency} ${due.toFixed(2)}</strong> still due)` : ''}.</p>
${invoice.dueDate ? `<p>Due date: <strong>${new Date(invoice.dueDate).toDateString()}</strong>.</p>` : ''}
${body.note ? `<p>${body.note}</p>` : ''}
<p>You can view and download it from your billing dashboard.</p>
<p>— Apsamo Technology</p>`,
      }).catch(() => null)

      await createNotification({
        userId: invoice.userId,
        title: isReminder ? 'Invoice reminder' : 'Invoice sent',
        message: `Invoice ${invoice.number} — ${invoice.currency} ${invoice.total.toFixed(2)}${due > 0 ? `, ${due.toFixed(2)} due` : ''}.`,
        type: isReminder ? 'warning' : 'info',
        link: '/?tab=billing',
      }).catch(() => {})

      await logAudit({
        userId: auth.decoded.userId,
        action: `invoice.${action}`,
        resource: 'invoice',
        resourceId: id,
        req: request,
        metadata: { number: invoice.number, to: customer.email },
      }).catch(() => {})

      return NextResponse.json({
        success: true,
        emailed: Boolean(sent),
        message: sent
          ? `Sent to ${customer.email}.`
          : `Recorded, but the email could not be delivered — check the email provider settings.`,
      })
    }

    // ── Issue a draft (make it owed) ─────────────────────────────────
    if (action === 'issue') {
      if (invoice.status !== 'draft') {
        return NextResponse.json(
          { error: 'Only a draft invoice can be issued' },
          { status: 400 }
        )
      }
      await db.invoice.update({ where: { id }, data: { status: 'unpaid' } })
      await createNotification({
        userId: invoice.userId,
        title: 'New invoice',
        message: `Invoice ${invoice.number} for ${invoice.currency} ${invoice.total.toFixed(2)} has been issued.`,
        type: 'info',
        link: '/?tab=billing',
      }).catch(() => {})
      await logAudit({
        userId: auth.decoded.userId,
        action: 'invoice.issue',
        resource: 'invoice',
        resourceId: id,
        req: request,
        metadata: { number: invoice.number },
      }).catch(() => {})
      return NextResponse.json({
        success: true,
        message: `Invoice ${invoice.number} issued.`,
      })
    }

    // ── Duplicate ────────────────────────────────────────────────────
    if (action === 'duplicate') {
      const copy = await db.invoice.create({
        data: {
          number: await nextInvoiceNumber(),
          userId: invoice.userId,
          subscriptionId: invoice.subscriptionId,
          planId: invoice.planId,
          type: 'manual',
          items: invoice.items,
          subtotal: invoice.subtotal,
          discount: invoice.discount,
          tax: invoice.tax,
          taxName: invoice.taxName,
          total: invoice.total,
          currency: invoice.currency,
          status: 'unpaid',
          dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          notes: `Duplicated from ${invoice.number}.`,
        },
      })
      await logAudit({
        userId: auth.decoded.userId,
        action: 'invoice.duplicate',
        resource: 'invoice',
        resourceId: copy.id,
        req: request,
        metadata: { from: invoice.number, to: copy.number },
      }).catch(() => {})
      return NextResponse.json({
        success: true,
        invoice: copy,
        message: `Created ${copy.number} as a copy of ${invoice.number}.`,
      })
    }

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
