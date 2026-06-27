import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'

/**
 * Admin guard — returns the decoded user or an error response.
 */
async function requireAdmin(request: Request) {
  const token = extractTokenFromHeader(request.headers.get('Authorization'))
  if (!token) {
    return { error: NextResponse.json({ error: 'Authorization token required' }, { status: 401 }) }
  }
  const decoded = verifyToken(token)
  if (!decoded) {
    return { error: NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 }) }
  }
  if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
    return { error: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) }
  }
  return { user: decoded }
}

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET /api/admin/services/[id]
 */
export async function GET(request: Request, { params }: RouteParams) {
  const guard = await requireAdmin(request)
  if ('error' in guard) return guard.error
  const { id } = await params
  try {
    const service = await db.service.findUnique({
      where: { id },
      include: { plans: { orderBy: { order: 'asc' } }, highlights: { orderBy: { order: 'asc' } }, faqs: { orderBy: { order: 'asc' } } },
    })
    if (!service) return NextResponse.json({ error: 'Service not found' }, { status: 404 })
    return NextResponse.json({ service })
  } catch (error) {
    console.error('[/api/admin/services/[id] GET] error:', error)
    return NextResponse.json({ error: 'Failed to fetch service' }, { status: 500 })
  }
}

/**
 * PATCH /api/admin/services/[id]
 * Full update of a service (including nested plans/highlights/faqs which are
 * replaced atomically). Body: same shape as POST, plus optional `order` and `visible`.
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  const guard = await requireAdmin(request)
  if ('error' in guard) return guard.error
  const user = guard.user
  const { id } = await params

  try {
    const existing = await db.service.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'Service not found' }, { status: 404 })

    const body = await request.json()
    const {
      slug, name, tagline, description, iconName, accent,
      features, visible, order, plans, highlights, faqs,
    } = body

    // If slug changed, ensure uniqueness
    if (slug && slug !== existing.slug) {
      const clash = await db.service.findUnique({ where: { slug: String(slug) } })
      if (clash && clash.id !== id) {
        return NextResponse.json({ error: 'A service with this slug already exists' }, { status: 409 })
      }
    }

    // Update the service + replace nested collections in a transaction.
    const updated = await db.$transaction(async (tx) => {
      // Delete existing nested rows (cascade-style replace)
      await tx.servicePlan.deleteMany({ where: { serviceId: id } })
      await tx.serviceHighlight.deleteMany({ where: { serviceId: id } })
      await tx.serviceFaq.deleteMany({ where: { serviceId: id } })

      return tx.service.update({
        where: { id },
        data: {
          ...(slug !== undefined && { slug: String(slug) }),
          ...(name !== undefined && { name: String(name) }),
          ...(tagline !== undefined && { tagline: String(tagline) }),
          ...(description !== undefined && { description: String(description) }),
          ...(iconName !== undefined && { iconName: String(iconName) }),
          ...(accent !== undefined && { accent: String(accent) }),
          ...(features !== undefined && { features: JSON.stringify(features) }),
          ...(visible !== undefined && { visible: Boolean(visible) }),
          ...(order !== undefined && { order: Number(order) }),
          ...(Array.isArray(plans) && {
            plans: {
              create: plans.map((p: Record<string, unknown>, i: number) => ({
                name: String(p.name ?? ''),
                price: Number(p.price ?? 0),
                period: String(p.period ?? '/mo'),
                description: String(p.description ?? ''),
                features: JSON.stringify(Array.isArray(p.features) ? p.features : []),
                popular: Boolean(p.popular ?? false),
                order: i,
              })),
            },
          }),
          ...(Array.isArray(highlights) && {
            highlights: {
              create: highlights.map((h: Record<string, unknown>, i: number) => ({
                title: String(h.title ?? ''),
                description: String(h.description ?? ''),
                iconName: String(h.iconName ?? 'LayoutGrid'),
                order: i,
              })),
            },
          }),
          ...(Array.isArray(faqs) && {
            faqs: {
              create: faqs.map((f: Record<string, unknown>, i: number) => ({
                question: String(f.q ?? f.question ?? ''),
                answer: String(f.a ?? f.answer ?? ''),
                order: i,
              })),
            },
          }),
        },
        include: { plans: true, highlights: true, faqs: true },
      })
    })

    await logAudit({
      userId: user.userId,
      action: 'cms.service.update',
      resource: 'Service',
      resourceId: id,
      metadata: { slug: updated.slug, name: updated.name },
    })

    return NextResponse.json({ service: updated })
  } catch (error) {
    console.error('[/api/admin/services/[id] PATCH] error:', error)
    return NextResponse.json({ error: 'Failed to update service' }, { status: 500 })
  }
}

/**
 * DELETE /api/admin/services/[id]
 */
export async function DELETE(request: Request, { params }: RouteParams) {
  const guard = await requireAdmin(request)
  if ('error' in guard) return guard.error
  const user = guard.user
  const { id } = await params

  try {
    const existing = await db.service.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'Service not found' }, { status: 404 })

    await db.service.delete({ where: { id } })

    await logAudit({
      userId: user.userId,
      action: 'cms.service.delete',
      resource: 'Service',
      resourceId: id,
      metadata: { slug: existing.slug, name: existing.name },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[/api/admin/services/[id] DELETE] error:', error)
    return NextResponse.json({ error: 'Failed to delete service' }, { status: 500 })
  }
}
