import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; runId: string }> }
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

    const { id, runId } = await params

    // Verify the caller may access the pipeline's project
    const pipeline = await db.pipeline.findUnique({
      where: { id },
    })

    if (!pipeline) {
      return NextResponse.json(
        { error: 'Pipeline not found' },
        { status: 404 }
      )
    }

    const access = await requireProjectAccess(decoded, pipeline.projectId, 'view')
    if (!access.ok) return access.response

    const run = await db.pipelineRun.findFirst({
      where: { id: runId, pipelineId: id },
    })

    if (!run) {
      return NextResponse.json(
        { error: 'Pipeline run not found' },
        { status: 404 }
      )
    }

    // Parse stage results for detailed view
    let stageResults: Array<{
      name: string
      type: string
      status: string
      duration: number
      output: string
    }> = []

    try {
      stageResults = JSON.parse(run.stages)
    } catch {
      stageResults = []
    }

    return NextResponse.json({
      run: {
        id: run.id,
        pipelineId: run.pipelineId,
        status: run.status,
        trigger: run.trigger,
        commit: run.commit,
        branch: run.branch,
        stages: run.stages,
        stageResults,
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt?.toISOString() || null,
        duration: run.duration,
        pipeline: {
          id: pipeline.id,
          name: pipeline.name,
          status: pipeline.status,
          triggerBranch: pipeline.triggerBranch,
        },
      },
    })
  } catch (error) {
    console.error('Get pipeline run error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
