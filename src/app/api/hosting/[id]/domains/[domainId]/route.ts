import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { logAudit } from '@/lib/audit'
import { configureProjectProxy } from '@/lib/vps'

/**
 * Project Domain Endpoint (single)
 * ================================
 *
 *   PATCH  /api/hosting/[id]/domains/[domainId]   — update a domain
 *              body: { isPrimary?, sslEnabled?, verified? }
 *   DELETE /api/hosting/[id]/domains/[domainId]   — remove the domain
 */

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; domainId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, domainId } = await params
    const access = await requireProjectAccess(decoded, projectId, 'configure')
    if (!access.ok) return access.response
    const project = await db.project.findUnique({ where: { id: projectId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const row = await db.websiteDomain.findFirst({ where: { id: domainId, projectId } })
    if (!row) {
      return NextResponse.json({ error: 'Domain not found' }, { status: 404 })
    }

    const updateData: Record<string, unknown> = {}
    let sslChanged = false
    // SECURITY: making a domain primary writes project.customDomain, which
    // the proxy serves and requests certificates for. Only a domain whose DNS
    // ownership was proven may become primary.
    if (body.isPrimary === true && !row.verified) {
      return NextResponse.json(
        { error: 'Verify this domain before making it the primary domain.' },
        { status: 409 }
      )
    }
    if (typeof body.isPrimary === 'boolean') {
      sslChanged = true // the served hostname changes: Caddy must be updated
      updateData.isPrimary = body.isPrimary
      if (body.isPrimary) {
        // Demote other primaries.
        await db.websiteDomain.updateMany({
          where: { projectId, isPrimary: true, id: { not: domainId } },
          data: { isPrimary: false },
        })
        // Swap with project.customDomain (if it differs from this row).
        await db.project.update({
          where: { id: projectId },
          data: { customDomain: row.domain },
        })
      } else if (project.customDomain === row.domain) {
        // Demoting the current primary — clear project.customDomain.
        await db.project.update({
          where: { id: projectId },
          data: { customDomain: null },
        })
      }
    }
    if (typeof body.sslEnabled === 'boolean') {
      updateData.sslEnabled = body.sslEnabled
      updateData.sslStatus = body.sslEnabled ? 'pending' : 'none'
      sslChanged = true
    }
    // SECURITY: `verified` is deliberately NOT accepted from the request body.
    //
    // It used to be, which meant the client simply declared itself verified —
    // a PATCH of {verified: true} was the entire "verification". Combined with
    // the previously per-project uniqueness check, a customer could attach a
    // hostname belonging to someone else, self-certify it, and have it served.
    //
    // Ownership is now proven by DNS at
    // POST /api/hosting/[id]/domains/[domainId]/verify, which is the only
    // thing that may set this flag.
    if ('verified' in (body as Record<string, unknown>)) {
      return NextResponse.json(
        {
          error:
            'Verification status cannot be set directly. Use the Verify action, which checks DNS ownership.',
        },
        { status: 400 }
      )
    }

    const updated = await db.websiteDomain.update({
      where: { id: domainId },
      data: updateData,
    })

    // Reconfigure Caddy to pick up SSL / domain changes. The saved change is
    // kept either way; the response says whether the live site has it yet
    // (configureProjectProxy reports failure as ok:false, which used to be
    // ignored, so the customer saw success while Caddy was never updated).
    let applied = true
    let applyMessage: string | undefined
    if (sslChanged) {
      const r = await configureProjectProxy(projectId).catch((err: unknown) => ({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      }))
      if (!r.ok) {
        console.error('[domains] configureProjectProxy failed:', r.message)
        applied = false
        applyMessage = 'Saved, but the web server could not be updated yet. Try again in a minute.'
      }
    }

    await logAudit({
      userId: decoded.userId,
      action: 'project.domain.update',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { domainId, changes: updateData },
    })

    return NextResponse.json({
      domain: {
        id: updated.id,
        domain: updated.domain,
        isPrimary: updated.isPrimary,
        sslEnabled: updated.sslEnabled,
        sslStatus: updated.sslStatus,
        verified: updated.verified,
        createdAt: updated.createdAt.toISOString(),
      },
      applied,
      ...(applyMessage ? { message: applyMessage } : {}),
    })
  } catch (error) {
    console.error('Update project domain error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; domainId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, domainId } = await params
    const access = await requireProjectAccess(decoded, projectId, 'configure')
    if (!access.ok) return access.response
    const project = await db.project.findUnique({ where: { id: projectId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const row = await db.websiteDomain.findFirst({ where: { id: domainId, projectId } })
    if (!row) {
      return NextResponse.json({ error: 'Domain not found' }, { status: 404 })
    }

    await db.websiteDomain.delete({ where: { id: domainId } })

    // Remove the DNS zone published for this connection (it used to be left
    // behind on our nameservers). Never for a domain held with us as a
    // registered Domain: that zone serves the purchased domain too.
    if (row.zoneCreated) {
      const held = await db.domain.findFirst({
        where: { name: row.domain.toLowerCase(), status: { not: 'deleted' } },
        select: { id: true },
      })
      if (!held) {
        const { deleteZone } = await import('@/lib/dns-zones')
        await deleteZone(row.domain).catch((err: unknown) =>
          console.error('[domains] zone removal failed for', row.domain, err)
        )
      }
    }

    // If it was the primary, clear project.customDomain.
    if (row.isPrimary || project.customDomain === row.domain) {
      await db.project.update({
        where: { id: projectId },
        data: { customDomain: null },
      })
    }

    // Reconfigure Caddy to drop the removed domain.
    const proxy = await configureProjectProxy(projectId).catch((err: unknown) => ({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    }))
    if (!proxy.ok) console.error('[domains] configureProjectProxy failed:', proxy.message)

    await logAudit({
      userId: decoded.userId,
      action: 'project.domain.remove',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { domainId, domain: row.domain },
    })

    return NextResponse.json(
      proxy.ok
        ? { message: 'Domain removed', applied: true }
        : {
            message: 'Domain removed, but the web server could not be updated yet. Try again in a minute.',
            applied: false,
          }
    )
  } catch (error) {
    console.error('Delete project domain error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
