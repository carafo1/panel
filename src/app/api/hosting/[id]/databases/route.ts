import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { provisionProjectDatabase, listProjectDatabases } from '@/lib/vps'

/**
 * Project Databases Endpoint (collection)
 * =======================================
 *
 *   GET  /api/hosting/[id]/databases              — list all DBs for the project
 *                                                   (?reveal=true to decrypt passwords)
 *   POST /api/hosting/[id]/databases              — provision a new DB container
 *                                                   body: { type?: 'mysql'|'mariadb', name? }
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
    const project = await db.project.findFirst({ where: { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const url = new URL(request.url)
    const reveal = url.searchParams.get('reveal') === 'true'
    const databases = await listProjectDatabases(projectId, reveal)
    return NextResponse.json({ databases })
  } catch (error) {
    console.error('List databases error:', error)
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
    const project = await db.project.findFirst({ where: { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const type = body?.type === 'mysql' ? 'mysql' : 'mariadb'
    const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : undefined

    const pdb = await provisionProjectDatabase(projectId, { type, name })

    // Audit.
    await logAudit({
      userId: decoded.userId,
      action: 'project.database.create',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { name: pdb.name, type: pdb.type, host: pdb.host },
    })

    // Return the new row with plaintext password ONCE so the user can copy it.
    return NextResponse.json(
      {
        database: {
          name: pdb.name,
          type: pdb.type,
          host: pdb.host,
          port: pdb.port,
          username: pdb.username,
          password: pdb.password, // plaintext — caller should prompt user to copy now
          externalRef: pdb.externalRef,
        },
      },
      { status: 201 }
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Internal server error'
    console.error('Create database error:', error)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
