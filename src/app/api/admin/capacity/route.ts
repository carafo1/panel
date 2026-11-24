/**
 * GET /api/admin/capacity[?refresh=1]
 *
 * Per server: RAM, disk, CPU count, running containers, warnings; per site:
 * container memory, deploy-path disk use, database container memory; plus the
 * live orphan list. Read-only commands on each server, cached for 60 s
 * (`refresh=1` bypasses the cache; concurrent requests share one collection).
 *
 * Admin only (admin / super_admin, role re-read from the database).
 */
import { NextResponse } from 'next/server'
import { requireAdminRole } from '@/lib/auth'
import { getCapacityReport } from './capacity'

function denied(request: Request) {
  const hasCredentials =
    !!request.headers.get('Authorization') || !!request.headers.get('x-api-key')
  return hasCredentials
    ? NextResponse.json({ error: 'Admin access required', code: 'FORBIDDEN' }, { status: 403 })
    : NextResponse.json({ error: 'Authorization token required', code: 'UNAUTHENTICATED' }, { status: 401 })
}

export async function GET(request: Request) {
  const auth = await requireAdminRole(request)
  if (!auth) return denied(request)
  try {
    const refresh = new URL(request.url).searchParams.get('refresh') === '1'
    const { report, cached } = await getCapacityReport({ refresh })
    return NextResponse.json({ ...report, cached })
  } catch (err) {
    console.error('[admin/capacity] report failed:', err instanceof Error ? err.message : err)
    return NextResponse.json(
      { error: 'Could not build the capacity report', code: 'CAPACITY_FAILED' },
      { status: 500 }
    )
  }
}
