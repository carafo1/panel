import { NextResponse } from 'next/server'
import { requireAdminRole } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { adminReferralOverview, saveReferralSettings, ReferralError } from '@/lib/referrals'

/** GET /api/admin/referrals — settings and recent referrals.  PUT — change settings. */
export async function GET(request: Request) {
  const auth = await requireAdminRole(request)
  if (!auth) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  return NextResponse.json(await adminReferralOverview())
}

export async function PUT(request: Request) {
  const auth = await requireAdminRole(request)
  if (!auth) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  try {
    const settings = await saveReferralSettings(await request.json().catch(() => ({})), auth.userId)
    await logAudit({ userId: auth.userId, action: 'admin.referrals.settings', resource: 'settings', resourceId: 'referrals', req: request, status: 'success', metadata: { ...settings } })
    return NextResponse.json({ settings })
  } catch (error) {
    if (error instanceof ReferralError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error('[admin/referrals] save failed:', error)
    return NextResponse.json({ error: 'Could not save' }, { status: 500 })
  }
}
