import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdminRole } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { updateArticle, HelpError } from '@/lib/help'

/** PATCH /api/admin/help/[id] — edit.  DELETE — remove. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminRole(request)
  if (!auth) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  const { id } = await params
  try {
    const article = await updateArticle(id, auth.userId, await request.json().catch(() => ({})))
    await logAudit({ userId: auth.userId, action: 'admin.help.update', resource: 'help_article', resourceId: id, req: request, status: 'success' })
    return NextResponse.json({ article })
  } catch (error) {
    if (error instanceof HelpError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error('[help] update failed:', error)
    return NextResponse.json({ error: 'Could not save the article' }, { status: 500 })
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminRole(request)
  if (!auth) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  const { id } = await params
  const gone = await db.helpArticle.deleteMany({ where: { id } })
  if (!gone.count) return NextResponse.json({ error: 'Article not found' }, { status: 404 })
  await logAudit({ userId: auth.userId, action: 'admin.help.delete', resource: 'help_article', resourceId: id, req: request, status: 'success' })
  return NextResponse.json({ ok: true })
}
