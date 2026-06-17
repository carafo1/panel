/**
 * GET /api/provisioning/[jobId]/status
 * ====================================
 *
 * Fetch the current status of a provisioning job: the job record, all step
 * records (ordered), and the parsed ProvisioningResult once the pipeline
 * has completed. Used by the job-detail view's polling loop.
 *
 * Auth: only the job's owner may view it.
 */
import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { getProvisioningStatus } from '@/lib/orchestration'

export async function GET(
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

    const data = await getProvisioningStatus(jobId)

    if (!data.job) {
      return NextResponse.json(
        { error: 'Provisioning job not found' },
        { status: 404 }
      )
    }

    // Ownership check
    const jobUserId = (data.job as { userId?: string }).userId
    if (jobUserId && jobUserId !== user.userId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    return NextResponse.json(data)
  } catch (error) {
    console.error('[api/provisioning/[jobId]/status] error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
