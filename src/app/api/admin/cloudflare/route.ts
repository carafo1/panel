import { NextResponse } from 'next/server'
import { requireAdminRole } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { cloudflareConfig, cloudflareMode, saveCloudflareSettings, clearCloudflareSettings, CloudflareError } from '@/lib/cloudflare'

/**
 * GET    /api/admin/cloudflare   connection status (never the token)
 * PUT    /api/admin/cloudflare   { token, accountId? }  verify and save (encrypted)
 * DELETE /api/admin/cloudflare   forget the saved token
 */
export async function GET(request: Request) {
  const auth = await requireAdminRole(request)
  if (!auth) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  const config = await cloudflareConfig()
  return NextResponse.json({
    mode: await cloudflareMode(),
    source: config?.source ?? null,
    accountId: config?.accountId ?? null,
    zones: await db.cdnZone.count(),
  })
}

export async function PUT(request: Request) {
  const auth = await requireAdminRole(request)
  if (!auth) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  const body = (await request.json().catch(() => ({}))) as { token?: unknown; accountId?: unknown }
  const token = typeof body.token === 'string' ? body.token.trim() : ''
  if (token.length < 20) return NextResponse.json({ error: 'Paste a Cloudflare API token.' }, { status: 400 })
  const accountId = typeof body.accountId === 'string' && body.accountId.trim() ? body.accountId.trim() : null
  try {
    const r = await saveCloudflareSettings(token, accountId, auth.userId)
    await logAudit({ userId: auth.userId, action: 'admin.cloudflare.connect', resource: 'settings', resourceId: 'cloudflare', req: request, status: 'success', metadata: { accountId: r.accountId } })
    return NextResponse.json({ ok: true, ...r })
  } catch (error) {
    if (error instanceof CloudflareError) return NextResponse.json({ error: error.message }, { status: 400 })
    console.error('[admin/cloudflare] save failed:', error)
    return NextResponse.json({ error: 'Could not save the token' }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  const auth = await requireAdminRole(request)
  if (!auth) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  await clearCloudflareSettings()
  await logAudit({ userId: auth.userId, action: 'admin.cloudflare.disconnect', resource: 'settings', resourceId: 'cloudflare', req: request, status: 'success' })
  return NextResponse.json({ ok: true })
}
