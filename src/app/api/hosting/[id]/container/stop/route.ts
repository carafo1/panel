import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { logAudit } from '@/lib/audit'
import { stopProject } from '@/lib/vps/deployer'

/**
 * POST /api/hosting/[id]/container/stop
 *
 * Stops the project's Docker container via `docker compose down`.
 * Auth: 'deploy' project access.
 */
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
    const access = await requireProjectAccess(decoded, id, 'deploy')
    if (!access.ok) return access.response

    const project = await db.project.findUnique({
      where: { id },
      select: { id: true, userId: true, name: true, containerName: true },
    })
    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    if (!project.containerName) {
      return NextResponse.json(
        { error: 'Project has no running container to stop' },
        { status: 409 }
      )
    }

    const result = await stopProject(id)

    await logAudit({
      userId: decoded.userId,
      action: 'project.container.stop',
      resource: 'project',
      resourceId: id,
      req: request,
      status: result.ok ? 'success' : 'failure',
      metadata: {
        name: project.name,
        containerName: project.containerName,
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
      projectId: id,
    })
  } catch (error) {
    console.error('Container stop POST error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: 'Internal server error',
      },
      { status: 500 }
    )
  }
}
