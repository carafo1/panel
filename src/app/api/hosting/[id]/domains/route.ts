import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { isAdmin } from '@/lib/security'
import { logAudit } from '@/lib/audit'

/**
 * Project Domains Endpoint (collection)
 * =====================================
 *
 *   GET  /api/hosting/[id]/domains   — list all domains attached to the project
 *                                       (the primary `project.customDomain` plus all
 *                                       WebsiteDomain rows).
 *   POST /api/hosting/[id]/domains   — attach a new domain.
 *            body: { domain, sslEnabled?, isPrimary? }
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId } = await params
    const project = await db.project.findFirst({ where: isAdmin(decoded.role) ? { id: projectId } : { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const rows = await db.websiteDomain.findMany({
      where: { projectId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    })

    // Build the unified list. The primary is either project.customDomain
    // (legacy primary) OR any WebsiteDomain with isPrimary=true.
    const domains: Array<{
      id: string
      domain: string
      isPrimary: boolean
      sslEnabled: boolean
      sslStatus: string
      verified: boolean
      createdAt: string
    }> = []

    if (project.customDomain) {
      domains.push({
        id: 'primary',
        domain: project.customDomain,
        isPrimary: true,
        sslEnabled: project.sslEnabled,
        sslStatus: project.sslCertStatus,
        verified: true,
        createdAt: project.createdAt.toISOString(),
      })
    }
    for (const r of rows) {
      domains.push({
        id: r.id,
        domain: r.domain,
        isPrimary: r.isPrimary,
        sslEnabled: r.sslEnabled,
        sslStatus: r.sslStatus,
        verified: r.verified,
        createdAt: r.createdAt.toISOString(),
      })
    }

    return NextResponse.json({ domains })
  } catch (error) {
    console.error('List project domains error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId } = await params
    const project = await db.project.findFirst({ where: isAdmin(decoded.role) ? { id: projectId } : { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body.domain !== 'string' || !body.domain.trim()) {
      return NextResponse.json({ error: 'domain is required' }, { status: 400 })
    }
    const domain = body.domain.toLowerCase().trim()
    const sslEnabled = body.sslEnabled !== false // default true
    const isPrimary = body.isPrimary === true

    // Reject duplicates.
    const dup = await db.websiteDomain.findFirst({ where: { projectId, domain } })
    if (dup) {
      return NextResponse.json(
        { error: `Domain ${domain} is already attached to this project` },
        { status: 409 }
      )
    }
    if (project.customDomain === domain) {
      return NextResponse.json(
        { error: `${domain} is already the project's primary domain` },
        { status: 409 }
      )
    }

    // Demote any existing primary if this one is primary.
    if (isPrimary) {
      await db.websiteDomain.updateMany({
        where: { projectId, isPrimary: true },
        data: { isPrimary: false },
      })
    }

    const row = await db.websiteDomain.create({
      data: {
        projectId,
        domain,
        isPrimary,
        sslEnabled,
        sslStatus: sslEnabled ? 'pending' : 'none',
        verified: false,
      },
    })

    // If isPrimary, also update the project.customDomain for back-compat.
    if (isPrimary) {
      await db.project.update({
        where: { id: projectId },
        data: { customDomain: domain },
      })
    }

    await logAudit({
      userId: decoded.userId,
      action: 'project.domain.add',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { domain, isPrimary, sslEnabled },
    })

    return NextResponse.json(
      {
        domain: {
          id: row.id,
          domain: row.domain,
          isPrimary: row.isPrimary,
          sslEnabled: row.sslEnabled,
          sslStatus: row.sslStatus,
          verified: row.verified,
          createdAt: row.createdAt.toISOString(),
        },
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('Add project domain error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
