import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'

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

    const decoded = verifyToken(token)
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

    // Parse pipeline stages to generate stage results
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

    // Simulate run result — randomly succeed or fail
    const overallSuccess = Math.random() > 0.3 // 70% success rate

    // Generate stage results
    const stageResults = pipelineStages.map((stage) => {
      const stageSuccess = overallSuccess ? Math.random() > 0.1 : Math.random() > 0.5
      const duration = Math.floor(Math.random() * 60) + 5 // 5-65 seconds

      const outputMessages: Record<string, string[]> = {
        build: [
          'Installing dependencies...',
          'Compiling source code...',
          'Build completed successfully.',
          'Build failed: compilation error in module.',
        ],
        test: [
          'Running unit tests...',
          'All tests passed.',
          '2 tests failed: assertion error in login flow.',
          'Test suite completed with warnings.',
        ],
        deploy: [
          'Deploying to production...',
          'Health check passed.',
          'Deployment successful.',
          'Deployment failed: connection timeout.',
        ],
        lint: [
          'Running linter...',
          'No linting errors found.',
          'Linting failed: 3 errors found.',
        ],
        security: [
          'Scanning for vulnerabilities...',
          'No critical vulnerabilities found.',
          'Security scan failed: 1 critical vulnerability.',
        ],
      }

      const messages = outputMessages[stage.type] || ['Processing...', 'Stage completed.']
      const output = stageSuccess
        ? messages.filter((_, i) => i < messages.length - 1).join('\n') || messages[0]
        : messages[messages.length - 1]

      return {
        name: stage.name,
        type: stage.type,
        status: stageSuccess ? 'success' : 'failed',
        duration,
        output,
      }
    })

    // Determine final status based on stage results
    const finalStatus = stageResults.every((s) => s.status === 'success') ? 'success' : 'failed'
    const totalDuration = stageResults.reduce((sum, s) => sum + s.duration, 0)

    // Create the run with completed status (simulated)
    const now = new Date()
    const completedAt = new Date(now.getTime() + totalDuration * 1000)

    const run = await db.pipelineRun.create({
      data: {
        pipelineId: id,
        status: finalStatus,
        trigger: trigger || 'manual',
        commit: commit || null,
        branch: branch || pipeline.triggerBranch,
        stages: JSON.stringify(stageResults),
        startedAt: now,
        completedAt,
        duration: totalDuration,
      },
    })

    // Update pipeline's last run info
    await db.pipeline.update({
      where: { id },
      data: {
        lastRunAt: now,
        lastRunStatus: finalStatus,
      },
    })

    return NextResponse.json({
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
    }, { status: 201 })
  } catch (error) {
    console.error('Trigger pipeline run error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
