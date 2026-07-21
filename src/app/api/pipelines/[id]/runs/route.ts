import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import {
  executePipelineRun,
  queuedStageResults,
  reconcileStaleRuns,
  type PipelineStageDef,
} from '@/lib/pipeline-runner'

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

    // Verify pipeline belongs to user
    const pipeline = await db.pipeline.findFirst({
      where: { id, userId: decoded.userId },
    })

    if (!pipeline) {
      return NextResponse.json(
        { error: 'Pipeline not found' },
        { status: 404 }
      )
    }

    // Rescue any runs orphaned by a restart before returning current status.
    await reconcileStaleRuns(id)

    const runs = await db.pipelineRun.findMany({
      where: { pipelineId: id },
      orderBy: { startedAt: 'desc' },
    })

    return NextResponse.json({
      runs: runs.map((r) => ({
        id: r.id,
        pipelineId: r.pipelineId,
        status: r.status,
        trigger: r.trigger,
        commit: r.commit,
        branch: r.branch,
        stages: r.stages,
        startedAt: r.startedAt.toISOString(),
        completedAt: r.completedAt?.toISOString() || null,
        duration: r.duration,
      })),
    })
  } catch (error) {
    console.error('List pipeline runs error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
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

    // Verify pipeline belongs to user
    const pipeline = await db.pipeline.findFirst({
      where: { id, userId: decoded.userId },
    })

    if (!pipeline) {
      return NextResponse.json(
        { error: 'Pipeline not found' },
        { status: 404 }
      )
    }

    if (pipeline.status !== 'active') {
      return NextResponse.json(
        { error: 'Pipeline must be active to trigger a run' },
        { status: 400 }
      )
    }

    const body = await request.json().catch(() => ({}))
    const { trigger, commit, branch } = body

    // Parse the configured stages.
    let pipelineStages: Array<{ name: string; type: string; config?: Record<string, unknown>; order: number }> = []
    try {
      pipelineStages = JSON.parse(pipeline.stages)
    } catch {
      pipelineStages = [
        { name: 'Build', type: 'build', config: { command: 'npm run build' }, order: 0 },
        { name: 'Test', type: 'test', config: { command: 'npm test' }, order: 1 },
        { name: 'Deploy', type: 'deploy', config: { command: 'npm run deploy' }, order: 2 },
      ]
    }

    // Create the run as `running`, then execute the stages in the background so
    // the request returns immediately. The client polls GET /runs for status.
    const now = new Date()
    const run = await db.pipelineRun.create({
      data: {
        pipelineId: id,
        status: 'running',
        trigger: trigger || 'manual',
        commit: commit || null,
        branch: branch || pipeline.triggerBranch,
        stages: JSON.stringify(queuedStageResults(pipelineStages as PipelineStageDef[])),
        startedAt: now,
      },
    })

    await db.pipeline.update({
      where: { id },
      data: { lastRunAt: now, lastRunStatus: 'running' },
    })

    // Fire-and-forget: runs to completion on the (long-lived) panel process and
    // updates the run row when done. Never rejects (errors captured into status).
    void executePipelineRun(
      run.id,
      id,
      pipeline.projectId,
      pipelineStages as PipelineStageDef[]
    ).catch((e) => console.error('[pipeline] run execution error', e))

    return NextResponse.json(
      {
        message: 'Pipeline run started.',
        run: {
          id: run.id,
          pipelineId: run.pipelineId,
          status: run.status,
          trigger: run.trigger,
          commit: run.commit,
          branch: run.branch,
          stages: run.stages,
          startedAt: run.startedAt.toISOString(),
          completedAt: run.completedAt?.toISOString() || null,
          duration: run.duration,
        },
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('Trigger pipeline run error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
