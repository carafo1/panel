import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { enforceLimit } from '@/lib/plan-limits'
import { isAdmin } from '@/lib/security'
import { logAudit } from '@/lib/audit'
import { provisionProjectDatabase, listProjectDatabases } from '@/lib/vps'

/**
 * Project Databases Endpoint (collection)
 * =======================================
 *
 *   GET  /api/hosting/[id]/databases              — list all DBs for the project
 *                                                   (?reveal=true to decrypt passwords)
 *   POST /api/hosting/[id]/databases              — provision a new DB container
 *                                                   body: { type?: 'mysql'|'mariadb'|'postgres', name? }
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
    const project = await db.project.findFirst({ where: isAdmin(decoded.role) ? { id: projectId } : { id: projectId, userId: decoded.userId } })
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
    const project = await db.project.findFirst({ where: isAdmin(decoded.role) ? { id: projectId } : { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Plan limit. The quota for databases was computed for the usage bar but
    // never enforced, so a customer could create them without limit while the
    // bar sat past 100%. Checked before creating anything.
    const denied = await enforceLimit(decoded.userId, 'databases', { role: decoded.role })
    if (denied) return denied

    const body = await request.json().catch(() => ({}))
    // Normalize type: accept 'mysql', 'mariadb', 'postgres', or 'postgresql'
    // (alias). Default to mariadb for back-compat with older callers.
    const rawType = typeof body?.type === 'string' ? body.type.toLowerCase() : 'mariadb'
    const type: 'mysql' | 'mariadb' | 'postgres' =
      rawType === 'mysql'
        ? 'mysql'
        : rawType === 'postgres' || rawType === 'postgresql'
          ? 'postgres'
          : 'mariadb'
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
    const msg = 'Internal server error'
    console.error('Create database error:', error)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
