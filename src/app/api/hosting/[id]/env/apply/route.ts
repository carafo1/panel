import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { isAdmin } from '@/lib/security'
import { logAudit } from '@/lib/audit'
import { applyEnvironment } from '@/lib/vps'

/**
 * POST /api/hosting/[id]/env/apply
 *
 * Push the stored environment variables into the running container by
 * regenerating docker-compose.yml and recreating the container from the image
 * that is already built. Seconds, where a redeploy is minutes.
 */
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
    const project = await db.project.findFirst({
      where: isAdmin(decoded.role)
        ? { id: projectId }
        : { id: projectId, userId: decoded.userId },
      select: { id: true, name: true },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const result = await applyEnvironment(projectId)
    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: 400 })
    }

    await logAudit({
      userId: decoded.userId,
      action: 'project.env.apply',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { needsRebuild: result.needsRebuild.length },
    }).catch(() => {})

    return NextResponse.json({
      ok: true,
      message: result.message,
      // Values compiled into the browser bundle cannot change without a build,
      // so say so rather than let the customer think they took effect.
      needsRebuild: result.needsRebuild,
    })
  } catch (err) {
    console.error('[env/apply] failed:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
