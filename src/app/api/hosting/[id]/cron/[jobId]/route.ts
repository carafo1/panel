import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { updateCronJob, deleteCronJob, runCronJobNow } from '@/lib/vps'

/**
 * Project Cron Job Endpoint (single)
 * ===================================
 *
 *   PATCH  /api/hosting/[id]/cron/[jobId]            — update a cron job
 *              body: { expression?, command?, description?, enabled? }
 *   DELETE /api/hosting/[id]/cron/[jobId]            — delete a cron job
 *   POST   /api/hosting/[id]/cron/[jobId]?action=run — run the job immediately
 */

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, jobId } = await params
    const project = await db.project.findFirst({
      where: { id: projectId, userId: decoded.userId },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const existing = await db.cronJob.findFirst({
      where: { id: jobId, projectId },
    })
    if (!existing) {
      return NextResponse.json({ error: 'Cron job not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const patch: Record<string, unknown> = {}
    if (body?.expression !== undefined) patch.expression = body.expression
    if (body?.command !== undefined) patch.command = body.command
    if (body?.description !== undefined) patch.description = body.description
    if (body?.enabled !== undefined) patch.enabled = !!body.enabled

    const job = await updateCronJob(jobId, patch)

    await logAudit({
      userId: decoded.userId,
      action: 'project.cron.update',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { jobId, patch },
    })

    return NextResponse.json({ job })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Internal server error'
    console.error('Update cron job error:', error)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, jobId } = await params
    const project = await db.project.findFirst({
      where: { id: projectId, userId: decoded.userId },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const existing = await db.cronJob.findFirst({
      where: { id: jobId, projectId },
    })
    if (!existing) {
      return NextResponse.json({ error: 'Cron job not found' }, { status: 404 })
    }

    await deleteCronJob(jobId)

    await logAudit({
      userId: decoded.userId,
      action: 'project.cron.delete',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { jobId },
    })

    return NextResponse.json({ message: 'Cron job deleted' })
  } catch (error) {
    console.error('Delete cron job error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, jobId } = await params
    const project = await db.project.findFirst({
      where: { id: projectId, userId: decoded.userId },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const existing = await db.cronJob.findFirst({
      where: { id: jobId, projectId },
    })
    if (!existing) {
      return NextResponse.json({ error: 'Cron job not found' }, { status: 404 })
    }

    const url = new URL(request.url)
    const action = url.searchParams.get('action')
    if (action !== 'run') {
      return NextResponse.json(
        { error: 'Unknown action (expected ?action=run)' },
        { status: 400 }
      )
    }

    const result = await runCronJobNow(jobId)

    await logAudit({
      userId: decoded.userId,
      action: 'project.cron.run',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { jobId, status: result.status, exitCode: result.exitCode },
    })

    return NextResponse.json(result)
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Internal server error'
    console.error('Run cron job error:', error)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
