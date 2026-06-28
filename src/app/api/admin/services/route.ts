import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getAllServicesForAdmin, seedServicesIfEmpty } from '@/lib/cms'

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

/**
 * GET /api/admin/services
 * List all services (including hidden) for the admin panel.
 */
export async function GET(request: Request) {
  const guard = await requireAdmin(request)
  if ('error' in guard) return guard.error
  try {
    await seedServicesIfEmpty()
    const services = await getAllServicesForAdmin()
    return NextResponse.json({ services })
  } catch (error) {
    console.error('[/api/admin/services GET] error:', error)
    return NextResponse.json({ error: 'Failed to fetch services' }, { status: 500 })
  }
}

/**
 * POST /api/admin/services
 * Create a new service. Body shape:
 *   { slug, name, tagline, description, iconName, accent, features: string[],
 *     visible?: boolean, plans?: [...], highlights?: [...], faqs?: [...] }
 */
export async function POST(request: Request) {
  const guard = await requireAdmin(request)
  if ('error' in guard) return guard.error
  const user = guard.user

  try {
    const body = await request.json()
    const {
      slug, name, tagline, description, iconName, accent,
      features, visible = true, plans = [], highlights = [], faqs = [],
    } = body

    // Validation
    if (!slug || !name || !tagline || !description || !iconName || !accent) {
      return NextResponse.json(
        { error: 'Missing required fields: slug, name, tagline, description, iconName, accent' },
        { status: 400 }
      )
    }
    if (!Array.isArray(features)) {
      return NextResponse.json({ error: 'features must be an array' }, { status: 400 })
    }

    // Uniqueness check
    const existing = await db.service.findUnique({ where: { slug: String(slug) } })
    if (existing) {
      return NextResponse.json({ error: 'A service with this slug already exists' }, { status: 409 })
    }

    // Determine order (append to end)
    const maxOrder = await db.service.aggregate({ _max: { order: true } })
    const order = (maxOrder._max.order ?? -1) + 1

    const created = await db.service.create({
      data: {
        slug: String(slug),
        name: String(name),
        tagline: String(tagline),
        description: String(description),
        iconName: String(iconName),
        accent: String(accent),
        features: JSON.stringify(features),
        order,
        visible: Boolean(visible),
        plans: {
          create: (plans as Array<Record<string, unknown>>).map((p, i) => ({
            name: String(p.name ?? ''),
            price: Number(p.price ?? 0),
            period: String(p.period ?? '/mo'),
            description: String(p.description ?? ''),
            features: JSON.stringify(Array.isArray(p.features) ? p.features : []),
            popular: Boolean(p.popular ?? false),
            order: i,
          })),
        },
        highlights: {
          create: (highlights as Array<Record<string, unknown>>).map((h, i) => ({
            title: String(h.title ?? ''),
            description: String(h.description ?? ''),
            iconName: String(h.iconName ?? 'LayoutGrid'),
            order: i,
          })),
        },
        faqs: {
          create: (faqs as Array<Record<string, unknown>>).map((f, i) => ({
            question: String(f.q ?? f.question ?? ''),
            answer: String(f.a ?? f.answer ?? ''),
            order: i,
          })),
        },
      },
      include: { plans: true, highlights: true, faqs: true },
    })

    await logAudit({
      userId: user.userId,
      action: 'cms.service.create',
      resource: 'Service',
      resourceId: created.id,
      metadata: { slug: created.slug, name: created.name },
    })

    return NextResponse.json({ service: created }, { status: 201 })
  } catch (error) {
    console.error('[/api/admin/services POST] error:', error)
    return NextResponse.json({ error: 'Failed to create service' }, { status: 500 })
  }
}
