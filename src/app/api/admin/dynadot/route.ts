import { NextResponse } from 'next/server'
import { requireAdminRole } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { withRateLimit } from '@/lib/rate-limit'
import { dynadotStatus, saveDynadotSettings, clearDynadotSettings, testDynadot, DynadotSettingsError } from '@/lib/dynadot-settings'

/**
 * GET    /api/admin/dynadot                 where the keys come from (never the keys)
 * PUT    /api/admin/dynadot                 { apiKey, secretKey? }  save (encrypted)
 * POST   /api/admin/dynadot                 { action: 'test' }  read-only check
 * DELETE /api/admin/dynadot                 forget saved keys (fall back to .env)
 */
export async function GET(request: Request) {
  const auth = await requireAdminRole(request)
  if (!auth) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  return NextResponse.json(await dynadotStatus(), { headers: { 'Cache-Control': 'no-store' } })
}

export async function PUT(request: Request) {
  const auth = await requireAdminRole(request)
  if (!auth) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  if (auth.impersonatedBy) return NextResponse.json({ error: 'Not available during support access' }, { status: 403 })
  try {
    const status = await saveDynadotSettings(await request.json().catch(() => ({})), auth.userId)
    await logAudit({ userId: auth.userId, action: 'admin.dynadot.save', resource: 'settings', resourceId: 'dynadot', req: request, status: 'success', metadata: { keyHint: status.keyHint } })
    const test = await testDynadot()
    return NextResponse.json({ ...status, test })
  } catch (error) {
    if (error instanceof DynadotSettingsError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error('[admin/dynadot] save failed:', error)
    return NextResponse.json({ error: 'Could not save the keys' }, { status: 500 })
  }
}

async function postHandler(request: Request) {
  const auth = await requireAdminRole(request)
  if (!auth) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  const body = (await request.json().catch(() => ({}))) as { action?: string }
  if (body.action !== 'test') return NextResponse.json({ error: "action must be 'test'" }, { status: 400 })
  return NextResponse.json(await testDynadot())
}

export const POST = withRateLimit(postHandler, { limit: 10, windowMs: 60_000 })

export async function DELETE(request: Request) {
  const auth = await requireAdminRole(request)
  if (!auth) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  const status = await clearDynadotSettings()
  await logAudit({ userId: auth.userId, action: 'admin.dynadot.clear', resource: 'settings', resourceId: 'dynadot', req: request, status: 'success' })
  return NextResponse.json(status)
}
