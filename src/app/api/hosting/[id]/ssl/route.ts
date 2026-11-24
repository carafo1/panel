import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
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
 * Auth: GET needs 'view', POST needs 'configure' project access.
 *
 * Limits (POST): at most SSL_ACTIONS_PER_HOUR renew/toggle actions per website
 * per hour, counted from the audit log (so it holds across processes and
 * restarts), and no forced renewal while the certificate still has more than
 * RENEW_MIN_DAYS_LEFT days. Every renewal deletes the certificate and asks
 * Let's Encrypt for a new one; without limits one script could use up the
 * platform's weekly certificate quota for every customer.
 */
export const SSL_ACTIONS_PER_HOUR = 5
export const RENEW_MIN_DAYS_LEFT = 30
const DAY = 24 * 60 * 60 * 1000
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
    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { id } = await params
    const access = await requireProjectAccess(decoded, id, 'view')
    if (!access.ok) return access.response

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
    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { id } = await params
    const access = await requireProjectAccess(decoded, id, 'configure')
    if (!access.ok) return access.response

    const project = await db.project.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        name: true,
        subdomain: true,
        customDomain: true,
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

    const body = await request.json().catch(() => ({} as Record<string, unknown>))
    const { action, enabled } = body as { action?: string; enabled?: boolean }

    if (action !== 'renew' && action !== 'toggle') {
      return NextResponse.json(
        { error: "action must be 'renew' or 'toggle'" },
        { status: 400 }
      )
    }

    const recent = await db.auditLog.count({
      where: {
        resourceId: id,
        action: { in: ['project.ssl.renew', 'project.ssl.toggle'] },
        createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) },
      },
    })
    if (recent >= SSL_ACTIONS_PER_HOUR) {
      return NextResponse.json(
        { error: 'Too many certificate changes for this website. Please try again in an hour.' },
        { status: 429, headers: { 'Retry-After': '3600' } }
      )
    }
    if (
      action === 'renew' &&
      project.sslCertStatus === 'issued' &&
      project.sslCertExpiry &&
      project.sslCertExpiry.getTime() - Date.now() > RENEW_MIN_DAYS_LEFT * DAY
    ) {
      return NextResponse.json(
        {
          error: `The certificate is valid until ${project.sslCertExpiry.toISOString().slice(0, 10)} and renews automatically about 30 days before it expires. No renewal is needed now.`,
        },
        { status: 409 }
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
