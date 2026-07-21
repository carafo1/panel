import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'

/** Admin coupon management. */
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

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** GET /api/admin/coupons */
export async function GET(request: Request) {
  try {
    const auth = requireAdmin(request)
    if (!auth) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }
    const coupons = await db.coupon.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    const now = Date.now()
    return NextResponse.json({
      coupons: coupons.map((c) => ({
        ...c,
        expired: c.expiresAt ? new Date(c.expiresAt).getTime() < now : false,
        exhausted:
          c.maxRedemptions != null && c.redemptions >= c.maxRedemptions,
      })),
    })
  } catch (error) {
    console.error('[admin/coupons] GET failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/** POST /api/admin/coupons — create */
export async function POST(request: Request) {
  try {
    const auth = requireAdmin(request)
    if (!auth) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const code = String(body.code || '').trim().toUpperCase()
    if (!code) {
      return NextResponse.json({ error: 'Code is required' }, { status: 400 })
    }
    const type = String(body.type || 'percent')
    if (type !== 'percent' && type !== 'fixed') {
      return NextResponse.json(
        { error: 'type must be "percent" or "fixed"' },
        { status: 400 }
      )
    }
    const value = num(body.value)
    if (value === null || value <= 0) {
      return NextResponse.json(
        { error: 'value must be greater than 0' },
        { status: 400 }
      )
    }
    if (type === 'percent' && value > 100) {
      return NextResponse.json(
        { error: 'A percentage discount cannot exceed 100' },
        { status: 400 }
      )
    }
    if (await db.coupon.findUnique({ where: { code } })) {
      return NextResponse.json(
        { error: 'A coupon with that code already exists' },
        { status: 409 }
      )
    }

    const created = await db.coupon.create({
      data: {
        code,
        description: body.description ? String(body.description) : null,
        type,
        value,
        currency: String(body.currency || 'USD').toUpperCase(),
        planId: body.planId ? String(body.planId) : null,
        userId: body.userId ? String(body.userId) : null,
        firstPurchaseOnly: body.firstPurchaseOnly === true,
        recurring: body.recurring === true,
        minSubtotal: num(body.minSubtotal),
        maxRedemptions: num(body.maxRedemptions),
        maxPerCustomer: num(body.maxPerCustomer),
        startsAt: body.startsAt ? new Date(String(body.startsAt)) : null,
        expiresAt: body.expiresAt ? new Date(String(body.expiresAt)) : null,
        active: body.active !== false,
      },
    })

    await logAudit({
      userId: auth.decoded.userId,
      action: 'coupon.create',
      resource: 'coupon',
      resourceId: created.id,
      req: request,
      metadata: { code, type, value },
    }).catch(() => {})

    return NextResponse.json({ success: true, coupon: created })
  } catch (error) {
    console.error('[admin/coupons] POST failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/** PATCH /api/admin/coupons — { id, ...fields } ; DELETE via { id, delete: true } */
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
    const existing = await db.coupon.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Coupon not found' }, { status: 404 })
    }

    if (body.delete === true) {
      // Keep coupons that have been redeemed — deleting them would orphan the
      // discount history on paid invoices. Deactivate instead.
      if (existing.redemptions > 0) {
        await db.coupon.update({ where: { id }, data: { active: false } })
        return NextResponse.json({
          success: true,
          message: `Coupon deactivated — it has ${existing.redemptions} redemption(s), so it's kept for invoice history.`,
        })
      }
      await db.coupon.delete({ where: { id } })
      return NextResponse.json({ success: true, message: 'Coupon deleted.' })
    }

    const data: Record<string, unknown> = {}
    if (body.description !== undefined)
      data.description = body.description ? String(body.description) : null
    if (body.value !== undefined) {
      const v = num(body.value)
      if (v === null || v <= 0) {
        return NextResponse.json({ error: 'Invalid value' }, { status: 400 })
      }
      if ((body.type || existing.type) === 'percent' && v > 100) {
        return NextResponse.json(
          { error: 'A percentage discount cannot exceed 100' },
          { status: 400 }
        )
      }
      data.value = v
    }
    if (body.type !== undefined) data.type = String(body.type)
    for (const k of ['active', 'recurring', 'firstPurchaseOnly'] as const) {
      if (body[k] !== undefined) data[k] = body[k] === true
    }
    for (const k of ['minSubtotal', 'maxRedemptions', 'maxPerCustomer'] as const) {
      if (body[k] !== undefined) data[k] = num(body[k])
    }
    if (body.expiresAt !== undefined) {
      data.expiresAt = body.expiresAt ? new Date(String(body.expiresAt)) : null
    }

    const updated = await db.coupon.update({ where: { id }, data })
    await logAudit({
      userId: auth.decoded.userId,
      action: 'coupon.update',
      resource: 'coupon',
      resourceId: id,
      req: request,
      metadata: { fields: Object.keys(data) },
    }).catch(() => {})

    return NextResponse.json({ success: true, coupon: updated })
  } catch (error) {
    console.error('[admin/coupons] PATCH failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
