import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'

/** Admin tax-rate management (VAT / GST / sales tax, regional + compound). */
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

/** GET /api/admin/tax-rates */
export async function GET(request: Request) {
  try {
    const auth = requireAdmin(request)
    if (!auth) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }
    const rates = await db.taxRate.findMany({
      orderBy: [{ priority: 'asc' }, { name: 'asc' }],
    })
    return NextResponse.json({ rates })
  } catch (error) {
    console.error('[admin/tax-rates] GET failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/** POST /api/admin/tax-rates */
export async function POST(request: Request) {
  try {
    const auth = requireAdmin(request)
    if (!auth) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const name = String(body.name || '').trim()
    if (!name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }
    const rate = Number(body.rate)
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      return NextResponse.json(
        { error: 'rate must be a percentage between 0 and 100' },
        { status: 400 }
      )
    }

    const created = await db.taxRate.create({
      data: {
        name,
        rate,
        country: body.country
          ? String(body.country).trim().toUpperCase()
          : null,
        region: body.region ? String(body.region).trim() : null,
        active: body.active !== false,
        priority: Number(body.priority) || 0,
        compound: body.compound === true,
      },
    })

    await logAudit({
      userId: auth.decoded.userId,
      action: 'tax_rate.create',
      resource: 'tax_rate',
      resourceId: created.id,
      req: request,
      metadata: { name, rate, country: created.country },
    }).catch(() => {})

    return NextResponse.json({ success: true, rate: created })
  } catch (error) {
    console.error('[admin/tax-rates] POST failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/** PATCH /api/admin/tax-rates — { id, ...fields } or { id, delete: true } */
export async function PATCH(request: Request) {
  try {
    const auth = requireAdmin(request)
    if (!auth) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const id = String(body.id || '')
    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }
    const existing = await db.taxRate.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Tax rate not found' }, { status: 404 })
    }

    if (body.delete === true) {
      await db.taxRate.delete({ where: { id } })
      await logAudit({
        userId: auth.decoded.userId,
        action: 'tax_rate.delete',
        resource: 'tax_rate',
        resourceId: id,
        req: request,
        metadata: { name: existing.name },
      }).catch(() => {})
      return NextResponse.json({ success: true, message: 'Tax rate deleted.' })
    }

    const data: Record<string, unknown> = {}
    if (body.name !== undefined) data.name = String(body.name)
    if (body.rate !== undefined) {
      const r = Number(body.rate)
      if (!Number.isFinite(r) || r < 0 || r > 100) {
        return NextResponse.json({ error: 'Invalid rate' }, { status: 400 })
      }
      data.rate = r
    }
    if (body.country !== undefined)
      data.country = body.country ? String(body.country).toUpperCase() : null
    if (body.region !== undefined)
      data.region = body.region ? String(body.region) : null
    if (body.active !== undefined) data.active = body.active === true
    if (body.compound !== undefined) data.compound = body.compound === true
    if (body.priority !== undefined) data.priority = Number(body.priority) || 0

    const updated = await db.taxRate.update({ where: { id }, data })
    await logAudit({
      userId: auth.decoded.userId,
      action: 'tax_rate.update',
      resource: 'tax_rate',
      resourceId: id,
      req: request,
      metadata: { fields: Object.keys(data) },
    }).catch(() => {})

    return NextResponse.json({ success: true, rate: updated })
  } catch (error) {
    console.error('[admin/tax-rates] PATCH failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
