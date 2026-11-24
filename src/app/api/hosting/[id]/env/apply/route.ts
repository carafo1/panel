import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
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
    const access = await requireProjectAccess(decoded, projectId, 'configure')
    if (!access.ok) return access.response
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, lastDeployedAt: true },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Which NEXT_PUBLIC_* actually CHANGED since the last build. Read before
    // applying, because applyEnvironment moves lastDeployedAt.
    //
    // applyEnvironment reports every NEXT_PUBLIC_ variable it emitted, which is
    // the wrong thing to tell a customer: those were already compiled into the
    // bundle at the last build, and warning about them on every apply is a
    // warning nobody will read by the third time.
    const changedPublic = (
      await db.environmentVariable.findMany({
        where: {
          projectId,
          key: { startsWith: 'NEXT_PUBLIC_' },
          ...(project.lastDeployedAt ? { updatedAt: { gt: project.lastDeployedAt } } : {}),
        },
        select: { key: true },
      })
    ).map((v) => v.key)

    const result = await applyEnvironment(projectId)
    if (!result.ok) {
      // A failed apply is recorded too: it is an attempt to change what the
      // running site sees. Counts only — no keys' values.
      await logAudit({
        userId: decoded.userId,
        action: 'project.env.apply',
        resource: 'project',
        resourceId: projectId,
        req: request,
        status: 'failure',
        metadata: { needsRebuild: changedPublic.length },
      }).catch(() => {})
      return NextResponse.json({ error: result.message }, { status: 400 })
    }

    await logAudit({
      userId: decoded.userId,
      action: 'project.env.apply',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { needsRebuild: changedPublic.length },
    }).catch(() => {})

    return NextResponse.json({
      ok: true,
      message: result.message,
      // Values compiled into the browser bundle cannot change without a build,
      // so say so — but only for the ones that actually changed.
      needsRebuild: changedPublic,
    })
  } catch (err) {
    console.error('[env/apply] failed:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
