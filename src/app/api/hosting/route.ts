import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { isAdmin } from '@/lib/security'
import { accessibleProjectsWhere } from '@/lib/project-access'
import { siteHostname, publicUrlOrNull } from '@/lib/site-address'

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
    // Own projects plus those shared with any team the user belongs to.
    const where: {
      AND: Array<Record<string, unknown>>
    } = {
      // Staging copies are managed from their live site's Staging tab.
      AND: [accessibleProjectsWhere(decoded.userId), { environment: 'production' }],
    }

    if (search) {
      // SQLite doesn't support mode: 'insensitive' so we use contains with
      // a case-normalized comparison. We OR across name / slug / domains /
      // framework (never the internal subdomain, which is not an address).
      where.AND.push({
        OR: [
          { name: { contains: search } },
          { slug: { contains: search } },
          { customDomain: { contains: search } },
          { websiteDomains: { some: { domain: { contains: search } } } },
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
        websiteDomains: { select: { domain: true, isPrimary: true, verified: true } },
        team: { select: { id: true, name: true } },
      },
      orderBy,
    })

    // ── Optional client-side sort by last deployed date ───────────────
    const userIsAdmin = isAdmin(decoded.role)
    let result = projects.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      description: p.description,
      framework: p.framework,
      stack: p.stack,
      status: p.status,
      subdomain: p.subdomain,
      customDomain: p.customDomain,
      // The public address: the site's real domain, or null ("No domain
      // connected"). Clients must use this, never `subdomain`.
      address: siteHostname(p),
      // A domain attached but still waiting for DNS verification.
      pendingDomain: siteHostname(p)
        ? null
        : p.websiteDomains.find((d) => !d.verified && d.isPrimary)?.domain ??
          p.websiteDomains.find((d) => !d.verified)?.domain ??
          null,
      sslEnabled: p.sslEnabled,
      autoDeploy: p.autoDeploy,
      // SECURITY: hide Docker container internals from non-admin customers.
      // These fields aid attackers if a customer account is compromised.
      ...(userIsAdmin
        ? {
            containerId: p.containerId,
            containerName: p.containerName,
            externalPort: p.externalPort,
          }
        : {}),
      sslCertStatus: p.sslCertStatus,
      lastDeployedAt: p.lastDeployedAt?.toISOString() ?? null,
      // SECURITY: hide server IP from non-admin customers — only return
      // the server name + region (cosmetic info shown in the UI).
      server: p.server
        ? {
            id: p.server.id,
            name: p.server.name,
            ...(userIsAdmin ? { ip: p.server.ip } : {}),
            region: p.server.region,
          }
        : null,
      lastDeployment: p.deployments[0]
        ? { ...p.deployments[0], deployUrl: publicUrlOrNull(p.deployments[0].deployUrl) }
        : null,
      domains: p.domains,
      // Shared projects are labelled so members can tell them from their own.
      team: p.team ? { id: p.team.id, name: p.team.name } : null,
      ownedByMe: p.userId === decoded.userId,
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
