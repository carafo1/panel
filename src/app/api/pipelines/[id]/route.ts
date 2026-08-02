import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'

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

    const pipeline = await db.pipeline.findFirst({
      where: { id, userId: decoded.userId },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            slug: true,
            framework: true,
            status: true,
          },
        },
        runs: {
          orderBy: { startedAt: 'desc' },
          take: 10,
        },
      },
    })

    if (!pipeline) {
      return NextResponse.json(
        { error: 'Pipeline not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({
      pipeline: {
        id: pipeline.id,
        name: pipeline.name,
        description: pipeline.description,
        projectId: pipeline.projectId,
        stages: pipeline.stages,
        status: pipeline.status,
        triggerBranch: pipeline.triggerBranch,
        triggerEvents: pipeline.triggerEvents,
        lastRunAt: pipeline.lastRunAt?.toISOString() || null,
        lastRunStatus: pipeline.lastRunStatus,
        project: pipeline.project,
        runs: pipeline.runs.map((r) => ({
          id: r.id,
          status: r.status,
          trigger: r.trigger,
          commit: r.commit,
          branch: r.branch,
          startedAt: r.startedAt.toISOString(),
          completedAt: r.completedAt?.toISOString() || null,
          duration: r.duration,
        })),
        createdAt: pipeline.createdAt.toISOString(),
        updatedAt: pipeline.updatedAt.toISOString(),
      },
    })
  } catch (error) {
    console.error('Get pipeline error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function PATCH(
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
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const { name, description, stages, status, triggerBranch, triggerEvents } = body

    const pipeline = await db.pipeline.findFirst({
      where: { id, userId: decoded.userId },
    })

    if (!pipeline) {
      return NextResponse.json(
        { error: 'Pipeline not found' },
        { status: 404 }
      )
    }

    const updateData: Record<string, unknown> = {}

    if (typeof name === 'string') updateData.name = name
    if (typeof description === 'string') updateData.description = description || null
    if (typeof triggerBranch === 'string') updateData.triggerBranch = triggerBranch

    // Validate status transitions
    if (typeof status === 'string') {
      const validStatuses = ['draft', 'active', 'paused']
      if (!validStatuses.includes(status)) {
        return NextResponse.json(
          { error: 'Invalid status. Must be one of: draft, active, paused' },
          { status: 400 }
        )
      }
      updateData.status = status
    }

    // Validate stages
    if (stages) {
      if (typeof stages === 'string') {
        try {
          const parsed = JSON.parse(stages)
          if (!Array.isArray(parsed)) {
            return NextResponse.json(
              { error: 'Stages must be a JSON array' },
              { status: 400 }
            )
          }
          updateData.stages = stages
        } catch {
          return NextResponse.json(
            { error: 'Invalid stages JSON format' },
            { status: 400 }
          )
        }
      } else if (Array.isArray(stages)) {
        updateData.stages = JSON.stringify(stages)
      }
    }

    // Validate triggerEvents
    if (triggerEvents) {
      if (typeof triggerEvents === 'string') {
        updateData.triggerEvents = triggerEvents
      } else if (Array.isArray(triggerEvents)) {
        updateData.triggerEvents = JSON.stringify(triggerEvents)
      }
    }

    const updated = await db.pipeline.update({
      where: { id },
      data: updateData,
      include: {
        project: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    })

    return NextResponse.json({
      pipeline: {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        projectId: updated.projectId,
        stages: updated.stages,
        status: updated.status,
        triggerBranch: updated.triggerBranch,
        triggerEvents: updated.triggerEvents,
        lastRunAt: updated.lastRunAt?.toISOString() || null,
        lastRunStatus: updated.lastRunStatus,
        project: updated.project,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
    })
  } catch (error) {
    console.error('Update pipeline error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function DELETE(
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

    const pipeline = await db.pipeline.findFirst({
      where: { id, userId: decoded.userId },
    })

    if (!pipeline) {
      return NextResponse.json(
        { error: 'Pipeline not found' },
        { status: 404 }
      )
    }

    await db.pipeline.delete({
      where: { id },
    })

    return NextResponse.json({
      message: 'Pipeline deleted successfully',
    })
  } catch (error) {
    console.error('Delete pipeline error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
