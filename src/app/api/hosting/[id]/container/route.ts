import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { getContainerStatus } from '@/lib/vps/deployer'

/**
 * GET /api/hosting/[id]/container
 *
 * Returns the live Docker container status for a project. The caller must be
 * the project owner OR an admin/super_admin.
 *
 * Calls `getContainerStatus(projectId)` from src/lib/vps/deployer.ts, which:
 *   - in demo mode → returns a simulated status row
 *   - in real mode → SSHes in and runs `docker inspect` on the container
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
      select: { id: true, userId: true, name: true, status: true },
    })
    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    // ── Ownership check: owner OR admin/super_admin ────────────────────
    const isOwner = project.userId === decoded.userId
    const isAdmin = decoded.role === 'admin' || decoded.role === 'super_admin'
    if (!isOwner && !isAdmin) {
      return NextResponse.json(
        { error: 'You do not have access to this project' },
        { status: 403 }
      )
    }

    const status = await getContainerStatus(id)

    return NextResponse.json({
      projectId: id,
      projectName: project.name,
      projectStatus: project.status,
      container: status,
    })
  } catch (error) {
    console.error('Container status GET error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}
