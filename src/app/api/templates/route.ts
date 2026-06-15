import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const category = searchParams.get('category')
    const search = searchParams.get('search')

    const where: Prisma.TemplateWhereInput = {}

    if (category && category !== 'All') {
      where.category = category
    }

    if (search && search.trim()) {
      const q = search.trim()
      where.OR = [
        { name: { contains: q } },
        { description: { contains: q } },
        { tags: { contains: q } },
        { framework: { contains: q } },
      ]
    }

    const templates = await db.template.findMany({
      where,
      orderBy: [{ stars: 'desc' }, { deployments: 'desc' }],
    })

    // Parse JSON fields for each template
    const parsed = templates.map((t) => ({
      ...t,
      features: JSON.parse(t.features),
      tags: JSON.parse(t.tags),
    }))

    return NextResponse.json({ templates: parsed })
  } catch (error) {
    console.error('Get templates error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
