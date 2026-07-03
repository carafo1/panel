import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { getContainerLogs } from '@/lib/vps/deployer'

/**
 * GET /api/hosting/[id]/container/logs?tail=200&since=1h
 *
 * Returns the container's recent stdout/stderr logs via `docker logs`.
 * Query params:
 *   tail  — number of lines from the end (default 200, capped at 5000)
 *   since — relative time like "1h", "30m", "2h" passed straight to docker
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

    // ── Parse query params ──────────────────────────────────────────────
    const { searchParams } = new URL(request.url)
    const tailRaw = parseInt(searchParams.get('tail') ?? '200', 10)
    const tail =
      Number.isFinite(tailRaw) && tailRaw > 0 ? Math.min(tailRaw, 5000) : 200
    const since = searchParams.get('since') ?? undefined

    // Basic since-format validation — docker accepts e.g. "1h", "30m", "2024-01-01T00:00:00".
    // We reject anything with shell metacharacters to be safe (the deployer
    // shellQuotes it but defense in depth is cheap).
    if (since && /[;&|`$()<>]/.test(since)) {
      return NextResponse.json(
        { error: 'Invalid "since" parameter' },
        { status: 400 }
      )
    }

    const logs = await getContainerLogs(id, { tail, since })

    return NextResponse.json({
      projectId: id,
      projectName: project.name,
      containerName: project.containerName,
      tail,
      since: since ?? null,
      logs,
      fetchedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Container logs GET error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: 'Internal server error',
      },
      { status: 500 }
    )
  }
}
