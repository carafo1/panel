import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'

export async function GET(request: Request) {
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

    const pipelines = await db.pipeline.findMany({
      where: { userId: decoded.userId },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            slug: true,
            framework: true,
          },
        },
        runs: {
          orderBy: { startedAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      pipelines: pipelines.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        projectId: p.projectId,
        stages: p.stages,
        status: p.status,
        triggerBranch: p.triggerBranch,
        triggerEvents: p.triggerEvents,
        lastRunAt: p.lastRunAt?.toISOString() || null,
        lastRunStatus: p.lastRunStatus,
        project: p.project,
        lastRun: p.runs[0]
          ? {
              id: p.runs[0].id,
              status: p.runs[0].status,
              trigger: p.runs[0].trigger,
              startedAt: p.runs[0].startedAt.toISOString(),
              duration: p.runs[0].duration,
            }
          : null,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      })),
    })
  } catch (error) {
    console.error('List pipelines error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
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

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const { name, projectId, description, stages, triggerBranch, triggerEvents } = body

    if (!name || !projectId) {
      return NextResponse.json(
        { error: 'Name and projectId are required' },
        { status: 400 }
      )
    }

    // Verify project belongs to user
    const project = await db.project.findFirst({
      where: { id: projectId, userId: decoded.userId },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    // Validate stages is a valid JSON array
    let stagesJson: string
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
          stagesJson = stages
        } catch {
          return NextResponse.json(
            { error: 'Invalid stages JSON format' },
            { status: 400 }
          )
        }
      } else if (Array.isArray(stages)) {
        stagesJson = JSON.stringify(stages)
      } else {
        return NextResponse.json(
          { error: 'Stages must be a JSON array' },
          { status: 400 }
        )
      }
    } else {
      stagesJson = JSON.stringify([
        { name: 'Build', type: 'build', config: { command: 'npm run build' }, order: 0 },
        { name: 'Test', type: 'test', config: { command: 'npm test' }, order: 1 },
        { name: 'Deploy', type: 'deploy', config: { command: 'npm run deploy' }, order: 2 },
      ])
    }

    // Validate triggerEvents
    let triggerEventsJson: string
    if (triggerEvents) {
      if (typeof triggerEvents === 'string') {
        triggerEventsJson = triggerEvents
      } else if (Array.isArray(triggerEvents)) {
        triggerEventsJson = JSON.stringify(triggerEvents)
      } else {
        triggerEventsJson = JSON.stringify(['push'])
      }
    } else {
      triggerEventsJson = JSON.stringify(['push'])
    }

    const pipeline = await db.pipeline.create({
      data: {
        userId: decoded.userId,
        projectId,
        name,
        description: description || null,
        stages: stagesJson,
        status: 'draft',
        triggerBranch: triggerBranch || 'main',
        triggerEvents: triggerEventsJson,
      },
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
        id: pipeline.id,
        name: pipeline.name,
        description: pipeline.description,
        projectId: pipeline.projectId,
        stages: pipeline.stages,
        status: pipeline.status,
        triggerBranch: pipeline.triggerBranch,
        triggerEvents: pipeline.triggerEvents,
        project: pipeline.project,
        createdAt: pipeline.createdAt.toISOString(),
        updatedAt: pipeline.updatedAt.toISOString(),
      },
    }, { status: 201 })
  } catch (error) {
    console.error('Create pipeline error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
