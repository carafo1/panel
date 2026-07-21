/**
 * Minimal PDF writer (no dependencies).
 *
 * A one-page invoice needs only text, lines and a standard font, all of which
 * PDF 1.4 supports directly — so rather than pull in a PDF library (and risk
 * the production build on a box with restricted egress) this emits the file
 * format by hand.
 *
 * Structure produced:
 *   1 Catalog → 2 Pages → 3 Page → 4 Contents (stream) → 5/6 Fonts
 * followed by a byte-accurate xref table and trailer.
 */

const PAGE_W = 595.28 // A4 @ 72dpi
const PAGE_H = 841.89

/** Escape the three characters that are special inside a PDF string. */
function esc(s: string): string {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    // PDF strings are byte-oriented; drop anything outside Latin-1 rather
    // than emitting bytes the standard fonts can't map.
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '')
}

export class PdfBuilder {
  private ops: string[] = []

  /** Draw text. `font` 'R' = Helvetica, 'B' = Helvetica-Bold. */
  text(
    x: number,
    y: number,
    value: string,
    opts: { size?: number; font?: 'R' | 'B'; gray?: number } = {}
  ): this {
    const size = opts.size ?? 10
    const font = opts.font === 'B' ? '/F2' : '/F1'
    const gray = opts.gray ?? 0
    this.ops.push(
      `q ${gray} g BT ${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${(PAGE_H - y).toFixed(2)} Tm (${esc(value)}) Tj ET Q`
    )
    return this
  }

  /** Right-aligned text — approximates width from the font metrics. */
  textRight(
    xRight: number,
    y: number,
    value: string,
    opts: { size?: number; font?: 'R' | 'B'; gray?: number } = {}
  ): this {
    const size = opts.size ?? 10
    // Helvetica averages ~0.5em per char; bold a touch wider.
    const w = String(value).length * size * (opts.font === 'B' ? 0.56 : 0.5)
    return this.text(xRight - w, y, value, opts)
  }

  line(x1: number, y1: number, x2: number, y2: number, gray = 0.8): this {
    this.ops.push(
      `q ${gray} G 0.7 w ${x1.toFixed(2)} ${(PAGE_H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(PAGE_H - y2).toFixed(2)} l S Q`
    )
    return this
  }

  rect(x: number, y: number, w: number, h: number, gray = 0.95): this {
    this.ops.push(
      `q ${gray} rg ${x.toFixed(2)} ${(PAGE_H - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f Q`
    )
    return this
  }

  /** Serialise to a complete PDF file. */
  build(): Buffer {
    const content = this.ops.join('\n')
    const objects: string[] = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    ]

    let out = '%PDF-1.4\n'
    const offsets: number[] = []
    objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'))
      out += `${i + 1} 0 obj\n${body}\nendobj\n`
    })

    const xrefPos = Buffer.byteLength(out, 'latin1')
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    for (const off of offsets) {
      out += `${String(off).padStart(10, '0')} 00000 n \n`
    }
    out +=
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${xrefPos}\n%%EOF\n`

    return Buffer.from(out, 'latin1')
  }
}

export interface InvoicePdfData {
  number: string
  status: string
  createdAt: Date
  dueDate?: Date | null
  paidAt?: Date | null
  currency: string
  subtotal: number
  discount: number
  couponCode?: string | null
  tax: number
  taxName?: string | null
  creditApplied: number
  total: number
  amountPaid: number
  amountRefunded: number
  notes?: string | null
  items: Array<{
    description: string
    quantity: number
    unitPrice: number
    total: number
  }>
  customer: { name?: string | null; email: string }
  brand: { name: string; domain: string; email?: string | null }
  periodStart?: Date | null
  periodEnd?: Date | null
  isCreditNote?: boolean
}

function money(n: number, currency: string) {
  const v = Number(n || 0)
  return `${currency} ${v.toFixed(2)}`
}

/** Render an invoice to a PDF buffer. */
export function renderInvoicePdf(d: InvoicePdfData): Buffer {
  const p = new PdfBuilder()
  const L = 50 // left margin
  const R = PAGE_W - 50 // right edge
  let y = 60

  // ── Header ────────────────────────────────────────────────────────
  p.text(L, y, d.brand.name, { size: 20, font: 'B' })
  p.textRight(R, y, d.isCreditNote ? 'CREDIT NOTE' : 'INVOICE', {
    size: 20,
    font: 'B',
    gray: 0.35,
  })
  y += 16
  p.text(L, y, d.brand.domain, { size: 9, gray: 0.45 })
  p.textRight(R, y, d.number, { size: 10, font: 'B' })
  y += 12
  if (d.brand.email) p.text(L, y, d.brand.email, { size: 9, gray: 0.45 })
  p.textRight(R, y, `Status: ${d.status.toUpperCase()}`, { size: 9, gray: 0.45 })

  y += 24
  p.line(L, y, R, y)
  y += 22

  // ── Bill to / dates ───────────────────────────────────────────────
  p.text(L, y, 'BILL TO', { size: 8, font: 'B', gray: 0.45 })
  p.textRight(R, y, 'DETAILS', { size: 8, font: 'B', gray: 0.45 })
  y += 14
  p.text(L, y, d.customer.name || d.customer.email, { size: 10, font: 'B' })
  p.textRight(R, y, `Issued: ${d.createdAt.toDateString()}`, { size: 9 })
  y += 13
  if (d.customer.name) {
    p.text(L, y, d.customer.email, { size: 9, gray: 0.4 })
  }
  if (d.dueDate) {
    p.textRight(R, y, `Due: ${d.dueDate.toDateString()}`, { size: 9 })
  }
  y += 13
  if (d.paidAt) {
    p.textRight(R, y, `Paid: ${d.paidAt.toDateString()}`, { size: 9 })
  }
  if (d.periodStart && d.periodEnd) {
    p.text(L, y, `Period: ${d.periodStart.toDateString()} – ${d.periodEnd.toDateString()}`, {
      size: 9,
      gray: 0.4,
    })
  }

  // ── Line items ────────────────────────────────────────────────────
  y += 28
  p.rect(L, y - 10, R - L, 20, 0.94)
  p.text(L + 6, y + 4, 'DESCRIPTION', { size: 8, font: 'B', gray: 0.35 })
  p.textRight(R - 150, y + 4, 'QTY', { size: 8, font: 'B', gray: 0.35 })
  p.textRight(R - 80, y + 4, 'UNIT', { size: 8, font: 'B', gray: 0.35 })
  p.textRight(R - 6, y + 4, 'AMOUNT', { size: 8, font: 'B', gray: 0.35 })
  y += 24

  for (const item of d.items.slice(0, 20)) {
    // Keep the description inside the column rather than overrunning QTY.
    const desc =
      item.description.length > 58
        ? item.description.slice(0, 55) + '…'
        : item.description
    p.text(L + 6, y, desc, { size: 9 })
    p.textRight(R - 150, y, String(item.quantity), { size: 9 })
    p.textRight(R - 80, y, money(item.unitPrice, d.currency), { size: 9 })
    p.textRight(R - 6, y, money(item.total, d.currency), { size: 9 })
    y += 16
    p.line(L, y - 5, R, y - 5, 0.92)
  }

  // ── Totals ────────────────────────────────────────────────────────
  y += 10
  const tl = R - 200
  const row = (label: string, value: string, bold = false, gray = 0) => {
    p.text(tl, y, label, { size: 9, font: bold ? 'B' : 'R', gray })
    p.textRight(R - 6, y, value, { size: 9, font: bold ? 'B' : 'R', gray })
    y += 15
  }

  row('Subtotal', money(d.subtotal, d.currency))
  if (d.discount > 0) {
    row(
      `Discount${d.couponCode ? ` (${d.couponCode})` : ''}`,
      `-${money(d.discount, d.currency)}`
    )
  }
  if (d.tax > 0) row(d.taxName || 'Tax', money(d.tax, d.currency))
  if (d.creditApplied > 0) {
    row('Account credit', `-${money(d.creditApplied, d.currency)}`)
  }

  p.line(tl, y - 4, R, y - 4, 0.6)
  y += 6
  row('TOTAL', money(d.total, d.currency), true)

  if (d.amountPaid > 0) row('Paid', `-${money(d.amountPaid, d.currency)}`, false, 0.4)
  if (d.amountRefunded > 0) {
    row('Refunded', money(d.amountRefunded, d.currency), false, 0.4)
  }

  const due =
    Math.round((d.total - d.creditApplied - d.amountPaid) * 100) / 100
  if (due > 0.009) {
    y += 4
    row('BALANCE DUE', money(due, d.currency), true)
  }

  // ── Notes / footer ────────────────────────────────────────────────
  if (d.notes) {
    y += 20
    p.text(L, y, 'NOTES', { size: 8, font: 'B', gray: 0.45 })
    y += 13
    // Wrap manually — there's no text layout engine here.
    const words = d.notes.split(/\s+/)
    let lineBuf = ''
    for (const w of words) {
      if ((lineBuf + ' ' + w).trim().length > 95) {
        p.text(L, y, lineBuf.trim(), { size: 9, gray: 0.3 })
        y += 12
        lineBuf = w
      } else {
        lineBuf += ' ' + w
      }
    }
    if (lineBuf.trim()) p.text(L, y, lineBuf.trim(), { size: 9, gray: 0.3 })
  }

  p.line(L, PAGE_H - 70, R, PAGE_H - 70, 0.85)
  p.text(L, PAGE_H - 55, `${d.brand.name} — ${d.brand.domain}`, {
    size: 8,
    gray: 0.5,
  })
  p.textRight(R, PAGE_H - 55, `Invoice ${d.number}`, { size: 8, gray: 0.5 })

  return p.build()
}
