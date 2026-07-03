import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listCronJobs, createCronJob, validateCronExpression } from '@/lib/vps'

/**
 * Project Cron Jobs Endpoint (collection)
 * ========================================
 *
 *   GET  /api/hosting/[id]/cron          — list all cron jobs for the project
 *   POST /api/hosting/[id]/cron          — create a new cron job
 *            body: { expression, command, description? }
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId } = await params
    const project = await db.project.findFirst({
      where: { id: projectId, userId: decoded.userId },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const jobs = await listCronJobs(projectId)
    return NextResponse.json({ jobs })
  } catch (error) {
    console.error('List cron jobs error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId } = await params
    const project = await db.project.findFirst({
      where: { id: projectId, userId: decoded.userId },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const expression = typeof body?.expression === 'string' ? body.expression.trim() : ''
    const command = typeof body?.command === 'string' ? body.command.trim() : ''
    const description =
      typeof body?.description === 'string' && body.description.trim()
        ? body.description.trim()
        : null

    if (!expression) {
      return NextResponse.json({ error: 'Cron expression is required' }, { status: 400 })
    }
    if (!command) {
      return NextResponse.json({ error: 'Command is required' }, { status: 400 })
    }
    const valid = validateCronExpression(expression)
    if (!valid.ok) {
      return NextResponse.json({ error: valid.message }, { status: 400 })
    }

    const job = await createCronJob(projectId, { expression, command, description })

    await logAudit({
      userId: decoded.userId,
      action: 'project.cron.create',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { jobId: job.id, expression, command },
    })

    return NextResponse.json({ job }, { status: 201 })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Internal server error'
    console.error('Create cron job error:', error)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
