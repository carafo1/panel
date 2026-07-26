import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { isAdmin } from '@/lib/security'
import { logAudit } from '@/lib/audit'
import {
  getProjectDatabase,
  dropProjectDatabase,
  testDatabaseConnection,
} from '@/lib/vps'
import { resetDatabasePassword } from '@/lib/db-engine/password'

/**
 * Project Database Endpoint (single)
 * ==================================
 *
 *   GET    /api/hosting/[id]/databases/[dbId]            — single DB details (?reveal=true for password)
 *   DELETE /api/hosting/[id]/databases/[dbId]            — drop the DB container + delete the row
 *   POST   /api/hosting/[id]/databases/[dbId]            — perform an action
 *            body: { action: 'test' }                    — test DB connectivity
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; dbId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, dbId } = await params
    const project = await db.project.findFirst({ where: isAdmin(decoded.role) ? { id: projectId } : { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const url = new URL(request.url)
    const reveal = url.searchParams.get('reveal') === 'true'
    const database = await getProjectDatabase(projectId, dbId, reveal)
    if (!database) {
      return NextResponse.json({ error: 'Database not found' }, { status: 404 })
    }
    return NextResponse.json({ database })
  } catch (error) {
    console.error('Get database error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; dbId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, dbId } = await params
    const project = await db.project.findFirst({ where: isAdmin(decoded.role) ? { id: projectId } : { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const result = await dropProjectDatabase(projectId, dbId)
    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: 400 })
    }
    await logAudit({
      userId: decoded.userId,
      action: 'project.database.drop',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { dbId },
    })
    return NextResponse.json({ message: result.message })
  } catch (error) {
    console.error('Delete database error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; dbId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, dbId } = await params
    const project = await db.project.findFirst({ where: isAdmin(decoded.role) ? { id: projectId } : { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const body = await request.json().catch(() => ({}))

    // Rotate the database user's own password. Returns the new secret ONCE;
    // it is stored encrypted and shown to the owner only in this response.
    if (body?.action === 'reset-password') {
      const reset = await resetDatabasePassword(projectId, dbId)
      await logAudit({
        userId: decoded.userId,
        action: 'project.database.password.reset',
        resource: 'project',
        resourceId: projectId,
        req: request,
        status: reset.ok ? 'success' : 'failure',
        metadata: { dbId, message: reset.message },
      })
      if (!reset.ok) {
        return NextResponse.json({ error: reset.message }, { status: 400 })
      }
      return NextResponse.json(
        { ok: true, password: reset.password, message: reset.message },
        { headers: { 'Cache-Control': 'no-store' } }
      )
    }

    if (body?.action !== 'test') {
      return NextResponse.json(
        { error: 'Unknown action (expected { action: "test" | "reset-password" })' },
        { status: 400 }
      )
    }
    const result = await testDatabaseConnection(projectId, dbId)
    await logAudit({
      userId: decoded.userId,
      action: 'project.database.test',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { dbId, ok: result.ok },
    })
    return NextResponse.json(result)
  } catch (error) {
    console.error('Test database error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
