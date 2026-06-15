import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'

export async function GET(request: Request) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    // ── Parse query params: search, status, framework, sort ────────────
    const { searchParams } = new URL(request.url)
    const search = (searchParams.get('search') || '').trim().toLowerCase()
    const status = (searchParams.get('status') || 'all').toLowerCase()
    const framework = (searchParams.get('framework') || 'all').toLowerCase()
    const sort = (searchParams.get('sort') || 'created').toLowerCase()

    // Build the Prisma `where` clause
    const where: {
      userId: string
      AND: Array<Record<string, unknown>>
    } = {
      userId: decoded.userId,
      AND: [],
    }

    if (search) {
      // SQLite doesn't support mode: 'insensitive' so we use contains with
      // a case-normalized comparison. We OR across name / subdomain /
      // customDomain / framework / slug.
      where.AND.push({
        OR: [
          { name: { contains: search } },
          { slug: { contains: search } },
          { subdomain: { contains: search } },
          { customDomain: { contains: search } },
          { description: { contains: search } },
          { framework: { contains: search } },
        ],
      })
    }

    if (status && status !== 'all') {
      where.AND.push({ status })
    }

    if (framework && framework !== 'all') {
      where.AND.push({ framework })
    }

    // Build the orderBy clause
    let orderBy: Record<string, 'asc' | 'desc'> = { createdAt: 'desc' }
    if (sort === 'name') {
      orderBy = { name: 'asc' }
    } else if (sort === 'created') {
      orderBy = { createdAt: 'desc' }
    } else if (sort === 'updated') {
      orderBy = { updatedAt: 'desc' }
    } else if (sort === 'deployed') {
      // Sort by most recent deployment — we'll post-process this in JS
      // because Prisma can't easily order by a relation aggregate.
      orderBy = { createdAt: 'desc' }
    }

    const projects = await db.project.findMany({
      where,
      include: {
        server: true,
        deployments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        domains: true,
      },
      orderBy,
    })

    // ── Optional client-side sort by last deployed date ───────────────
    let result = projects.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      description: p.description,
      framework: p.framework,
      status: p.status,
      subdomain: p.subdomain,
      customDomain: p.customDomain,
      sslEnabled: p.sslEnabled,
      autoDeploy: p.autoDeploy,
      server: p.server
        ? {
            id: p.server.id,
            name: p.server.name,
            ip: p.server.ip,
            region: p.server.region,
          }
        : null,
      lastDeployment: p.deployments[0] || null,
      domains: p.domains,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }))

    if (sort === 'deployed') {
      result = result.sort((a, b) => {
        const aTime = a.lastDeployment
          ? new Date(a.lastDeployment.createdAt).getTime()
          : 0
        const bTime = b.lastDeployment
          ? new Date(b.lastDeployment.createdAt).getTime()
          : 0
        return bTime - aTime
      })
    }

    return NextResponse.json({
      projects: result,
      total: result.length,
      filters: { search, status, framework, sort },
    })
  } catch (error) {
    console.error('List hosting error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
