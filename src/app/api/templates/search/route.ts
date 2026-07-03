/**
 * GET /api/templates/search?q=nextjs&category=Framework&framework=nextjs&sort=popular&limit=20&page=1
 *
 * Full-text search + filters for the marketplace.
 * Only returns approved + featured templates.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const q = (searchParams.get('q') || '').trim().toLowerCase()
    const category = searchParams.get('category') || ''
    const framework = searchParams.get('framework') || ''
    const license = searchParams.get('license') || ''
    const sort = searchParams.get('sort') || 'popular'  // popular | rating | recent | name
    const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10), 100)
    const page = Math.max(parseInt(searchParams.get('page') || '1', 10), 1)
    const skip = (page - 1) * limit

    // Build where clause
    const where: Record<string, unknown> = {
      status: { in: ['approved', 'featured'] },
    }

    if (category && category !== 'All') where.category = category
    if (framework && framework !== 'All') where.framework = framework
    if (license && license !== 'All') where.license = license

    // Search query (SQLite doesn't support full-text search via Prisma, so use contains)
    if (q) {
      where.OR = [
        { name: { contains: q } },
        { description: { contains: q } },
        { tags: { contains: q } },
        { features: { contains: q } },
        { author: { contains: q } },
      ]
    }

    // Build orderBy
    let orderBy: Record<string, 'asc' | 'desc'>
    switch (sort) {
      case 'rating':  orderBy = { ratingSum: 'desc' }; break
      case 'recent':  orderBy = { createdAt: 'desc' }; break
      case 'name':    orderBy = { name: 'asc' }; break
      case 'popular':
      default:        orderBy = { installCount: 'desc' }; break
    }

    const [templates, total] = await Promise.all([
      db.template.findMany({
        where,
        orderBy,
        skip,
        take: limit,
      }),
      db.template.count({ where }),
    ])

    const serialized = templates.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      description: t.description,
      category: t.category,
      framework: t.framework,
      icon: t.icon,
      author: t.author,
      isOfficial: t.isOfficial,
      status: t.status,
      version: t.version,
      installCount: t.installCount,
      avgRating: t.ratingCount > 0 ? (t.ratingSum / t.ratingCount).toFixed(1) : null,
      ratingCount: t.ratingCount,
      demoUrl: t.demoUrl,
      repoUrl: t.repoUrl,
      license: t.license,
      features: JSON.parse(t.features),
      tags: JSON.parse(t.tags),
      previewGradient: t.previewGradient,
      createdAt: t.createdAt.toISOString(),
    }))

    return NextResponse.json({
      templates: serialized,
      total,
      page,
      pages: Math.ceil(total / limit),
      hasMore: skip + limit < total,
    })
  } catch (error) {
    console.error('[templates/search] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
