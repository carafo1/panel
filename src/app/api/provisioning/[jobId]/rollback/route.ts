/**
 * POST /api/provisioning/[jobId]/rollback
 * =======================================
 *
 * Triggers rollback for a provisioning job — deletes mailboxes, removes the
 * Mailcow domain, stops the hosting project, and clears the DNS records
 * that were created. Only the job's owner may trigger a rollback, and only
 * when the job is in a terminal state (success / failed / partial).
 *
 * Audit: action='provisioning.rollback'.
 */
import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { rollbackProvisioning } from '@/lib/orchestration'
import { db } from '@/lib/db'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const token = extractTokenFromHeader(
      request.headers.get('authorization') || ''
    )
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const user = verifyToken(token)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { jobId } = await params
    if (!jobId) {
      return NextResponse.json(
        { error: 'jobId is required' },
        { status: 400 }
      )
    }

    // Fetch the job for ownership + state validation
    const job = await db.provisioningJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        userId: true,
        status: true,
        domainName: true,
      },
    })
    if (!job) {
      return NextResponse.json(
        { error: 'Provisioning job not found' },
        { status: 404 }
      )
    }
    if (job.userId !== user.userId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (job.status === 'rolled_back') {
      return NextResponse.json(
        { error: 'Job has already been rolled back' },
        { status: 400 }
      )
    }
    if (job.status === 'running' || job.status === 'pending') {
      return NextResponse.json(
        {
          error:
            'Cannot rollback a job that is still running. Wait for it to finish first.',
        },
        { status: 400 }
      )
    }

    const result = await rollbackProvisioning(jobId)

    await logAudit({
      userId: user.userId,
      action: 'provisioning.rollback',
      resource: 'provisioning_job',
      resourceId: jobId,
      req: request,
      metadata: {
        domainName: job.domainName,
        rolledBack: result.rolledBack,
        failed: result.failed,
      },
    })

    return NextResponse.json({
      jobId,
      status: 'rolled_back',
      rolledBack: result.rolledBack,
      failed: result.failed,
      message:
        result.failed.length === 0
          ? 'Rollback completed successfully.'
          : `Rollback completed with ${result.failed.length} warning(s).`,
    })
  } catch (error) {
    console.error('[api/provisioning/[jobId]/rollback] error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}
