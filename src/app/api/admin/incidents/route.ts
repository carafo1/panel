import { NextResponse } from 'next/server'
import { requireAdminRole } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { createIncident, listIncidentsForStaff, StatusError } from '@/lib/status'

/**
 * GET  /api/admin/incidents   every incident, open first
 * POST /api/admin/incidents   { title, impact, status?, message, components[], startsAt? }
 */
export async function GET(request: Request) {
  const auth = await requireAdminRole(request)
  if (!auth) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  return NextResponse.json({ incidents: await listIncidentsForStaff() })
}

export async function POST(request: Request) {
  const auth = await requireAdminRole(request)
  if (!auth) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  try {
    const body = await request.json().catch(() => ({}))
    const inc = await createIncident(auth.userId, body)
    await logAudit({ userId: auth.userId, action: 'admin.incident.create', resource: 'incident', resourceId: inc.id, req: request, status: 'success', metadata: { title: inc.title, impact: inc.impact } })
    return NextResponse.json({ incident: { id: inc.id } }, { status: 201 })
  } catch (error) {
    if (error instanceof StatusError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error('[incidents] create failed:', error)
    return NextResponse.json({ error: 'Could not create the incident' }, { status: 500 })
  }
}
