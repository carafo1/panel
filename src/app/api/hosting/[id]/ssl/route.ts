import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getProjectCertInfo, forceRenew, toggleSsl } from '@/lib/vps/ssl'

/**
 * /api/hosting/[id]/ssl
 *
 * GET  — return the SSL certificate info for the project's hostname.
 * POST — body `{ action: 'renew' | 'toggle', enabled?: boolean }`
 *          - action='renew'  → forceRenew(projectId) — re-issues the cert
 *          - action='toggle' → toggleSsl(projectId, !!enabled) — enable/disable
 *
 * Auth: owner or admin/super_admin.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }
    const decoded = verifyToken(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { id } = await params
    const project = await db.project.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        name: true,
        subdomain: true,
        customDomain: true,
        sslEnabled: true,
        sslCertStatus: true,
        sslCertExpiry: true,
      },
    })
    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    const isOwner = project.userId === decoded.userId
    const isAdmin = decoded.role === 'admin' || decoded.role === 'super_admin'
    if (!isOwner && !isAdmin) {
      return NextResponse.json(
        { error: 'You do not have access to this project' },
        { status: 403 }
      )
    }

    const cert = await getProjectCertInfo(id)

    return NextResponse.json({
      projectId: id,
      projectName: project.name,
      hostname: project.customDomain || project.subdomain,
      sslEnabled: project.sslEnabled,
      sslCertStatus: project.sslCertStatus,
      sslCertExpiry: project.sslCertExpiry?.toISOString() ?? null,
      cert,
    })
  } catch (error) {
    console.error('SSL GET error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: 'Internal server error',
      },
      { status: 500 }
    )
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }
    const decoded = verifyToken(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { id } = await params
    const project = await db.project.findUnique({
      where: { id },
      select: { id: true, userId: true, name: true, subdomain: true, customDomain: true },
    })
    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    const isOwner = project.userId === decoded.userId
    const isAdmin = decoded.role === 'admin' || decoded.role === 'super_admin'
    if (!isOwner && !isAdmin) {
      return NextResponse.json(
        { error: 'You do not have access to this project' },
        { status: 403 }
      )
    }

    const body = await request.json().catch(() => ({} as Record<string, unknown>))
    const { action, enabled } = body as { action?: string; enabled?: boolean }

    if (action !== 'renew' && action !== 'toggle') {
      return NextResponse.json(
        { error: "action must be 'renew' or 'toggle'" },
        { status: 400 }
      )
    }

    let result: { ok: boolean; message: string }
    if (action === 'renew') {
      result = await forceRenew(id)
    } else {
      // toggle — require `enabled` boolean
      if (typeof enabled !== 'boolean') {
        return NextResponse.json(
          { error: 'enabled (boolean) is required when action=toggle' },
          { status: 400 }
        )
      }
      result = await toggleSsl(id, enabled)
    }

    await logAudit({
      userId: decoded.userId,
      action: `project.ssl.${action}`,
      resource: 'project',
      resourceId: id,
      req: request,
      status: result.ok ? 'success' : 'failure',
      metadata: {
        name: project.name,
        hostname: project.customDomain || project.subdomain,
        action,
        enabled: typeof enabled === 'boolean' ? enabled : undefined,
        message: result.message,
      },
    })

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.message },
        { status: 500 }
      )
    }

    return NextResponse.json({
      ok: true,
      message: result.message,
      action,
      projectId: id,
    })
  } catch (error) {
    console.error('SSL POST error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: 'Internal server error',
      },
      { status: 500 }
    )
  }
}
