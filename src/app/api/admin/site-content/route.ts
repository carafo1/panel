import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getSiteContent } from '@/lib/cms'

/**
 * Admin guard.
 */
async function requireAdmin(request: Request) {
  const token = extractTokenFromHeader(request.headers.get('Authorization'))
  if (!token) {
    return { error: NextResponse.json({ error: 'Authorization token required' }, { status: 401 }) }
  }
  const decoded = await verifyTokenFresh(token)
  if (!decoded) {
    return { error: NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 }) }
  }
  if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
    return { error: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) }
  }
  return { user: decoded }
}

/**
 * GET /api/admin/site-content
 * Returns all site content key/value pairs.
 */
export async function GET(request: Request) {
  const guard = await requireAdmin(request)
  if ('error' in guard) return guard.error
  try {
    const content = await getSiteContent()
    return NextResponse.json({ content })
  } catch (error) {
    console.error('[/api/admin/site-content GET] error:', error)
    return NextResponse.json({ error: 'Failed to fetch site content' }, { status: 500 })
  }
}

/**
 * PUT /api/admin/site-content
 * Bulk upsert site content. Body: { content: { key: value, ... } }
 */
export async function PUT(request: Request) {
  const guard = await requireAdmin(request)
  if ('error' in guard) return guard.error
  const user = guard.user

  try {
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const { content } = body
    if (!content || typeof content !== 'object') {
      return NextResponse.json({ error: 'content object is required' }, { status: 400 })
    }

    const entries = Object.entries(content) as [string, string][]
    const updatedKeys: string[] = []

    for (const [key, value] of entries) {
      await db.siteContent.upsert({
        where: { key },
        update: { value: String(value), updatedBy: user.userId },
        create: { key, value: String(value), updatedBy: user.userId },
      })
      updatedKeys.push(key)
    }

    await logAudit({
      userId: user.userId,
      action: 'cms.site-content.update',
      resource: 'SiteContent',
      metadata: { keys: updatedKeys },
    })

    return NextResponse.json({ success: true, updated: updatedKeys.length })
  } catch (error) {
    console.error('[/api/admin/site-content PUT] error:', error)
    return NextResponse.json({ error: 'Failed to update site content' }, { status: 500 })
  }
}
