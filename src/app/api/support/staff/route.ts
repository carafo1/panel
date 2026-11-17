import { NextResponse } from 'next/server'
import { listStaff, isStaff } from '@/lib/support'
import { supportViewer, unauthorized } from '@/lib/support-http'

/** GET /api/support/staff — who a ticket can be assigned to (staff only). */
export async function GET(request: Request) {
  const viewer = await supportViewer(request)
  if (!viewer) return unauthorized()
  if (!isStaff(viewer)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  return NextResponse.json({ staff: await listStaff() })
}
