import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdminRole } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { addIncidentUpdate, StatusError } from '@/lib/status'

/**
 * POST   /api/admin/incidents/[id]   { status, message, components? }  post an update
 * DELETE /api/admin/incidents/[id]   remove an incident posted by mistake
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminRole(request)
  if (!auth) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  const { id } = await params
  try {
    const body = await request.json().catch(() => ({}))
    const result = await addIncidentUpdate(id, body)
    await logAudit({ userId: auth.userId, action: 'admin.incident.update', resource: 'incident', resourceId: id, req: request, status: 'success', metadata: { status: body.status } })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof StatusError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error('[incidents] update failed:', error)
    return NextResponse.json({ error: 'Could not post the update' }, { status: 500 })
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminRole(request)
  if (!auth) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  const { id } = await params
  const gone = await db.incident.deleteMany({ where: { id } })
  if (!gone.count) return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
  await logAudit({ userId: auth.userId, action: 'admin.incident.delete', resource: 'incident', resourceId: id, req: request, status: 'success' })
  return NextResponse.json({ ok: true })
}
