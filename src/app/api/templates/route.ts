import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'

/**
 * GET /api/templates?category=Framework&search=nextjs&sort=popular&framework=nextjs&limit=20&page=1
 *
 * Returns approved + featured templates only.
 * Pending/rejected templates are invisible to regular users.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const category = searchParams.get('category')
    const search = searchParams.get('search')
    const framework = searchParams.get('framework')
    const sort = searchParams.get('sort') || 'popular'
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 100)
    const page = Math.max(parseInt(searchParams.get('page') || '1', 10), 1)
    const skip = (page - 1) * limit

    const where: Prisma.TemplateWhereInput = {
      status: { in: ['approved', 'featured'] },
    }

    if (category && category !== 'All') where.category = category
    if (framework && framework !== 'All') where.framework = framework

    if (search && search.trim()) {
      const q = search.trim()
      where.OR = [
        { name: { contains: q } },
        { description: { contains: q } },
        { tags: { contains: q } },
        { features: { contains: q } },
        { framework: { contains: q } },
        { author: { contains: q } },
      ]
    }

    let orderBy: Prisma.TemplateOrderByWithRelationInput[]
    switch (sort) {
      case 'rating':  orderBy = [{ ratingSum: 'desc' }, { installCount: 'desc' }]; break
      case 'recent':  orderBy = [{ createdAt: 'desc' }]; break
      case 'name':    orderBy = [{ name: 'asc' }]; break
      case 'trending': orderBy = [{ ratingSum: 'desc' }, { installCount: 'desc' }, { createdAt: 'desc' }]; break
      case 'popular':
      default:        orderBy = [{ isOfficial: 'desc' }, { installCount: 'desc' }, { ratingSum: 'desc' }]; break
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

    const parsed = templates.map((t) => ({
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
      templates: parsed,
      total,
      page,
      pages: Math.ceil(total / limit),
    })
  } catch (error) {
    console.error('Get templates error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
