import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { restartProject } from '@/lib/vps/deployer'

/**
 * POST /api/hosting/[id]/container/restart
 *
 * Restarts the project's Docker container via `docker compose restart`.
 * Auth: owner or admin/super_admin.
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
      select: { id: true, userId: true, name: true, containerName: true },
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

    if (!project.containerName) {
      return NextResponse.json(
        { error: 'Project has no running container to restart' },
        { status: 409 }
      )
    }

    const result = await restartProject(id)

    await logAudit({
      userId: decoded.userId,
      action: 'project.container.restart',
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
    console.error('Container restart POST error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: 'Internal server error',
      },
      { status: 500 }
    )
  }
}
