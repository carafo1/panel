import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { processJob } from '@/lib/automation'

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

    // Check admin role (super_admin OR admin - backward compatible)
    if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }

    const { id } = await params

    const job = await db.jobQueue.findUnique({ where: { id } })

    if (!job) {
      return NextResponse.json(
        { error: 'Job not found' },
        { status: 404 }
      )
    }

    if (job.status !== 'failed') {
      return NextResponse.json(
        { error: 'Only failed jobs can be retried' },
        { status: 400 }
      )
    }

    // Reset job for retry. `attempts` goes back to 0 so the retried job gets
    // the normal maxAttempts budget (with backoff) again: left at its old
    // value, the next run already exceeded maxAttempts and a single transient
    // failure marked it failed for good. Conditional on still being 'failed',
    // so two concurrent retries cannot both re-queue it.
    const reset = await db.jobQueue.updateMany({
      where: { id, status: 'failed' },
      data: {
        status: 'queued',
        attempts: 0,
        startedAt: null,
        completedAt: null,
        error: null,
        runAt: new Date(),
      },
    })
    if (reset.count === 0) {
      return NextResponse.json(
        { error: 'Only failed jobs can be retried' },
        { status: 409 }
      )
    }

    // Process the job again
    await processJob(id)

    const updatedJob = await db.jobQueue.findUnique({ where: { id } })

    return NextResponse.json({
      message: 'Job retried',
      job: {
        id: updatedJob!.id,
        type: updatedJob!.type,
        status: updatedJob!.status,
        attempts: updatedJob!.attempts,
        error: updatedJob!.error,
        result: updatedJob!.result ? JSON.parse(updatedJob!.result) : null,
        completedAt: updatedJob!.completedAt,
      },
    })
  } catch (error) {
    console.error('Retry job error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
