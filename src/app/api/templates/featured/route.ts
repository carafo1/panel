/**
 * GET /api/templates/featured
 * Returns featured + popular templates for the marketplace homepage.
 *
 * Query: ?limit=6
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const limit = Math.min(parseInt(searchParams.get('limit') || '6', 10), 20)

    // Featured templates (admin-curated)
    const featured = await db.template.findMany({
      where: { status: 'featured', isOfficial: true },
      orderBy: { featuredAt: 'desc' },
      take: limit,
    })

    // Popular templates (most installs in last 30 days)
    const popular = await db.template.findMany({
      where: { status: { in: ['approved', 'featured'] } },
      orderBy: [{ installCount: 'desc' }, { ratingSum: 'desc' }],
      take: limit,
    })

    // Trending (most recent + highest rated)
    const trending = await db.template.findMany({
      where: {
        status: { in: ['approved', 'featured'] },
        ratingCount: { gte: 1 },
      },
      orderBy: [{ ratingSum: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    })

    // New templates (recently approved)
    const recent = await db.template.findMany({
      where: { status: { in: ['approved', 'featured'] } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    const serialize = (t: typeof featured[0]) => ({
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
      features: JSON.parse(t.features),
      tags: JSON.parse(t.tags),
      previewGradient: t.previewGradient,
    })

    return NextResponse.json({
      featured: featured.map(serialize),
      popular: popular.map(serialize),
      trending: trending.map(serialize),
      recent: recent.map(serialize),
    })
  } catch (error) {
    console.error('[templates/featured] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
